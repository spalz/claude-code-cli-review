// Hunk resolution — accept/reject individual or all hunks, finalize files
import * as vscode from "vscode";
import * as fs from "fs";
import * as log from "../log";
import * as state from "../state";
import { buildFinalContent, rebuildMerged } from "../review";
import { applyDecorations, clearDecorations } from "../decorations";
import { pushUndoState } from "../undo-history";
import { clearReviewState } from "../persistence";
import { FileReview } from "../review";
import { applyContentViaEdit, applyTargetedHunkEdit } from "./content-application";
import type { ReviewManagerInternal } from "./types";

export async function resolveHunk(
	mgr: ReviewManagerInternal,
	filePath: string,
	hunkId: number,
	accept: boolean,
): Promise<void> {
	const review = state.activeReviews.get(filePath);
	if (!review) return;
	const hunk = review.hunks.find((h) => h.id === hunkId);
	if (!hunk || hunk.resolved) return;

	const preHunkState = review.hunks.map((h) => `${h.id}:${h.resolved ? "R" : "U"}`).join(",");
	log.log(`ReviewManager.resolveHunk: BEFORE push, hunks=[${preHunkState}], about to resolve hunkId=${hunkId}`);
	pushUndoState(filePath, review);

	hunk.resolved = true;
	hunk.accepted = accept;
	const postHunkState = review.hunks.map((h) => `${h.id}:${h.resolved ? (h.accepted ? "A" : "R") : "U"}`).join(",");
	log.log(`ReviewManager.resolveHunk: file=${filePath}, hunkId=${hunkId}, accept=${accept}, remaining=${review.unresolvedCount}, hunks=[${postHunkState}]`);

	if (review.isFullyResolved) {
		log.log(`ReviewManager.resolveHunk: all hunks resolved, finalizing ${filePath}`);
		await finalizeFile(mgr, filePath);
	} else {
		// Find the hunk range BEFORE rebuilding merged (ranges refer to current buffer)
		const resolvedRange = review.hunkRanges.find((r) => r.hunkId === hunkId);
		// Capture pre-rebuild content for buffer validation
		const preMergedContent = review.mergedLines.join("\n");
		log.log(`ReviewManager.resolveHunk: pre-rebuild mergedLines=${review.mergedLines.length}, ranges=${review.hunkRanges.length}`);
		if (resolvedRange) {
			log.log(`ReviewManager.resolveHunk: resolvedRange hunk${resolvedRange.hunkId} removed=${resolvedRange.removedStart}-${resolvedRange.removedEnd} added=${resolvedRange.addedStart}-${resolvedRange.addedEnd}`);
		}

		rebuildMerged(review as FileReview);
		const newCount = review.hunkRanges.length;
		log.log(`ReviewManager.resolveHunk: post-rebuild mergedLines=${review.mergedLines.length}, ranges=${newCount}`);
		if (mgr.currentHunkIndex >= newCount) {
			mgr.currentHunkIndex = Math.max(0, newCount - 1);
		}
		// Reveal the next unresolved hunk to prevent scroll jumping
		const nextRange = review.hunkRanges[mgr.currentHunkIndex];
		const revealLine = nextRange
			? (nextRange.removedStart < nextRange.removedEnd ? nextRange.removedStart : nextRange.addedStart)
			: undefined;

		// Try targeted edit: delete only the resolved hunk's lines (no full-buffer replace)
		let applied = false;
		const editor = vscode.window.visibleTextEditors.find(
			(e) => e.document.uri.fsPath === filePath,
		);
		// Validate buffer matches pre-rebuild content; if diverged (e.g. formatOnSave), skip targeted edit
		const bufferDiverged = editor && editor.document.getText() !== preMergedContent;
		if (bufferDiverged) {
			log.log(`resolveHunk: buffer diverged from expected pre-merge content (bufferLen=${editor!.document.getText().length}, expectedLen=${preMergedContent.length}), using full replace`);
		}
		if (!editor) {
			log.log(`resolveHunk: no visible editor for ${filePath}, will use applyContentViaEdit`);
		}
		if (resolvedRange && !bufferDiverged) {
			const deleteStart = accept ? resolvedRange.removedStart : resolvedRange.addedStart;
			const deleteEnd = accept ? resolvedRange.removedEnd : resolvedRange.addedEnd;
			log.log(`resolveHunk: targeted edit deleteStart=${deleteStart}, deleteEnd=${deleteEnd}, accept=${accept}`);
			if (deleteStart < deleteEnd) {
				applied = await applyTargetedHunkEdit(mgr, filePath, deleteStart, deleteEnd, revealLine);
				log.log(`resolveHunk: targeted edit result=${applied}`);
			} else {
				// No lines to delete (pure addition accepted / pure deletion rejected).
				log.log(`resolveHunk: no lines to delete (pure ${accept ? "addition" : "deletion"}), decorations only`);
				if (editor) applyDecorations(editor, review);
				mgr.syncState();
				mgr.refreshUI();
				applied = true;
			}
		}
		// Fallback: full-buffer replace (e.g. no editor open, or targeted edit failed)
		if (!applied) {
			log.log(`resolveHunk: using full-buffer replace fallback for ${filePath}`);
			await applyContentViaEdit(mgr, filePath, review.mergedLines.join("\n"), revealLine);
		}
	}
	mgr.scheduleSave();
}

export async function resolveAllHunks(
	mgr: ReviewManagerInternal,
	filePath: string,
	accept: boolean,
): Promise<void> {
	const review = state.activeReviews.get(filePath);
	if (!review) return;
	pushUndoState(filePath, review);
	for (const h of review.hunks) {
		if (!h.resolved) {
			h.resolved = true;
			h.accepted = accept;
		}
	}
	await finalizeFile(mgr, filePath);
	mgr.scheduleSave();
}

export async function finalizeFile(mgr: ReviewManagerInternal, filePath: string): Promise<void> {
	const review = state.activeReviews.get(filePath);
	if (!review) return;

	const changeType = review.changeType;
	const allRejected = review.hunks.every((h) => !h.accepted);
	const allAccepted = review.hunks.every((h) => h.accepted);
	log.log(`ReviewManager.finalizeFile: ${filePath}, type=${changeType}, allAccepted=${allAccepted}, allRejected=${allRejected}`);

	state.activeReviews.delete(filePath);

	if (changeType === "create" && allRejected) {
		try {
			fs.unlinkSync(filePath);
			log.log(`ReviewManager: deleted created file ${filePath}`);
		} catch {}
	} else if (changeType === "delete" && allRejected) {
		fs.writeFileSync(filePath, review.originalContent, "utf8");
		log.log(`ReviewManager: restored deleted file ${filePath}`);
	} else if (changeType === "delete" && !allRejected) {
		try {
			fs.unlinkSync(filePath);
			log.log(`ReviewManager: confirmed deletion of ${filePath}`);
		} catch {}
	} else {
		const finalContent = buildFinalContent(review);
		await applyContentViaEdit(mgr, filePath, finalContent);
	}

	const editor = vscode.window.visibleTextEditors.find(
		(e) => e.document.uri.fsPath === filePath,
	);
	if (editor) {
		clearDecorations(editor);
	}

	mgr.refreshUI();

	// Move to next unresolved file
	const next = mgr.reviewFiles.find((f) => state.activeReviews.has(f));
	if (next) {
		mgr.currentFileIndex = mgr.reviewFiles.indexOf(next);
		await mgr.openFileForReview(next);
	} else {
		vscode.window.showInformationMessage("Claude Code Review: all files reviewed.");
		mgr.reviewFiles = [];
		mgr.currentFileIndex = 0;
		clearReviewState(mgr.wp);
		mgr.syncState();
		mgr.refreshUI();
		mgr._onReviewStateChange.fire(false);
	}
}
