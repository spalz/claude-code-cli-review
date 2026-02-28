// HTTP server for Claude Code hooks integration
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import * as vscode from "vscode";
import * as state from "./state";
import { log, logCat } from "./log";
import { fileLog } from "./file-logger";
import { parseBashCommand } from "./bash-file-parser";

const DEFAULT_PORT = 27182;
let server: http.Server | null = null;
let serverPort = 0;
let _addFileToReview: ((filePath: string, sessionId?: string) => void) | null = null;
let _getActiveSessionId: (() => string | undefined) | null = null;
let _workspacePath: string | undefined;
let _getActiveReview: ((filePath: string) => import("../types").IFileReview | undefined) | null =
    null;
let _postWebviewMessage: ((msg: { type: string }) => void) | null = null;
let _extensionPath: string | undefined;

// Before-content snapshots from PreToolUse hook
const beforeSnapshots = new Map<string, string>();

export function setAddFileHandler(fn: (filePath: string, sessionId?: string) => void): void {
    _addFileToReview = fn;
}

export function setGetActiveSessionHandler(fn: () => string | undefined): void {
    _getActiveSessionId = fn;
}

export function setWorkspacePath(wp: string): void {
    _workspacePath = wp;
}

export function setExtensionPath(ep: string): void {
    _extensionPath = ep;
}

export function setGetActiveReviewHandler(
    fn: (filePath: string) => import("../types").IFileReview | undefined,
): void {
    _getActiveReview = fn;
}

export function setPostWebviewMessageHandler(fn: (msg: { type: string }) => void): void {
    _postWebviewMessage = fn;
}

export function getSnapshot(filePath: string): string | undefined {
    return beforeSnapshots.get(filePath);
}

export function clearSnapshot(filePath: string): void {
    beforeSnapshots.delete(filePath);
}

function createServer(): http.Server {
    return http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
        fileLog.log("server", `${req.method} ${req.url}`);
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
                    const data = JSON.parse(body) as {
                        file?: string;
                        content?: string;
                        tool?: string;
                        command?: string;
                    };
                    fileLog.log("server", `/snapshot`, {
                        tool: data.tool,
                        file: data.file,
                        command: data.command?.slice(0, 100),
                    });
                    if (data.tool === "Bash" && data.command) {
                        const changes = parseBashCommand(data.command, _workspacePath);
                        const allFiles = [...changes.deleted, ...changes.modified];
                        logCat(
                            "server",
                            `/snapshot Bash: parsed ${allFiles.length} files [${allFiles.map((f) => f.split("/").pop()).join(", ")}]`,
                        );
                        for (const file of allFiles) {
                            const review = _getActiveReview?.(file);
                            if (review) {
                                beforeSnapshots.set(file, review.modifiedContent);
                                log(
                                    `/snapshot: using review.modifiedContent for ${file} (Bash, ${review.modifiedContent.length} chars)`,
                                );
                                if (review.mergedApplied) {
                                    try {
                                        fs.writeFileSync(file, review.modifiedContent, "utf8");
                                        review.mergedApplied = false;
                                        log(
                                            `/snapshot: restored modifiedContent to disk for ${file}`,
                                        );
                                    } catch (err) {
                                        logCat(
                                            "server",
                                            `/snapshot: failed to write modifiedContent for ${file}: ${(err as Error).message}`,
                                        );
                                    }
                                }
                            } else {
                                try {
                                    const content = fs.readFileSync(file, "utf8");
                                    beforeSnapshots.set(file, content);
                                    log(
                                        `/snapshot: stored ${content.length} chars for ${file} (Bash)`,
                                    );
                                } catch (err) {
                                    logCat(
                                        "server",
                                        `/snapshot: cannot read ${file} (Bash): ${(err as Error).message} (may not exist yet)`,
                                    );
                                }
                            }
                        }
                    } else if (data.file) {
                        const review = _getActiveReview?.(data.file);
                        if (review) {
                            beforeSnapshots.set(data.file, review.modifiedContent);
                            log(
                                `/snapshot: using review.modifiedContent for ${data.file} (${review.modifiedContent.length} chars)`,
                            );
                            if (review.mergedApplied) {
                                try {
                                    fs.writeFileSync(data.file, review.modifiedContent, "utf8");
                                    review.mergedApplied = false;
                                    log(
                                        `/snapshot: restored modifiedContent to disk for ${data.file}`,
                                    );
                                } catch (err) {
                                    logCat(
                                        "server",
                                        `/snapshot: failed to write modifiedContent for ${data.file}: ${(err as Error).message}`,
                                    );
                                }
                            }
                        } else {
                            const content = data.content
                                ? Buffer.from(data.content, "base64").toString("utf8")
                                : "";
                            beforeSnapshots.set(data.file, content);
                            log(`/snapshot: stored ${content.length} chars for ${data.file}`);
                        }
                    }
                } catch (err) {
                    logCat("server", `/snapshot error: ${(err as Error).message}`);
                    json(res, { ok: false, error: (err as Error).message });
                    return;
                }
                json(res, { ok: true });
            });
            return;
        }

        // PostToolUse — hook sends {file, tool} after Edit/Write, or {tool, command} for Bash
        if (req.method === "POST" && req.url === "/changed") {
            readBody(req, (body) => {
                try {
                    const data = JSON.parse(body) as {
                        file?: string;
                        tool?: string;
                        command?: string;
                    };
                    fileLog.log("server", `/changed`, {
                        tool: data.tool,
                        file: data.file,
                        command: data.command?.slice(0, 100),
                    });

                    if (data.file && !isValidFilePath(data.file)) {
                        logCat("server", `/changed: rejecting malformed path: "${data.file}"`);
                        json(res, { ok: false, error: "malformed file path" });
                        return;
                    }

                    const activeSession = _getActiveSessionId?.();
                    if (data.tool === "Bash" && data.command) {
                        const changes = parseBashCommand(data.command, _workspacePath);
                        const allChanged = [...changes.modified, ...changes.deleted];
                        logCat(
                            "server",
                            `/changed Bash: parsed ${allChanged.length} files [${allChanged.map((f) => f.split("/").pop()).join(", ")}], session=${activeSession?.slice(0, 8) ?? "none"}`,
                        );
                        for (const file of allChanged) {
                            if (_addFileToReview) _addFileToReview(file, activeSession);
                        }
                    } else if (data.file && _addFileToReview) {
                        logCat(
                            "server",
                            `/changed: ${data.tool} → ${data.file.split("/").pop()}, session=${activeSession?.slice(0, 8) ?? "none"}`,
                        );
                        _addFileToReview(data.file, activeSession);
                    }
                } catch (err) {
                    logCat("server", `/changed error: ${(err as Error).message}`);
                    json(res, { ok: false, error: (err as Error).message });
                    return;
                }
                json(res, { ok: true });
            });
            return;
        }

        // Notification endpoint — play sound alert if enabled
        if (req.method === "POST" && req.url === "/notify") {
            readBody(req, (body) => {
                try {
                    const data = JSON.parse(body) as { title?: string; message?: string };
                    const title = data.title || "Claude Code Review";
                    const message = data.message || "Claude Code needs your attention";
                    const soundEnabled = vscode.workspace
                        .getConfiguration("claudeCodeReview")
                        .get<boolean>("soundEnabled", true);
                    log(
                        `/notify: title="${title}" message="${message}" soundEnabled=${soundEnabled}`,
                    );
                    if (soundEnabled) {
                        playNotificationSound();
                    }
                } catch (err) {
                    log(`/notify error: ${(err as Error).message}`);
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
                log(`port ${DEFAULT_PORT} busy, falling back to random port`);
                server!.removeAllListeners("listening");
                server!.listen(0, "127.0.0.1", () => {
                    const addr = server!.address() as { port: number };
                    serverPort = addr.port;
                    resolved = true;
                    log(`server started on :${serverPort} (fallback)`);
                    resolve(serverPort);
                });
            }
        });

        server.listen(DEFAULT_PORT, "127.0.0.1", () => {
            if (!resolved) {
                serverPort = DEFAULT_PORT;
                resolved = true;
                log(`server started on :${DEFAULT_PORT}`);
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

/** Play custom notification sound from media/sound.mp3 */
function playNotificationSound(): void {
    const soundFile = _extensionPath ? path.join(_extensionPath, "media", "sound.mp3") : undefined;
    if (!soundFile || !fs.existsSync(soundFile)) {
        log(`Notification sound: file not found (extensionPath=${_extensionPath})`);
        return;
    }
    if (process.platform === "darwin") {
        exec(`afplay "${soundFile}"`, (err) => {
            if (err) log(`Notification sound failed: ${err.message}`);
            else log(`Notification sound played: ${soundFile}`);
        });
    } else {
        exec(
            `paplay "${soundFile}" 2>/dev/null || mpv --no-video "${soundFile}" 2>/dev/null`,
            (err) => {
                if (err) log(`Notification sound failed: ${err.message}`);
                else log(`Notification sound played: ${soundFile}`);
            },
        );
    }
}

function isValidFilePath(p: string): boolean {
    if (!p || p.includes("\n") || p.includes("\0")) return false;
    if (p.endsWith("/")) return false;
    if (p.includes("2>/dev/null") || p.includes("2>&1") || p.includes(">/dev/null")) return false;
    return true;
}

function json(res: http.ServerResponse, data: unknown): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
}
