// File addition — handles adding files to review (called from PostToolUse hook)
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as log from "../log";
import { fileLog } from "../file-logger";
import * as state from "../state";
import { getSnapshot, clearSnapshot } from "../server";
import { FileReview, buildMergedContent } from "../review";
import { computeDiff } from "../diff";
import { initHistory } from "../undo-history";
import type { ChangeType } from "../../types";
import type { ReviewManagerInternal } from "./types";

export async function addFile(mgr: ReviewManagerInternal, absFilePath: string): Promise<void> {
	fileLog.log("review", `addFile: ${absFilePath}`);

	// Read modified content from disk
	let modifiedContent: string;
	try {
		modifiedContent = fs.readFileSync(absFilePath, "utf8");
	} catch {
		// File doesn't exist — possibly deleted via Bash rm
		await handleMissingFile(mgr, absFilePath);
		return;
	}

	// Get "before" content via fallback chain.
	// Preserve existing review's original before deleting it.
	const existingOriginal = state.activeReviews.get(absFilePath)?.originalContent;
	const originalContent = getOriginalContent(mgr, absFilePath, existingOriginal);

	if (originalContent === modifiedContent) {
		// No actual change — remove from review if present
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

	const hunks = computeDiff(originalContent, modifiedContent, absFilePath, mgr.wp);
	if (hunks.length === 0) {
		log.log(`ReviewManager.addFile: no reviewable hunks in ${absFilePath}`);
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

	log.log(
		`ReviewManager.addFile: added ${absFilePath}, ${hunks.length} hunks, type=${changeType}`,
	);
	mgr.scheduleSave();
	mgr._onReviewStateChange.fire(true);
}

export async function handleMissingFile(mgr: ReviewManagerInternal, absFilePath: string): Promise<void> {
	// Try to find original content from snapshot or existing review
	const snapshot = getSnapshot(absFilePath);
	const existingOrig = state.activeReviews.get(absFilePath)?.originalContent;
	const origContent = snapshot ?? existingOrig;

	if (origContent) {
		await handleDeletion(mgr, absFilePath, origContent);
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
			await handleDeletion(mgr, absFilePath, gitContent);
			return;
		}
	} catch {}

	log.log(`ReviewManager.addFile: cannot read ${absFilePath}`);
}

export async function handleDeletion(mgr: ReviewManagerInternal, absFilePath: string, originalContent: string): Promise<void> {
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

	log.log(`ReviewManager.handleDeletion: ${absFilePath}, type=delete`);
	mgr.scheduleSave();
	mgr._onReviewStateChange.fire(true);
}

export function getOriginalContent(mgr: ReviewManagerInternal, absFilePath: string, existingOriginal?: string): string {
	// 1. Existing review's original — the TRUE original from before any Claude edits.
	// This takes priority because snapshots may contain merged content when
	// mergedApplied is true (PreToolUse hook reads from disk which has merged content).
	if (existingOriginal !== undefined) {
		log.log(`ReviewManager: using existing review original for ${absFilePath}`);
		return existingOriginal;
	}

	// 2. PreToolUse snapshot (file content right before Claude's edit — only used for first edit)
	const snapshot = getSnapshot(absFilePath);
	if (snapshot !== undefined) {
		log.log(`ReviewManager: using PreToolUse snapshot for ${absFilePath}`);
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
			return content;
		}
	} catch {}

	// 4. Empty string (new file or external file without snapshot)
	return "";
}
