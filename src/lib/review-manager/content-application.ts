// Content application — applies merged/final content to editors via TextEditor.edit
import * as vscode from "vscode";
import * as fs from "fs";
import { logCat } from "../log";
import * as state from "../state";
import { applyDecorations } from "../decorations";
import { FileReview } from "../review";
import { setApplyingEdit } from "../undo-history";
import { saveWithoutFormatting } from "./editor-utils";
import type { ReviewManagerInternal } from "./types";

// Re-export for consumers that import from this module
export { applyTargetedHunkEdit } from "./targeted-edit";

export async function applyContentViaEdit(
	mgr: ReviewManagerInternal,
	filePath: string,
	newContent: string,
	revealLine?: number,
): Promise<void> {
	const editor = vscode.window.visibleTextEditors.find(
		(e) => e.document.uri.fsPath === filePath,
	);
	if (!editor) {
		logCat("content",`applyContentViaEdit: no editor for ${filePath}, writing to disk`);
		fs.writeFileSync(filePath, newContent, "utf8");
		const rev = state.activeReviews.get(filePath);
		if (rev) (rev as FileReview).mergedApplied = true;
		return;
	}
	const fname = filePath.split("/").pop();
	const t0 = performance.now();
	logCat("content",`applyContentViaEdit: START ${fname} (${newContent.length} chars)`);

	// Fast path: if buffer already matches, skip editor.edit() entirely.
	// This prevents CodeLens invalidation (~250ms flash) during undo of accept-only operations.
	if (editor.document.getText() === newContent) {
		logCat("content",`applyContentViaEdit: SKIP (buffer matches) ${fname}`);
		const rev = state.activeReviews.get(filePath);
		if (rev) {
			(rev as FileReview).mergedApplied = true;
			applyDecorations(editor, rev);
		}
		if (revealLine !== undefined) {
			const clampedLine = Math.min(revealLine, editor.document.lineCount - 1);
			editor.revealRange(
				new vscode.Range(clampedLine, 0, clampedLine, 0),
				vscode.TextEditorRevealType.InCenterIfOutsideViewport,
			);
		}
		mgr.syncState();
		mgr.refreshUI();
		logCat("content",`applyContentViaEdit: END ${fname} (skipped), total=${(performance.now() - t0).toFixed(1)}ms`);
		return;
	}

	// Save scroll position and cursor before replacing content
	const savedSelection = editor.selection;
	const savedVisibleRange = editor.visibleRanges[0];

	setApplyingEdit(filePath, true);
	let editSuccess = false;
	try {
		const doc = editor.document;
		const tEdit = performance.now();

		// Targeted edit: find minimal changed line range to preserve CodeLens on unchanged lines.
		// Full buffer replace invalidates ALL CodeLens causing ~250ms flash.
		const oldLines = doc.getText().split("\n");
		const newLines = newContent.split("\n");

		// Find common prefix
		let prefixLen = 0;
		const minLen = Math.min(oldLines.length, newLines.length);
		while (prefixLen < minLen && oldLines[prefixLen] === newLines[prefixLen]) prefixLen++;

		// Find common suffix (don't overlap with prefix)
		let suffixLen = 0;
		while (
			suffixLen < minLen - prefixLen
			&& oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
		) suffixLen++;

		const oldStart = prefixLen;
		const oldEnd = oldLines.length - suffixLen;
		const newStart = prefixLen;
		const newEnd = newLines.length - suffixLen;

		if (oldStart === oldEnd && newStart === newEnd) {
			// No actual difference — shouldn't happen (SKIP above catches exact match)
			logCat("content",`applyContentViaEdit: targeted found no diff, treating as skip`);
			editSuccess = true;
		} else {
			// Build the range to replace — include trailing newline for proper line boundaries.
			// Range from (oldStart, 0) to (oldEnd, 0) covers lines [oldStart..oldEnd) INCLUDING
			// their trailing newlines. At end-of-file, use last line's end instead.
			const rangeStart = new vscode.Position(oldStart, 0);
			const atEndOfFile = oldEnd >= doc.lineCount;
			const rangeEnd = atEndOfFile
				? new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
				: new vscode.Position(oldEnd, 0);

			// Replacement: join new lines with \n. Add trailing \n if range extends to
			// start of next line (not at EOF) and we have replacement content.
			let replacement = newLines.slice(newStart, newEnd).join("\n");
			if (!atEndOfFile && replacement.length > 0) {
				replacement += "\n";
			}

			const editRange = new vscode.Range(rangeStart, rangeEnd);
			logCat("content",`applyContentViaEdit: targeted edit lines ${oldStart}-${oldEnd} → ${newEnd - newStart} lines (of ${oldLines.length}→${newLines.length})`);
			editSuccess = await editor.edit(
				(eb) => eb.replace(editRange, replacement),
				{ undoStopBefore: true, undoStopAfter: true },
			);
		}

		logCat("content",`applyContentViaEdit: editor.edit()=${editSuccess}, ${(performance.now() - tEdit).toFixed(1)}ms`);
		if (!editSuccess) {
			// Retry with full replace as fallback
			logCat("content",`applyContentViaEdit: targeted edit failed, retrying with full replace`);
			await new Promise((r) => setTimeout(r, 50));
			const retryLastLine = doc.lineCount - 1;
			const retryRange = new vscode.Range(
				0, 0,
				retryLastLine, doc.lineAt(retryLastLine).text.length,
			);
			editSuccess = await editor.edit(
				(eb) => eb.replace(retryRange, newContent),
				{ undoStopBefore: true, undoStopAfter: true },
			);
			logCat("content",`applyContentViaEdit: retry edit()=${editSuccess}`);
		}
		if (editSuccess) {
			const tSave = performance.now();
			await saveWithoutFormatting(doc);
			logCat("content",`applyContentViaEdit: saveWithoutFormatting ${(performance.now() - tSave).toFixed(1)}ms`);
			// Mark that merged content is now on disk
			const rev = state.activeReviews.get(filePath);
			if (rev) (rev as FileReview).mergedApplied = true;
		} else {
			logCat("content",`applyContentViaEdit: retry also failed for ${filePath}, falling back to fs.writeFileSync`);
			fs.writeFileSync(filePath, newContent, "utf8");
			const revFb = state.activeReviews.get(filePath);
			if (revFb) (revFb as FileReview).mergedApplied = true;
		}
	} finally {
		setApplyingEdit(filePath, false);
	}

	if (editSuccess) {
		// Verify buffer matches after targeted edit; fallback to full replace if mismatched
		if (editor.document.getText() !== newContent) {
			logCat("content",`applyContentViaEdit: post-edit buffer mismatch, doing full replace fallback`);
			setApplyingEdit(filePath, true);
			try {
				const doc = editor.document;
				const fl = doc.lineCount - 1;
				await editor.edit(
					(eb) => eb.replace(new vscode.Range(0, 0, fl, doc.lineAt(fl).text.length), newContent),
					{ undoStopBefore: false, undoStopAfter: true },
				);
				await saveWithoutFormatting(doc);
			} finally {
				setApplyingEdit(filePath, false);
			}
		}
		const review = state.activeReviews.get(filePath);
		if (review) applyDecorations(editor, review);
	}

	// Restore scroll position: prefer explicit revealLine, otherwise restore previous viewport
	if (revealLine !== undefined) {
		const clampedLine = Math.min(revealLine, editor.document.lineCount - 1);
		editor.revealRange(
			new vscode.Range(clampedLine, 0, clampedLine, 0),
			vscode.TextEditorRevealType.InCenterIfOutsideViewport,
		);
	} else if (savedVisibleRange) {
		// Clamp to new document length
		const topLine = Math.min(savedVisibleRange.start.line, editor.document.lineCount - 1);
		editor.revealRange(
			new vscode.Range(topLine, 0, topLine, 0),
			vscode.TextEditorRevealType.AtTop,
		);
	}

	// Restore cursor position (clamped to new document)
	const maxLine = editor.document.lineCount - 1;
	const cursorLine = Math.min(savedSelection.active.line, maxLine);
	editor.selection = new vscode.Selection(cursorLine, savedSelection.active.character, cursorLine, savedSelection.active.character);

	mgr.syncState();
	mgr.refreshUI();
	logCat("content",`applyContentViaEdit: END ${fname}, total=${(performance.now() - t0).toFixed(1)}ms, editSuccess=${editSuccess}`);
}
