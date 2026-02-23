// Content application — applies merged/final content to editors via TextEditor.edit
import * as vscode from "vscode";
import * as fs from "fs";
import * as log from "../log";
import * as state from "../state";
import { applyDecorations } from "../decorations";
import { setApplyingEdit } from "../undo-history";
import type { ReviewManagerInternal } from "./types";

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
		return;
	}
	log.log(`applyContentViaEdit: applying via TextEditor.edit for ${filePath} (${newContent.length} chars)`);

	// Save scroll position and cursor before replacing content
	const savedSelection = editor.selection;
	const savedVisibleRange = editor.visibleRanges[0];

	setApplyingEdit(filePath, true);
	try {
		const doc = editor.document;
		const lastLine = doc.lineCount - 1;
		const fullRange = new vscode.Range(
			0, 0,
			lastLine, doc.lineAt(lastLine).text.length,
		);
		await editor.edit(
			(eb) => eb.replace(fullRange, newContent),
			{ undoStopBefore: true, undoStopAfter: true },
		);
		await doc.save();
	} finally {
		setApplyingEdit(filePath, false);
	}

	const review = state.activeReviews.get(filePath);
	if (review) applyDecorations(editor, review);

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
