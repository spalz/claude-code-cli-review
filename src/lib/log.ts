import * as vscode from "vscode";

let channel: vscode.OutputChannel | null = null;

export function init(): void {
	channel = vscode.window.createOutputChannel("Claude Code Review");
}

export function log(...args: unknown[]): void {
	const msg = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
	const ts = new Date().toISOString().slice(11, 23);
	const line = `[${ts}] ${msg}`;
	channel?.appendLine(line);
	console.log("[ccr]", ...args);
}

export function show(): void {
	channel?.show(true);
}
