import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

let channel: vscode.OutputChannel | null = null;
let logStream: fs.WriteStream | null = null;

export function init(): void {
	channel = vscode.window.createOutputChannel("Claude Code Review");
}

/** Start writing logs to .claude/logs/extension.log in addition to Output Channel */
export function initFileLog(workspacePath: string): void {
	const logDir = path.join(workspacePath, ".claude", "logs");
	try {
		fs.mkdirSync(logDir, { recursive: true });
		const logPath = path.join(logDir, "extension.log");
		// Rotate if >2MB
		try {
			const stat = fs.statSync(logPath);
			if (stat.size > 2 * 1024 * 1024) {
				fs.renameSync(logPath, logPath.replace(/\.log$/, ".bak"));
			}
		} catch {}
		logStream = fs.createWriteStream(logPath, { flags: "a" });
	} catch {}
}

export function disposeFileLog(): void {
	logStream?.end();
	logStream = null;
}

function writeToFile(line: string): void {
	logStream?.write(line + "\n");
}

export function log(...args: unknown[]): void {
	const msg = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
	const ts = new Date().toISOString().slice(11, 23);
	const line = `[${ts}] ${msg}`;
	channel?.appendLine(line);
	writeToFile(line);
	console.log("[ccr]", ...args);
}

export type LogCategory =
	| "hook"
	| "server"
	| "decoration"
	| "navigation"
	| "focus"
	| "review"
	| "session"
	| "resolve"
	| "content"
	| "file-add";

export function logCat(category: LogCategory, ...args: unknown[]): void {
	const msg = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
	const ts = new Date().toISOString().slice(11, 23);
	const line = `[${ts}] [${category}] ${msg}`;
	channel?.appendLine(line);
	writeToFile(line);
	console.log(`[ccr:${category}]`, ...args);
}

export async function logTimed<T>(label: string, fn: () => Promise<T>): Promise<T> {
	const start = performance.now();
	try {
		return await fn();
	} finally {
		const ms = (performance.now() - start).toFixed(1);
		log(`${label}: ${ms}ms`);
	}
}

export function show(): void {
	channel?.show(true);
}
