// Undo/Redo — manages undo and redo for hunk resolution
import * as vscode from "vscode";
import { logCat } from "../log";
import * as state from "../state";

import { popUndoState, pushRedoState, popRedoState, pushUndoState, getLastUndoFilePath, getLastRedoFilePath, hasUndoState, hasRedoState } from "../undo-history";
import { FileReview } from "../review";
import { applyContentViaEdit } from "./content-application";
import { finalizeFile } from "./hunk-resolution";
import type { ReviewManagerInternal } from "./types";
import type { ReviewSnapshot } from "../../types";

export async function undoResolve(mgr: ReviewManagerInternal): Promise<void> {
	const tUndo = performance.now();
	const editor = vscode.window.activeTextEditor;
	const activeFile = editor?.document.uri.fsPath;

	// Cross-file undo: if active file has no undo state, try last global entry
	const lastUndoFile = getLastUndoFilePath();
	const fsPath = (activeFile && hasUndoState(activeFile))
		? activeFile
		: lastUndoFile;

	if (!fsPath || !hasUndoState(fsPath)) {
		logCat("resolve",`ReviewManager.undoResolve: no undo state available (active=${activeFile}, lastGlobal=${lastUndoFile})`);
		vscode.window.setStatusBarMessage("$(info) Nothing to undo", 2000);
		return;
	}

	// If target file is different from active editor, open it first
	if (fsPath !== activeFile) {
		logCat("resolve",`ReviewManager.undoResolve: cross-file undo, opening ${fsPath}`);
		await vscode.window.showTextDocument(vscode.Uri.file(fsPath));
	}

	const currentReview = state.activeReviews.get(fsPath);

	const snapshot = popUndoState(fsPath);
	if (!snapshot) {
		logCat("resolve",`ReviewManager.undoResolve: no undo state for ${fsPath}`);
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

	const snapshotHunkState = snapshot.hunks.map((h) => `${h.id}:${h.resolved ? (h.accepted ? "A" : "R") : "U"}`).join(",");
	logCat("resolve",`ReviewManager.undoResolve: restoring ${fsPath}, unresolved=${snapshot.hunks.filter((h) => !h.resolved).length}, snapshot hunks=[${snapshotHunkState}], mergedLines=${snapshot.mergedLines.length}`);
	restoreFromSnapshot(mgr, fsPath, snapshot);
	// Reveal first unresolved hunk from the restored snapshot
	const firstRange = snapshot.hunkRanges[0];
	const revealLine = firstRange
		? (firstRange.removedStart < firstRange.removedEnd ? firstRange.removedStart : firstRange.addedStart)
		: undefined;
	await applyContentViaEdit(mgr, fsPath, snapshot.mergedLines.join("\n"), revealLine);
	logCat("resolve",`ReviewManager.undoResolve: END total=${(performance.now() - tUndo).toFixed(1)}ms`);
}

export async function redoResolve(mgr: ReviewManagerInternal): Promise<void> {
	const tRedo = performance.now();
	const editor = vscode.window.activeTextEditor;
	const activeFile = editor?.document.uri.fsPath;

	// Cross-file redo: if active file has no redo state, try last global entry
	const lastRedoFile = getLastRedoFilePath();
	const fsPath = (activeFile && hasRedoState(activeFile))
		? activeFile
		: lastRedoFile;

	if (!fsPath || !hasRedoState(fsPath)) {
		logCat("resolve",`ReviewManager.redoResolve: no redo state available (active=${activeFile}, lastGlobal=${lastRedoFile})`);
		vscode.window.setStatusBarMessage("$(info) Nothing to redo", 2000);
		return;
	}

	// If target file is different from active editor, open it first
	if (fsPath !== activeFile) {
		logCat("resolve",`ReviewManager.redoResolve: cross-file redo, opening ${fsPath}`);
		await vscode.window.showTextDocument(vscode.Uri.file(fsPath));
	}

	const currentReview = state.activeReviews.get(fsPath);
	const snapshot = popRedoState(fsPath);
	if (!snapshot) {
		logCat("resolve",`ReviewManager.redoResolve: no redo state for ${fsPath}`);
		return;
	}

	// Push current to undo (preserve redo stack — we're inside a redo operation)
	if (currentReview) {
		pushUndoState(fsPath, currentReview, true);
	}

	const allResolved = snapshot.hunks.every((h) => h.resolved);
	const redoHunkState = snapshot.hunks.map((h) => `${h.id}:${h.resolved ? (h.accepted ? "A" : "R") : "U"}`).join(",");
	logCat("resolve",`ReviewManager.redoResolve: snapshot hunks=[${redoHunkState}], allResolved=${allResolved}, mergedLines=${snapshot.mergedLines.length}`);
	if (allResolved) {
		logCat("resolve",`ReviewManager.redoResolve: re-finalizing ${fsPath}`);
		restoreFromSnapshot(mgr, fsPath, snapshot);
		const review = state.activeReviews.get(fsPath);
		if (review) {
			review.hunks = JSON.parse(JSON.stringify(snapshot.hunks));
			await finalizeFile(mgr, fsPath);
		}
	} else {
		logCat("resolve",`ReviewManager.redoResolve: restoring ${fsPath}, unresolved=${snapshot.hunks.filter((h) => !h.resolved).length}`);
		restoreFromSnapshot(mgr, fsPath, snapshot);
		// Reveal first unresolved hunk from the restored snapshot
		const firstRange = snapshot.hunkRanges[0];
		const revealLine = firstRange
			? (firstRange.removedStart < firstRange.removedEnd ? firstRange.removedStart : firstRange.addedStart)
			: undefined;
		await applyContentViaEdit(mgr, fsPath, snapshot.mergedLines.join("\n"), revealLine);
	}
	logCat("resolve",`ReviewManager.redoResolve: END total=${(performance.now() - tRedo).toFixed(1)}ms`);
}

export function restoreFromSnapshot(mgr: ReviewManagerInternal, fsPath: string, snapshot: ReviewSnapshot): void {
	const unresolvedCount = snapshot.hunks.filter((h) => !h.resolved).length;
	let review = state.activeReviews.get(fsPath);
	if (!review) {
		logCat("resolve",`ReviewManager.restoreFromSnapshot: re-creating review for ${fsPath}, unresolved=${unresolvedCount}`);
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
		logCat("resolve",`ReviewManager.restoreFromSnapshot: updating existing review for ${fsPath}, unresolved=${unresolvedCount}`);
	}
	review.hunks = JSON.parse(JSON.stringify(snapshot.hunks));
	(review as FileReview).mergedLines = [...snapshot.mergedLines];
	(review as FileReview).hunkRanges = snapshot.hunkRanges.map((r) => ({ ...r }));

	const hunkDetail = review.hunks.map((h) => `${h.id}:${h.resolved ? "R" : "U"}`).join(",");
	const rangeDetail = (review as FileReview).hunkRanges.map((r) => `h${r.hunkId}@${r.removedStart}-${r.removedEnd}/${r.addedStart}-${r.addedEnd}`).join(", ");
	logCat("resolve",`ReviewManager.restoreFromSnapshot: hunks=[${hunkDetail}], ranges=[${rangeDetail}]`);

	// NOTE: We intentionally do NOT call syncState/refreshUI here.
	// The caller (undoResolve/redoResolve) will call applyContentViaEdit
	// which updates the buffer first, THEN calls syncState + refreshUI.
	// Calling refreshUI before the buffer is updated causes CodeLens to
	// flash at wrong positions (the hunkRanges reference new content but
	// the buffer still has old content).
	mgr.scheduleSave();
}
