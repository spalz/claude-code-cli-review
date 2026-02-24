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
	const fname = filePath.split("/").pop();
	const t0 = performance.now();
	log.log(`applyContentViaEdit: START ${fname} (${newContent.length} chars)`);

	// Fast path: if buffer already matches, skip editor.edit() entirely.
	// This prevents CodeLens invalidation (~250ms flash) during undo of accept-only operations.
	if (editor.document.getText() === newContent) {
		log.log(`applyContentViaEdit: SKIP (buffer matches) ${fname}`);
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
		log.log(`applyContentViaEdit: END ${fname} (skipped), total=${(performance.now() - t0).toFixed(1)}ms`);
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
		const replacementText = newLines.slice(newStart, newEnd).join("\n");

		if (oldStart === oldEnd && newStart === newEnd) {
			// No actual difference — shouldn't happen (SKIP above catches exact match)
			log.log(`applyContentViaEdit: targeted found no diff, treating as skip`);
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
			} else if (atEndOfFile && newStart < newEnd && oldStart > 0) {
				// Replacing at end of file — need leading \n if there was content before
				// (only when the range we're replacing didn't start at line 0)
			}

			const editRange = new vscode.Range(rangeStart, rangeEnd);
			log.log(`applyContentViaEdit: targeted edit lines ${oldStart}-${oldEnd} → ${newEnd - newStart} lines (of ${oldLines.length}→${newLines.length})`);
			editSuccess = await editor.edit(
				(eb) => eb.replace(editRange, replacement),
				{ undoStopBefore: true, undoStopAfter: true },
			);
		}

		log.log(`applyContentViaEdit: editor.edit()=${editSuccess}, ${(performance.now() - tEdit).toFixed(1)}ms`);
		if (!editSuccess) {
			// Retry with full replace as fallback
			log.log(`applyContentViaEdit: targeted edit failed, retrying with full replace`);
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
			log.log(`applyContentViaEdit: retry edit()=${editSuccess}`);
		}
		if (editSuccess) {
			const tSave = performance.now();
			await saveWithoutFormatting(doc);
			log.log(`applyContentViaEdit: saveWithoutFormatting ${(performance.now() - tSave).toFixed(1)}ms`);
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
		// Verify buffer matches after targeted edit; fallback to full replace if mismatched
		if (editor.document.getText() !== newContent) {
			log.log(`applyContentViaEdit: post-edit buffer mismatch, doing full replace fallback`);
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
	log.log(`applyContentViaEdit: END ${fname}, total=${(performance.now() - t0).toFixed(1)}ms, editSuccess=${editSuccess}`);
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
