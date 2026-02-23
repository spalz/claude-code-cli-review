// File addition — handles adding files to review (called from PostToolUse hook)
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as log from "../log";
import * as state from "../state";
import { getSnapshot, clearSnapshot } from "../server";
import { FileReview, buildMergedContent } from "../review";
import { computeDiff } from "../diff";
import type { ChangeType } from "../../types";
import type { ReviewManagerInternal } from "./types";

export function addFile(mgr: ReviewManagerInternal, absFilePath: string): void {
	log.log(`ReviewManager.addFile: ${absFilePath}`);

	// Read modified content from disk
	let modifiedContent: string;
	try {
		modifiedContent = fs.readFileSync(absFilePath, "utf8");
	} catch {
		// File doesn't exist — possibly deleted via Bash rm
		handleMissingFile(mgr, absFilePath);
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

	log.log(
		`ReviewManager.addFile: added ${absFilePath}, ${hunks.length} hunks, type=${changeType}`,
	);
	mgr.syncState();
	mgr.refreshUI();
	mgr.scheduleSave();
	mgr._onReviewStateChange.fire(true);
}

export function handleMissingFile(mgr: ReviewManagerInternal, absFilePath: string): void {
	// Try to find original content from snapshot or existing review
	const snapshot = getSnapshot(absFilePath);
	const existingOrig = state.activeReviews.get(absFilePath)?.originalContent;
	const origContent = snapshot ?? existingOrig;

	if (origContent) {
		handleDeletion(mgr, absFilePath, origContent);
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
			handleDeletion(mgr, absFilePath, gitContent);
			return;
		}
	} catch {}

	log.log(`ReviewManager.addFile: cannot read ${absFilePath}`);
}

export function handleDeletion(mgr: ReviewManagerInternal, absFilePath: string, originalContent: string): void {
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
	// For delete reviews, merged content shows all lines as removed
	const { lines, ranges } = buildMergedContent([], [hunk]);
	review.mergedLines = lines;
	review.hunkRanges = ranges;

	state.activeReviews.set(absFilePath, review);
	if (!mgr.reviewFiles.includes(absFilePath)) {
		mgr.reviewFiles.push(absFilePath);
	}

	clearSnapshot(absFilePath);
	log.log(`ReviewManager.handleDeletion: ${absFilePath}, type=delete`);
	mgr.syncState();
	mgr.refreshUI();
	mgr.scheduleSave();
	mgr._onReviewStateChange.fire(true);
}

export function getOriginalContent(mgr: ReviewManagerInternal, absFilePath: string, existingOriginal?: string): string {
	// 1. PreToolUse snapshot (most accurate — file content right before Claude's edit)
	const snapshot = getSnapshot(absFilePath);
	if (snapshot !== undefined) {
		log.log(`ReviewManager: using PreToolUse snapshot for ${absFilePath}`);
		return snapshot;
	}

	// 2. Existing review's original (preserved from earlier addFile call)
	if (existingOriginal !== undefined) {
		log.log(`ReviewManager: using existing review original for ${absFilePath}`);
		return existingOriginal;
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
