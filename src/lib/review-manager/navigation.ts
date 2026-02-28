// Navigation — hunk/file navigation and file opening for review
import * as vscode from "vscode";
import * as fs from "fs";
import { log, logCat } from "../log";
import * as state from "../state";
import { applyDecorations } from "../decorations";
import { FileReview } from "../review";
import { initHistory, setApplyingEdit } from "../undo-history";
import type { ReviewManagerInternal } from "./types";

/** Clamp currentFileIndex to valid bounds after reviewFiles mutations */
export function clampFileIndex(mgr: ReviewManagerInternal): void {
	if (mgr.reviewFiles.length === 0) {
		mgr.currentFileIndex = 0;
	} else if (mgr.currentFileIndex >= mgr.reviewFiles.length) {
		mgr.currentFileIndex = mgr.reviewFiles.length - 1;
	}
}

export function navigateHunk(mgr: ReviewManagerInternal, delta: number): void {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	const review = state.activeReviews.get(editor.document.uri.fsPath);
	if (!review) return;
	const ranges = review.hunkRanges;
	if (ranges.length === 0) return;

	const oldIdx = mgr.currentHunkIndex;
	mgr.currentHunkIndex = (mgr.currentHunkIndex + delta + ranges.length) % ranges.length;
	logCat("navigation", `navigateHunk: ${oldIdx} → ${mgr.currentHunkIndex} (delta=${delta}, total=${ranges.length})`);
	const range = ranges[mgr.currentHunkIndex];
	const line = range.addedStart;
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
	let curIdx = files.indexOf(current);
	if (curIdx === -1) {
		// Current file already finalized — start from edge based on direction
		curIdx = delta > 0 ? -1 : files.length;
	}
	const newIdx = ((curIdx + delta) % files.length + files.length) % files.length;
	logCat("navigation", `navigateFile: ${current || "none"} (idx=${curIdx}) → ${files[newIdx]} (idx=${newIdx}), delta=${delta}, unresolvedFiles=${files.length}`);
	await mgr.openFileForReview(files[newIdx]);
}

export async function reviewNextUnresolved(mgr: ReviewManagerInternal): Promise<void> {
	const files = mgr.reviewFiles;
	const total = files.length;
	if (total === 0) return;

	// Clamp startIdx — currentFileIndex can exceed array length after finalization
	const startIdx = Math.min(mgr.currentFileIndex, total - 1);
	// Start from i=1 to skip the current file (go to NEXT unresolved)
	for (let i = 1; i <= total; i++) {
		const idx = (startIdx + i) % total;
		if (state.activeReviews.has(files[idx])) {
			logCat("navigation",`reviewNextUnresolved: from index ${startIdx} → opening index ${idx} (${files[idx]})`);
			await mgr.openFileForReview(files[idx]);
			return;
		}
	}
	logCat("navigation",`reviewNextUnresolved: no unresolved files remaining`);
}

export async function openCurrentOrNext(mgr: ReviewManagerInternal): Promise<void> {
	clampFileIndex(mgr);
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
	if (!review) {
		logCat("navigation", `openFileForReview: no review for ${filePath}, skipping`);
		return;
	}

	const fname = filePath.split("/").pop();
	logCat("navigation", `openFileForReview: START ${fname}, hunks=${review.hunks.length}, unresolved=${review.unresolvedCount}, mergedLines=${review.mergedLines.length}`);

	initHistory(filePath);

	const mergedContent = review.mergedLines.join("\n");
	fs.writeFileSync(filePath, mergedContent, "utf8");
	(review as FileReview).mergedApplied = true;
	logCat("navigation", `openFileForReview: wrote merged content to disk (${mergedContent.length} chars)`);
	const doc = await vscode.workspace.openTextDocument(filePath);
	const editor = await vscode.window.showTextDocument(doc, {
		preview: false,
		viewColumn: vscode.ViewColumn.One,
	});

	// If the file was already open, the editor may have stale cached content.
	if (doc.getText() !== mergedContent) {
		logCat("navigation",`openFileForReview: editor content stale for ${fname} (docLen=${doc.getText().length}, mergedLen=${mergedContent.length}), syncing via edit`);
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
			// Write to disk directly — doc.save() triggers formatOnSave which can mutate the buffer
			fs.writeFileSync(filePath, mergedContent, "utf8");
			// Clear dirty flag (disk matches buffer, so revert is visually a no-op)
			try { await vscode.commands.executeCommand("workbench.action.files.revert"); } catch (err) {
			logCat("navigation", `openFileForReview: revert failed for ${filePath}: ${(err as Error).message}`);
		}
		} finally {
			setApplyingEdit(filePath, false);
		}
	}

	applyDecorations(editor, review);

	const firstRange = review.hunkRanges[0];
	if (firstRange) {
		const line = firstRange.addedStart;
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
