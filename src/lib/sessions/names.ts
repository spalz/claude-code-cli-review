// Session naming — reads and writes Claude CLI's session name storage
import * as fs from "fs";
import * as path from "path";
import { getNamesFile, getCcrNamesFile, getSessionsDir } from "./paths";

/** One-time cleanup: delete legacy ccr-session-names.json if it exists */
function cleanupLegacyFile(workspacePath: string): void {
	try {
		fs.unlinkSync(getCcrNamesFile(workspacePath));
	} catch {}
}

export function loadSessionNames(workspacePath: string): Record<string, string> {
	cleanupLegacyFile(workspacePath);
	try {
		return JSON.parse(fs.readFileSync(getNamesFile(workspacePath), "utf8")) as Record<string, string>;
	} catch {
		return {};
	}
}

/**
 * Rename a session by writing to both storage locations:
 * 1. session-names.json — used by extension for session list
 * 2. custom-title line in .jsonl — used by CLI picker (claude -r)
 */
export function saveSessionName(workspacePath: string, sessionId: string, name: string): void {
	// 1. session-names.json
	const names = loadSessionNames(workspacePath);
	names[sessionId] = name;
	fs.writeFileSync(getNamesFile(workspacePath), JSON.stringify(names, null, 2), "utf8");

	// 2. Append custom-title to .jsonl (same format CLI uses via /rename)
	const jsonlPath = path.join(getSessionsDir(workspacePath), `${sessionId}.jsonl`);
	try {
		const line = JSON.stringify({ type: "custom-title", customTitle: name, sessionId });
		fs.appendFileSync(jsonlPath, line + "\n", "utf8");
	} catch {}
}
