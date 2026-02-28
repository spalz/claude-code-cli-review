// File addition — handles adding files to review (called from PostToolUse hook)
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { log, logCat } from "../log";
import { fileLog } from "../file-logger";
import * as state from "../state";
import { getSnapshot, clearSnapshot } from "../server";
import { FileReview, buildMergedContent } from "../review";
import { computeDiff } from "../diff";
import { initHistory } from "../undo-history";
import type { ChangeType } from "../../types";
import type { ReviewManagerInternal } from "./types";

export async function addFile(mgr: ReviewManagerInternal, absFilePath: string, sessionId?: string): Promise<void> {
	fileLog.log("review", `addFile: ${absFilePath}`);

	// Reject clearly invalid paths before any file operations
	if (!absFilePath || absFilePath.endsWith("/") || absFilePath.includes("\n") || absFilePath.includes("\0")) {
		logCat("file-add", `rejecting invalid path: "${absFilePath}"`);
		return;
	}

	// Read modified content from disk
	let modifiedContent: string;
	try {
		modifiedContent = fs.readFileSync(absFilePath, "utf8");
	} catch (err) {
		logCat("file-add", `cannot read ${absFilePath}: ${(err as Error).message} — treating as deletion`);
		await handleMissingFile(mgr, absFilePath, sessionId);
		return;
	}

	// Get "before" content via fallback chain.
	// Preserve existing review's original before deleting it.
	const existingOriginal = state.activeReviews.get(absFilePath)?.originalContent;
	const originalContent = getOriginalContent(mgr, absFilePath, existingOriginal);

	if (originalContent === modifiedContent) {
		logCat("file-add", `no change: original === modified for ${absFilePath} (${originalContent.length} chars)`);
		if (state.activeReviews.has(absFilePath)) {
			state.activeReviews.delete(absFilePath);
			mgr.reviewFiles = mgr.reviewFiles.filter((f) => f !== absFilePath);
			mgr.syncState();
			mgr.refreshUI();
		}
		return;
	}

	// Determine change type
	const changeType: ChangeType = !originalContent
		? "create"
		: !modifiedContent
			? "delete"
			: "edit";

	// Remove old review — we rebuild it with fresh content
	if (state.activeReviews.has(absFilePath)) {
		state.activeReviews.delete(absFilePath);
	}

	logCat("file-add", `${absFilePath}: changeType=${changeType}, original=${originalContent.length}chars, modified=${modifiedContent.length}chars`);

	const hunks = computeDiff(originalContent, modifiedContent, absFilePath, mgr.wp);
	if (hunks.length === 0) {
		logCat("file-add", `SKIP ${absFilePath}: computeDiff returned 0 hunks (original and modified may differ only in whitespace or formatting)`);
		return;
	}

	const modLines = modifiedContent.split("\n");
	const { lines, ranges } = buildMergedContent(modLines, hunks);

	const review = new FileReview(
		absFilePath,
		originalContent,
		modifiedContent,
		hunks,
		changeType,
	);
	review.mergedLines = lines;
	review.hunkRanges = ranges;
	review.sessionId = sessionId;
	state.activeReviews.set(absFilePath, review);

	if (!mgr.reviewFiles.includes(absFilePath)) {
		mgr.reviewFiles.push(absFilePath);
	}

	// Consume the snapshot after use
	clearSnapshot(absFilePath);

	// Initialize undo history so pushUndoState works when user clicks Keep/Undo
	initHistory(absFilePath);

	// Deferred merged content: do NOT write merged to disk here.
	// Merged content is applied lazily when the user opens the file for review
	// (openFileForReview / ensureMergedContent). This prevents Claude's PreToolUse
	// hook from capturing merged content instead of the real file content.
	mgr.syncState();
	mgr.refreshUI();

	logCat("file-add", `ADDED ${absFilePath}: ${hunks.length} hunks, type=${changeType}, mergedLines=${lines.length}, ranges=${ranges.length}, session=${sessionId ?? "none"}`);
	mgr.scheduleSave();
	mgr._onReviewStateChange.fire(true);
}

export async function handleMissingFile(mgr: ReviewManagerInternal, absFilePath: string, sessionId?: string): Promise<void> {
	// Try to find original content from snapshot or existing review
	const snapshot = getSnapshot(absFilePath);
	const existingOrig = state.activeReviews.get(absFilePath)?.originalContent;
	const origContent = snapshot ?? existingOrig;

	if (origContent) {
		const source = snapshot ? "snapshot" : "existingReview";
		logCat("file-add", `handleMissingFile: ${absFilePath} — found original via ${source} (${origContent.length} chars), treating as deletion`);
		await handleDeletion(mgr, absFilePath, origContent, sessionId);
		return;
	}

	// Try git show HEAD
	try {
		const relPath = path.relative(mgr.wp, absFilePath);
		if (!relPath.startsWith("..")) {
			const gitContent = execSync(`git show HEAD:"${relPath}"`, {
				cwd: mgr.wp,
				encoding: "utf8",
				timeout: 5000,
				stdio: "pipe",
			});
			logCat("file-add", `handleMissingFile: ${absFilePath} — found via git show HEAD (${gitContent.length} chars)`);
			await handleDeletion(mgr, absFilePath, gitContent, sessionId);
			return;
		}
		logCat("file-add", `handleMissingFile: ${absFilePath} — outside workspace (relPath=${relPath}), cannot git show`);
	} catch (err) {
		logCat("file-add", `handleMissingFile: ${absFilePath} — git show HEAD failed: ${(err as Error).message}`);
	}

	logCat("file-add", `handleMissingFile: ${absFilePath} — no original found (no snapshot, no existing review, no git), skipping`);
}

export async function handleDeletion(mgr: ReviewManagerInternal, absFilePath: string, originalContent: string, sessionId?: string): Promise<void> {
	// Remove old review if present
	if (state.activeReviews.has(absFilePath)) {
		state.activeReviews.delete(absFilePath);
	}

	// Create a single hunk with all lines removed
	const origLines = originalContent.split("\n");
	const hunk: import("../../types").Hunk = {
		id: 0,
		origStart: 1,
		origCount: origLines.length,
		modStart: 1,
		modCount: 0,
		removed: origLines,
		added: [],
		resolved: false,
		accepted: false,
	};

	const review = new FileReview(absFilePath, originalContent, "", [hunk], "delete");
	review.sessionId = sessionId;
	// For delete reviews, merged content is empty (all lines removed, nothing added).
	// Hover-based approach: removed lines shown via hover, buffer stays empty.
	const { lines, ranges } = buildMergedContent([], [hunk]);
	// VS Code always reports lineCount >= 1 even for empty files, so ensure at least [""]
	review.mergedLines = lines.length === 0 ? [""] : lines;
	// For pure deletions (added=[]), add a range pointing at line 0 so hover shows removed content
	if (ranges.length === 0) {
		ranges.push({ hunkId: hunk.id, removedStart: 0, removedEnd: 0, addedStart: 0, addedEnd: 0 });
	}
	review.hunkRanges = ranges;

	state.activeReviews.set(absFilePath, review);
	if (!mgr.reviewFiles.includes(absFilePath)) {
		mgr.reviewFiles.push(absFilePath);
	}

	clearSnapshot(absFilePath);

	// Initialize undo history so pushUndoState works when user clicks Keep/Undo
	initHistory(absFilePath);

	// Deferred: do NOT write merged to disk — applied lazily on file open
	mgr.syncState();
	mgr.refreshUI();

	logCat("file-add",`ReviewManager.handleDeletion: ${absFilePath}, type=delete`);
	mgr.scheduleSave();
	mgr._onReviewStateChange.fire(true);
}

export function getOriginalContent(mgr: ReviewManagerInternal, absFilePath: string, existingOriginal?: string): string {
	// 1. Existing review's original — the TRUE original from before any Claude edits.
	if (existingOriginal !== undefined) {
		logCat("file-add", `original source: existingReview for ${absFilePath} (${existingOriginal.length} chars)`);
		return existingOriginal;
	}

	// 2. PreToolUse snapshot (file content right before Claude's edit)
	const snapshot = getSnapshot(absFilePath);
	if (snapshot !== undefined) {
		logCat("file-add", `original source: PreToolUse snapshot for ${absFilePath} (${snapshot.length} chars)`);
		return snapshot;
	}

	// 3. git show HEAD:path (only for files inside the workspace)
	try {
		const relPath = path.relative(mgr.wp, absFilePath);
		if (!relPath.startsWith("..")) {
			const content = execSync(`git show HEAD:"${relPath}"`, {
				cwd: mgr.wp,
				encoding: "utf8",
				timeout: 5000,
				stdio: "pipe",
			});
			logCat("file-add", `original source: git show HEAD for ${absFilePath} (${content.length} chars)`);
			return content;
		}
		logCat("file-add", `original source: file outside workspace (relPath=${relPath}), falling back to empty`);
	} catch (err) {
		logCat("file-add", `original source: git show HEAD failed for ${absFilePath}: ${(err as Error).message}, falling back to empty`);
	}

	// 4. Empty string (new file or external file without snapshot)
	logCat("file-add", `original source: empty string (new file) for ${absFilePath}`);
	return "";
}
