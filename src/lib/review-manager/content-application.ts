// Content application — applies merged/final content to editors via TextEditor.edit
import * as vscode from "vscode";
import * as fs from "fs";
import * as log from "../log";
import * as state from "../state";
import { applyDecorations } from "../decorations";
import { FileReview } from "../review";
import { setApplyingEdit } from "../undo-history";
import type { ReviewManagerInternal } from "./types";

/**
 * Save document content to disk without triggering formatOnSave.
 *
 * `doc.save()` runs through the VS Code save pipeline which includes
 * formatOnSave — formatters can add/remove lines, breaking hunk ranges
 * and decorations. Instead, we write directly to disk via fs and use
 * `revert` to clear the dirty flag (content matches disk, so no visible change).
 */
async function saveWithoutFormatting(doc: vscode.TextDocument): Promise<void> {
	const content = doc.getText();
	fs.writeFileSync(doc.uri.fsPath, content, "utf8");
	// Clear dirty flag: since disk content now matches buffer, revert is a no-op visually
	try {
		await vscode.commands.executeCommand("workbench.action.files.revert");
	} catch {
		// revert may fail if doc is not active — that's ok, dirty flag is cosmetic
		log.log(`saveWithoutFormatting: revert failed for ${doc.uri.fsPath}, dirty flag may persist`);
	}
}

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
		log.log(`applyContentViaEdit: no editor for ${filePath}, writing to disk`);
		fs.writeFileSync(filePath, newContent, "utf8");
		const rev = state.activeReviews.get(filePath);
		if (rev) (rev as FileReview).mergedApplied = true;
		return;
	}
	log.log(`applyContentViaEdit: applying via TextEditor.edit for ${filePath} (${newContent.length} chars)`);

	// Save scroll position and cursor before replacing content
	const savedSelection = editor.selection;
	const savedVisibleRange = editor.visibleRanges[0];

	setApplyingEdit(filePath, true);
	let editSuccess = false;
	try {
		const doc = editor.document;
		const lastLine = doc.lineCount - 1;
		const fullRange = new vscode.Range(
			0, 0,
			lastLine, doc.lineAt(lastLine).text.length,
		);
		editSuccess = await editor.edit(
			(eb) => eb.replace(fullRange, newContent),
			{ undoStopBefore: true, undoStopAfter: true },
		);
		if (!editSuccess) {
			// Retry once after a short delay — file watcher may be updating the buffer
			log.log(`applyContentViaEdit: editor.edit() returned false for ${filePath}, retrying in 50ms`);
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
		}
		if (editSuccess) {
			await saveWithoutFormatting(doc);
			// Mark that merged content is now on disk
			const rev = state.activeReviews.get(filePath);
			if (rev) (rev as FileReview).mergedApplied = true;
		} else {
			log.log(`applyContentViaEdit: retry also failed for ${filePath}, falling back to fs.writeFileSync`);
			fs.writeFileSync(filePath, newContent, "utf8");
			const revFb = state.activeReviews.get(filePath);
			if (revFb) (revFb as FileReview).mergedApplied = true;
		}
	} finally {
		setApplyingEdit(filePath, false);
	}

	if (editSuccess) {
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
}

/**
 * Targeted edit: remove only the resolved hunk's lines instead of replacing
 * the entire buffer. This preserves scroll position naturally because
 * unaffected lines don't move.
 *
 * @param deleteStart - 0-based line index (inclusive)
 * @param deleteEnd   - 0-based line index (exclusive)
 * @param revealLine  - line to reveal after edit (next unresolved hunk)
 */
export async function applyTargetedHunkEdit(
	mgr: ReviewManagerInternal,
	filePath: string,
	deleteStart: number,
	deleteEnd: number,
	revealLine?: number,
): Promise<boolean> {
	const editor = vscode.window.visibleTextEditors.find(
		(e) => e.document.uri.fsPath === filePath,
	);
	if (!editor || deleteStart >= deleteEnd) return false;

	const doc = editor.document;
	if (deleteEnd > doc.lineCount) return false;

	log.log(`applyTargetedHunkEdit: deleting lines ${deleteStart}-${deleteEnd} in ${filePath} (docLines=${doc.lineCount})`);

	setApplyingEdit(filePath, true);
	let editSuccess = false;
	try {
		// Build a range that covers the lines to delete (including trailing newline).
		// When deleting at end-of-file, grab the newline from the previous line instead.
		const rangeStart = deleteStart > 0 && deleteEnd >= doc.lineCount
			? new vscode.Position(deleteStart - 1, doc.lineAt(deleteStart - 1).text.length)
			: new vscode.Position(deleteStart, 0);
		const rangeEnd = deleteEnd < doc.lineCount
			? new vscode.Position(deleteEnd, 0)
			: new vscode.Position(deleteEnd - 1, doc.lineAt(deleteEnd - 1).text.length);
		const deleteRange = new vscode.Range(rangeStart, rangeEnd);

		editSuccess = await editor.edit(
			(eb) => eb.delete(deleteRange),
			{ undoStopBefore: true, undoStopAfter: true },
		);
		log.log(`applyTargetedHunkEdit: edit result=${editSuccess}, docLines after=${doc.lineCount}`);
		if (editSuccess) {
			await saveWithoutFormatting(doc);
			const rev = state.activeReviews.get(filePath);
			if (rev) (rev as FileReview).mergedApplied = true;
		}
	} finally {
		setApplyingEdit(filePath, false);
	}

	if (editSuccess) {
		// Verify buffer matches expected merged content; fallback to full replace if not
		const review = state.activeReviews.get(filePath);
		if (review) {
			const expected = review.mergedLines.join("\n");
			const bufferMatch = doc.getText() === expected;
			log.log(`applyTargetedHunkEdit: post-edit verify bufferMatch=${bufferMatch}, expectedLines=${review.mergedLines.length}, docLines=${doc.lineCount}`);
			if (!bufferMatch) {
				log.log(`applyTargetedHunkEdit: content mismatch after delete, falling back to full replace`);
				const retrySuccess = await editor.edit(
					(eb) => eb.replace(new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length), expected),
					{ undoStopBefore: false, undoStopAfter: true },
				);
				if (retrySuccess) await saveWithoutFormatting(doc);
			}
			if (doc.getText() === expected) {
				applyDecorations(editor, review);
			} else {
				log.log(`applyTargetedHunkEdit: buffer still mismatched after fallback, skipping decorations`);
			}
		}
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
	return editSuccess;
}
