// HTTP server for Claude Code hooks integration
import * as http from "http";
import * as fs from "fs";
import { execSync } from "child_process";
import * as vscode from "vscode";
import * as state from "./state";
import * as log from "./log";
import { parseBashCommand } from "./bash-file-parser";

const DEFAULT_PORT = 27182;
let server: http.Server | null = null;
let serverPort = 0;
let _addFileToReview: ((filePath: string) => void) | null = null;
let _workspacePath: string | undefined;
let _getActiveReview: ((filePath: string) => import("../types").IFileReview | undefined) | null = null;

// Before-content snapshots from PreToolUse hook
const beforeSnapshots = new Map<string, string>();

export function setAddFileHandler(fn: (filePath: string) => void): void {
	_addFileToReview = fn;
}

export function setWorkspacePath(wp: string): void {
	_workspacePath = wp;
}

export function setGetActiveReviewHandler(fn: (filePath: string) => import("../types").IFileReview | undefined): void {
	_getActiveReview = fn;
}

export function getSnapshot(filePath: string): string | undefined {
	return beforeSnapshots.get(filePath);
}

export function clearSnapshot(filePath: string): void {
	beforeSnapshots.delete(filePath);
}

function createServer(): http.Server {
	return http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
		log.log(`HTTP ${req.method} ${req.url}`);
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		if (req.method === "GET" && req.url === "/status") {
			const files = state.getReviewFiles();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					ok: true,
					version: "0.5.0",
					reviewActive: state.activeReviews.size > 0,
					filesRemaining: files.filter((f) => state.activeReviews.has(f)).length,
				}),
			);
			return;
		}

		// PreToolUse snapshot — captures file content before Claude modifies it
		if (req.method === "POST" && req.url === "/snapshot") {
			readBody(req, (body) => {
				try {
					const data = JSON.parse(body) as { file?: string; content?: string; tool?: string; command?: string };
					if (data.tool === "Bash" && data.command) {
						const changes = parseBashCommand(data.command, _workspacePath);
						const allFiles = [...changes.deleted, ...changes.modified];
						for (const file of allFiles) {
							// If file has active review, use modifiedContent (disk may have merged content)
							const review = _getActiveReview?.(file);
							if (review) {
								beforeSnapshots.set(file, review.modifiedContent);
								log.log(`/snapshot: using review.modifiedContent for ${file} (Bash, ${review.modifiedContent.length} chars)`);
								if (review.mergedApplied) {
									try {
										fs.writeFileSync(file, review.modifiedContent, "utf8");
										review.mergedApplied = false;
										log.log(`/snapshot: restored modifiedContent to disk for ${file}`);
									} catch {}
								}
							} else {
								try {
									const content = fs.readFileSync(file, "utf8");
									beforeSnapshots.set(file, content);
									log.log(`/snapshot: stored ${content.length} chars for ${file} (Bash)`);
								} catch {
									// File may not exist yet (e.g. touch new file)
								}
							}
						}
					} else if (data.file) {
						// Edit/Write: if active review exists, use modifiedContent
						// (PreToolUse hook reads from disk which may have merged content)
						const review = _getActiveReview?.(data.file);
						if (review) {
							beforeSnapshots.set(data.file, review.modifiedContent);
							log.log(`/snapshot: using review.modifiedContent for ${data.file} (${review.modifiedContent.length} chars)`);
							if (review.mergedApplied) {
								try {
									fs.writeFileSync(data.file, review.modifiedContent, "utf8");
									review.mergedApplied = false;
									log.log(`/snapshot: restored modifiedContent to disk for ${data.file}`);
								} catch {}
							}
						} else {
							const content = data.content
								? Buffer.from(data.content, "base64").toString("utf8")
								: "";
							beforeSnapshots.set(data.file, content);
							log.log(`/snapshot: stored ${content.length} chars for ${data.file}`);
						}
					}
				} catch (err) {
					log.log(`/snapshot error: ${(err as Error).message}`);
				}
				json(res, { ok: true });
			});
			return;
		}

		// PostToolUse — hook sends {file, tool} after Edit/Write, or {tool, command} for Bash
		if (req.method === "POST" && req.url === "/changed") {
			readBody(req, (body) => {
				try {
					const data = JSON.parse(body) as { file?: string; tool?: string; command?: string };
					log.log(`/changed: tool=${data.tool}, file=${data.file}`);
					if (data.tool === "Bash" && data.command) {
						const changes = parseBashCommand(data.command, _workspacePath);
						for (const file of [...changes.modified, ...changes.deleted]) {
							if (_addFileToReview) _addFileToReview(file);
						}
					} else if (data.file && _addFileToReview) {
						_addFileToReview(data.file);
					}
				} catch (err) {
					log.log(`/changed error: ${(err as Error).message}`);
				}
				json(res, { ok: true });
			});
			return;
		}

		// Notification endpoint — show OS notification only when editor is unfocused
		if (req.method === "POST" && req.url === "/notify") {
			readBody(req, (body) => {
				try {
					const data = JSON.parse(body) as { title?: string; message?: string };
					const title = data.title || "Claude Code Review";
					const message = data.message || "Claude Code needs your attention";
					log.log(`/notify: title="${title}" message="${message}" focused=${vscode.window.state.focused}`);
					const notifEnabled = vscode.workspace
						.getConfiguration("claudeCodeReview")
						.get<boolean>("osNotifications", true);
					if (notifEnabled && !vscode.window.state.focused) {
						sendOsNotification(title, message);
					}
				} catch (err) {
					log.log(`/notify error: ${(err as Error).message}`);
				}
				json(res, { ok: true });
			});
			return;
		}

		// Legacy endpoint
		if (req.method === "POST" && req.url === "/review") {
			readBody(req, () => {
				vscode.commands.executeCommand("ccr.openReview");
				json(res, { ok: true });
			});
			return;
		}

		res.writeHead(404);
		res.end("Not found");
	});
}

export function getServerPort(): number {
	return serverPort;
}

export function startServer(): Promise<number> {
	return new Promise((resolve) => {
		server = createServer();
		let resolved = false;

		server.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "EADDRINUSE" && !resolved) {
				log.log(`port ${DEFAULT_PORT} busy, falling back to random port`);
				server!.removeAllListeners("listening");
				server!.listen(0, "127.0.0.1", () => {
					const addr = server!.address() as { port: number };
					serverPort = addr.port;
					resolved = true;
					log.log(`server started on :${serverPort} (fallback)`);
					resolve(serverPort);
				});
			}
		});

		server.listen(DEFAULT_PORT, "127.0.0.1", () => {
			if (!resolved) {
				serverPort = DEFAULT_PORT;
				resolved = true;
				log.log(`server started on :${DEFAULT_PORT}`);
				resolve(DEFAULT_PORT);
			}
		});
	});
}

export function stopServer(): void {
	server?.close();
	server = null;
}

function readBody(req: http.IncomingMessage, cb: (body: string) => void): void {
	let body = "";
	req.on("data", (c: Buffer) => (body += c));
	req.on("end", () => cb(body));
}

function sendOsNotification(title: string, message: string): void {
	try {
		if (process.platform === "darwin") {
			execSync(`osascript -e 'display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"'`, { timeout: 5000 });
		} else {
			execSync(`notify-send "${title.replace(/"/g, '\\"')}" "${message.replace(/"/g, '\\"')}"`, { timeout: 5000 });
		}
		log.log(`OS notification sent: "${title}"`);
	} catch (err) {
		log.log(`OS notification failed: ${(err as Error).message}`);
	}
}

function json(res: http.ServerResponse, data: unknown): void {
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}
