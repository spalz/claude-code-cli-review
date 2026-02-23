// Navigation — hunk/file navigation and file opening for review
import * as vscode from "vscode";
import * as fs from "fs";
import * as log from "../log";
import * as state from "../state";
import { applyDecorations } from "../decorations";
import { initHistory, setApplyingEdit } from "../undo-history";
import type { ReviewManagerInternal } from "./types";

export function navigateHunk(mgr: ReviewManagerInternal, delta: number): void {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	const review = state.activeReviews.get(editor.document.uri.fsPath);
	if (!review) return;
	const ranges = review.hunkRanges;
	if (ranges.length === 0) return;

	mgr.currentHunkIndex = (mgr.currentHunkIndex + delta + ranges.length) % ranges.length;
	const range = ranges[mgr.currentHunkIndex];
	const line = range.removedStart < range.removedEnd ? range.removedStart : range.addedStart;
	editor.revealRange(
		new vscode.Range(line, 0, line, 0),
		vscode.TextEditorRevealType.InCenter,
	);
	editor.selection = new vscode.Selection(line, 0, line, 0);
	mgr.syncState();
	mgr.refreshUI();
}

export async function navigateFile(mgr: ReviewManagerInternal, delta: number): Promise<void> {
	const files = mgr.reviewFiles.filter((f) => state.activeReviews.has(f));
	if (files.length === 0) return;
	const current = mgr.reviewFiles[mgr.currentFileIndex];
	const curIdx = files.indexOf(current);
	const newIdx = (curIdx + delta + files.length) % files.length;
	await mgr.openFileForReview(files[newIdx]);
}

export async function reviewNextUnresolved(mgr: ReviewManagerInternal): Promise<void> {
	const currentFile = mgr.reviewFiles[mgr.currentFileIndex];
	// Skip the current file — find the next unresolved one
	const next = mgr.reviewFiles.find((f) => f !== currentFile && state.activeReviews.has(f))
		// Fallback: if no other file found, open the first unresolved (may be current)
		?? mgr.reviewFiles.find((f) => state.activeReviews.has(f));
	if (next) {
		await mgr.openFileForReview(next);
	}
}

export async function openCurrentOrNext(mgr: ReviewManagerInternal): Promise<void> {
	const files = mgr.reviewFiles.filter((f) => state.activeReviews.has(f));
	if (files.length === 0) return;
	// Try to open the file at the saved currentFileIndex
	const target = mgr.reviewFiles[mgr.currentFileIndex];
	if (target && state.activeReviews.has(target)) {
		await mgr.openFileForReview(target);
	} else {
		await mgr.openFileForReview(files[0]);
	}
}

export async function openFileForReview(mgr: ReviewManagerInternal, filePath: string): Promise<void> {
	const review = state.activeReviews.get(filePath);
	if (!review) return;

	initHistory(filePath);

	const mergedContent = review.mergedLines.join("\n");
	fs.writeFileSync(filePath, mergedContent, "utf8");
	const doc = await vscode.workspace.openTextDocument(filePath);
	const editor = await vscode.window.showTextDocument(doc, {
		preview: false,
		viewColumn: vscode.ViewColumn.One,
	});

	// If the file was already open, the editor may have stale cached content.
	if (doc.getText() !== mergedContent) {
		log.log(`openFileForReview: editor content stale, syncing via edit for ${filePath}`);
		setApplyingEdit(filePath, true);
		try {
			const lastLine = doc.lineCount - 1;
			const fullRange = new vscode.Range(
				0, 0,
				lastLine, doc.lineAt(lastLine).text.length,
			);
			await editor.edit(
				(eb) => eb.replace(fullRange, mergedContent),
				{ undoStopBefore: true, undoStopAfter: true },
			);
			await doc.save();
		} finally {
			setApplyingEdit(filePath, false);
		}
	}

	applyDecorations(editor, review);

	const firstRange = review.hunkRanges[0];
	if (firstRange) {
		const line =
			firstRange.removedStart < firstRange.removedEnd
				? firstRange.removedStart
				: firstRange.addedStart;
		editor.revealRange(
			new vscode.Range(line, 0, line, 0),
			vscode.TextEditorRevealType.InCenterIfOutsideViewport,
		);
	}

	mgr.currentFileIndex = mgr.reviewFiles.indexOf(filePath);
	mgr.currentHunkIndex = 0;
	mgr.syncState();
	mgr.refreshUI();
}
