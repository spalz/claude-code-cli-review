// Hunk resolution — accept/reject individual or all hunks, finalize files
import * as vscode from "vscode";
import * as fs from "fs";
import * as log from "../log";
import * as state from "../state";
import { buildFinalContent, rebuildMerged } from "../review";
import { clearDecorations } from "../decorations";
import { pushUndoState } from "../undo-history";
import { clearReviewState } from "../persistence";
import { FileReview } from "../review";
import { applyContentViaEdit } from "./content-application";
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
	log.log(`ReviewManager.resolveHunk: file=${filePath}, hunkId=${hunkId}, accept=${accept}, remaining=${review.unresolvedCount}`);

	if (review.isFullyResolved) {
		await finalizeFile(mgr, filePath);
	} else {
		rebuildMerged(review as FileReview);
		const newCount = review.hunkRanges.length;
		if (mgr.currentHunkIndex >= newCount) {
			mgr.currentHunkIndex = Math.max(0, newCount - 1);
		}
		await applyContentViaEdit(mgr, filePath, review.mergedLines.join("\n"));
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
