// Diff computation and unified diff parsing
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { Hunk } from "../types";

export function computeDiff(
	originalContent: string,
	modifiedContent: string,
	_filePath: string,
	_workspacePath: string,
): Hunk[] {
	// New file creation: no original content, everything is added
	if (!originalContent && modifiedContent) {
		const lines = modifiedContent.split("\n");
		return [
			{
				id: 0,
				origStart: 1,
				origCount: 0,
				modStart: 1,
				modCount: lines.length,
				removed: [],
				added: lines,
				resolved: false,
				accepted: false,
			},
		];
	}

	// Always use diffTempFiles with the provided content (from snapshot or git show HEAD).
	// This is more accurate than `git diff HEAD` which:
	// 1. Includes prior uncommitted changes (not just Claude's edit)
	// 2. Produces trailing-newline artifacts when file's final \n changes
	const diffOutput = diffTempFiles(originalContent, modifiedContent);
	if (!diffOutput) return [];
	return parseUnifiedDiff(diffOutput);
}

function diffTempFiles(original: string, modified: string): string {
	// Normalize trailing newlines so the last unchanged line isn't treated as changed
	const normOrig = original && !original.endsWith("\n") ? original + "\n" : original;
	const normMod = modified && !modified.endsWith("\n") ? modified + "\n" : modified;

	const tmpOrig = path.join(os.tmpdir(), `dp-orig-${Date.now()}`);
	const tmpMod = path.join(os.tmpdir(), `dp-mod-${Date.now()}`);
	try {
		fs.writeFileSync(tmpOrig, normOrig, "utf8");
		fs.writeFileSync(tmpMod, normMod, "utf8");
		try {
			return execSync(`git diff --no-index -- "${tmpOrig}" "${tmpMod}"`, {
				encoding: "utf8",
				timeout: 5000,
				stdio: "pipe",
			});
		} catch (e) {
			return (e as { stdout?: string })?.stdout ?? "";
		}
	} catch {
		return "";
	} finally {
		try {
			fs.unlinkSync(tmpOrig);
		} catch {}
		try {
			fs.unlinkSync(tmpMod);
		} catch {}
	}
}

export function parseUnifiedDiff(diffText: string): Hunk[] {
	const hunks: Hunk[] = [];
	const lines = diffText.split("\n");
	let i = 0;
	let hunkId = 0;

	while (i < lines.length && !lines[i].startsWith("@@")) i++;

	while (i < lines.length) {
		if (!lines[i].startsWith("@@")) {
			i++;
			continue;
		}
		const m = lines[i].match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
		if (!m) {
			i++;
			continue;
		}

		let origPos = parseInt(m[1]);
		let modPos = parseInt(m[3]);
		i++;

		let removed: string[] = [];
		let added: string[] = [];
		let subOrigStart = origPos;
		let subModStart = modPos;
		let hadContext = false;

		while (i < lines.length && !lines[i].startsWith("@@")) {
			const line = lines[i];
			if (line.startsWith("-") || line.startsWith("+")) {
				// Flush accumulated sub-hunk when context separated changes
				if (hadContext && (removed.length || added.length)) {
					hunks.push(makeHunk(hunkId++, subOrigStart, subModStart, removed, added));
					removed = [];
					added = [];
					hadContext = false;
				}
				// Mark start position for new sub-hunk
				if (removed.length === 0 && added.length === 0) {
					subOrigStart = origPos;
					subModStart = modPos;
				}
				if (line.startsWith("-")) {
					removed.push(line.slice(1));
					origPos++;
				} else {
					added.push(line.slice(1));
					modPos++;
				}
				hadContext = false;
			} else if (line.startsWith(" ") || line === "") {
				if (removed.length || added.length) hadContext = true;
				origPos++;
				modPos++;
			}
			i++;
		}

		if (removed.length || added.length) {
			hunks.push(makeHunk(hunkId++, subOrigStart, subModStart, removed, added));
		}
	}

	return hunks;
}

function makeHunk(
	id: number,
	origStart: number,
	modStart: number,
	removed: string[],
	added: string[],
): Hunk {
	return {
		id,
		origStart,
		origCount: removed.length,
		modStart,
		modCount: added.length,
		removed: [...removed],
		added: [...added],
		resolved: false,
		accepted: false,
	};
}
