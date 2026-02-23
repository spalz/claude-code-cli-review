// HTTP server for Claude Code hooks integration
import * as http from "http";
import * as fs from "fs";
import { execSync } from "child_process";
import * as vscode from "vscode";
import * as state from "./state";
import * as log from "./log";
import { parseBashCommand } from "./bash-file-parser";

const PORT = 27182;
let server: http.Server | null = null;
let _addFileToReview: ((filePath: string) => void) | null = null;
let _workspacePath: string | undefined;

// Before-content snapshots from PreToolUse hook
const beforeSnapshots = new Map<string, string>();

export function setAddFileHandler(fn: (filePath: string) => void): void {
	_addFileToReview = fn;
}

export function setWorkspacePath(wp: string): void {
	_workspacePath = wp;
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
					version: "8.0.0",
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
							try {
								const content = fs.readFileSync(file, "utf8");
								beforeSnapshots.set(file, content);
								log.log(`/snapshot: stored ${content.length} chars for ${file} (Bash)`);
							} catch {
								// File may not exist yet (e.g. touch new file)
							}
						}
					} else if (data.file) {
						const content = data.content
							? Buffer.from(data.content, "base64").toString("utf8")
							: "";
						beforeSnapshots.set(data.file, content);
						log.log(`/snapshot: stored ${content.length} chars for ${data.file}`);
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

function killOldServer(): void {
	try {
		const output = execSync(`lsof -ti tcp:${PORT} 2>/dev/null`, {
			encoding: "utf8",
			timeout: 3000,
		}).trim();
		if (output) {
			const pids = output
				.split("\n")
				.map((p) => p.trim())
				.filter(Boolean);
			const myPid = String(process.pid);
			for (const pid of pids) {
				if (pid !== myPid) {
					log.log(`killing old server process on port ${PORT}: PID ${pid}`);
					try {
						process.kill(Number(pid), "SIGTERM");
					} catch {}
				}
			}
		}
	} catch {}
}

export function startServer(): void {
	killOldServer();
	server = createServer();

	let retries = 0;
	const MAX_RETRIES = 5;

	function tryListen(): void {
		server!.listen(PORT, "127.0.0.1", () => {
			log.log(`server started on :${PORT}`);
		});
	}

	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			retries++;
			if (retries === 1) {
				log.log(`port ${PORT} still busy after SIGTERM, sending SIGKILL`);
				try {
					const output = execSync(`lsof -ti tcp:${PORT} 2>/dev/null`, {
						encoding: "utf8",
						timeout: 3000,
					}).trim();
					if (output) {
						for (const pid of output.split("\n")) {
							if (pid.trim() && pid.trim() !== String(process.pid)) {
								try {
									process.kill(Number(pid.trim()), "SIGKILL");
								} catch {}
							}
						}
					}
				} catch {}
				setTimeout(tryListen, 500);
			} else if (retries <= MAX_RETRIES) {
				log.log(`port ${PORT} busy, retry ${retries}/${MAX_RETRIES} in 1s...`);
				setTimeout(tryListen, 1000);
			} else {
				log.log(`port ${PORT} busy after ${MAX_RETRIES} retries, giving up.`);
			}
		}
	});

	setTimeout(tryListen, 300);
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

function json(res: http.ServerResponse, data: unknown): void {
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}
