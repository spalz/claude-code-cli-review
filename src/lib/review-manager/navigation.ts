// Navigation — hunk/file navigation and file opening for review
import * as vscode from "vscode";
import * as fs from "fs";
import * as log from "../log";
import * as state from "../state";
import { applyDecorations } from "../decorations";
import { FileReview } from "../review";
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
	const files = mgr.reviewFiles;
	const total = files.length;
	if (total === 0) return;

	// Search forward from current position, wrapping around
	const startIdx = mgr.currentFileIndex;
	for (let i = 1; i <= total; i++) {
		const idx = (startIdx + i) % total;
		if (state.activeReviews.has(files[idx])) {
			log.log(`reviewNextUnresolved: from index ${startIdx} → opening index ${idx} (${files[idx]})`);
			await mgr.openFileForReview(files[idx]);
			return;
		}
	}
	log.log(`reviewNextUnresolved: no unresolved files remaining`);
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
	(review as FileReview).mergedApplied = true;
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
			// Write to disk directly — doc.save() triggers formatOnSave which can mutate the buffer
			fs.writeFileSync(filePath, mergedContent, "utf8");
			// Clear dirty flag (disk matches buffer, so revert is visually a no-op)
			try { await vscode.commands.executeCommand("workbench.action.files.revert"); } catch {}
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
