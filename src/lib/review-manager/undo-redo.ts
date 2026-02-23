// Undo/Redo — manages undo and redo for hunk resolution
import * as vscode from "vscode";
import * as log from "../log";
import * as state from "../state";
import { applyDecorations } from "../decorations";
import { popUndoState, pushRedoState, popRedoState, pushUndoState } from "../undo-history";
import { FileReview } from "../review";
import { applyContentViaEdit } from "./content-application";
import { finalizeFile } from "./hunk-resolution";
import type { ReviewManagerInternal } from "./types";
import type { ReviewSnapshot } from "../../types";

export async function undoResolve(mgr: ReviewManagerInternal): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	const fsPath = editor.document.uri.fsPath;

	const currentReview = state.activeReviews.get(fsPath);

	const snapshot = popUndoState(fsPath);
	if (!snapshot) {
		log.log(`ReviewManager.undoResolve: no undo state for ${fsPath}`);
		return;
	}

	// Push current state to redo
	if (currentReview) {
		pushRedoState(fsPath, currentReview);
	} else {
		// After finalize — push a "finalized" marker with all hunks resolved
		const finalizedSnapshot: ReviewSnapshot = {
			...snapshot,
			hunks: snapshot.hunks.map((h) => ({ ...h, resolved: true, accepted: true })),
		};
		pushRedoState(fsPath, finalizedSnapshot);
	}

	log.log(`ReviewManager.undoResolve: restoring ${fsPath}, unresolved=${snapshot.hunks.filter((h) => !h.resolved).length}`);
	restoreFromSnapshot(mgr, fsPath, snapshot);
	await applyContentViaEdit(mgr, fsPath, snapshot.mergedLines.join("\n"));
}

export async function redoResolve(mgr: ReviewManagerInternal): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	const fsPath = editor.document.uri.fsPath;

	const currentReview = state.activeReviews.get(fsPath);
	const snapshot = popRedoState(fsPath);
	if (!snapshot) {
		log.log(`ReviewManager.redoResolve: no redo state for ${fsPath}`);
		return;
	}

	// Push current to undo
	if (currentReview) {
		pushUndoState(fsPath, currentReview);
	}

	const allResolved = snapshot.hunks.every((h) => h.resolved);
	if (allResolved) {
		log.log(`ReviewManager.redoResolve: re-finalizing ${fsPath}`);
		restoreFromSnapshot(mgr, fsPath, snapshot);
		const review = state.activeReviews.get(fsPath);
		if (review) {
			review.hunks = JSON.parse(JSON.stringify(snapshot.hunks));
			await finalizeFile(mgr, fsPath);
		}
	} else {
		log.log(`ReviewManager.redoResolve: restoring ${fsPath}, unresolved=${snapshot.hunks.filter((h) => !h.resolved).length}`);
		restoreFromSnapshot(mgr, fsPath, snapshot);
		await applyContentViaEdit(mgr, fsPath, snapshot.mergedLines.join("\n"));
	}
}

export function restoreFromSnapshot(mgr: ReviewManagerInternal, fsPath: string, snapshot: ReviewSnapshot): void {
	const unresolvedCount = snapshot.hunks.filter((h) => !h.resolved).length;
	let review = state.activeReviews.get(fsPath);
	if (!review) {
		log.log(`ReviewManager.restoreFromSnapshot: re-creating review for ${fsPath}, unresolved=${unresolvedCount}`);
		review = new FileReview(
			snapshot.filePath,
			snapshot.originalContent,
			snapshot.modifiedContent,
			JSON.parse(JSON.stringify(snapshot.hunks)),
			snapshot.changeType,
		);
		state.activeReviews.set(fsPath, review);
		if (!mgr.reviewFiles.includes(fsPath)) mgr.reviewFiles.push(fsPath);
		mgr._onReviewStateChange.fire(true);
	}

	if (state.activeReviews.has(fsPath)) {
		log.log(`ReviewManager.restoreFromSnapshot: updating existing review for ${fsPath}, unresolved=${unresolvedCount}`);
	}
	review.hunks = JSON.parse(JSON.stringify(snapshot.hunks));
	(review as FileReview).mergedLines = [...snapshot.mergedLines];
	(review as FileReview).hunkRanges = snapshot.hunkRanges.map((r) => ({ ...r }));

	const hunkDetail = review.hunks.map((h) => `${h.id}:${h.resolved ? "R" : "U"}`).join(",");
	const rangeDetail = (review as FileReview).hunkRanges.map((r) => `h${r.hunkId}@${r.removedStart}-${r.removedEnd}/${r.addedStart}-${r.addedEnd}`).join(", ");
	log.log(`ReviewManager.restoreFromSnapshot: hunks=[${hunkDetail}], ranges=[${rangeDetail}]`);

	const editor = vscode.window.visibleTextEditors.find(
		(e) => e.document.uri.fsPath === fsPath,
	);
	if (editor) applyDecorations(editor, review);
	mgr.syncState();
	mgr.refreshUI();
	mgr.scheduleSave();
}
