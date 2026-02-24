// Editor decorations for inline diff rendering (buttons via CodeLens)
import * as vscode from "vscode";
import * as path from "path";
import * as log from "./log";
import type { IFileReview } from "../types";
import { computeHunkInlineChanges } from "./inline-diff";

/** Maximum total decoration ranges before truncation warning */
const MAX_DECORATIONS = 150;

/** Extension root path, set during activation */
let extensionPath = "";

/** Must be called during activation to resolve gutter icon paths */
export function initDecorations(extPath: string): void {
	extensionPath = extPath;
}

const decoAdded = vscode.window.createTextEditorDecorationType({
	backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
	isWholeLine: true,
	overviewRulerColor: new vscode.ThemeColor("editorGutter.addedBackground"),
	overviewRulerLane: vscode.OverviewRulerLane.Left,
	borderWidth: "0 0 0 3px",
	borderStyle: "solid",
	borderColor: new vscode.ThemeColor("editorGutter.addedBackground"),
});

// Character-level inline change highlights (more intense than line background)
const decoAddedInline = vscode.window.createTextEditorDecorationType({
	backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
	borderRadius: "2px",
});

const decoSeparator = vscode.window.createTextEditorDecorationType({
	borderWidth: "1px 0 0 0",
	borderStyle: "dashed",
	borderColor: new vscode.ThemeColor("editorWidget.border"),
});

// Gutter indicator for pending (unresolved) hunks
const decoGutterPending = vscode.window.createTextEditorDecorationType({
	gutterIconSize: "contain",
});

/** Build a markdown hover showing removed lines as a diff block */
function buildRemovedHover(removedLines: string[]): vscode.MarkdownString {
	const md = new vscode.MarkdownString();
	md.isTrusted = true;
	md.supportHtml = true;
	const diffBlock = removedLines.map((l) => `- ${l}`).join("\n");
	md.appendMarkdown(`**Previous code:**\n\`\`\`diff\n${diffBlock}\n\`\`\``);
	return md;
}

export function applyDecorations(editor: vscode.TextEditor, review: IFileReview): void {
	const t0 = performance.now();
	const fp = editor.document.uri.fsPath;

	// Safety net: if editor content doesn't match merged content, decorations would be wrong
	if (editor.document.lineCount !== review.mergedLines.length) {
		log.log(`applyDecorations: lineCount mismatch for ${fp}: editor=${editor.document.lineCount}, merged=${review.mergedLines.length}`);
		clearDecorations(editor);
		return;
	}

	const ad: vscode.DecorationOptions[] = [];
	const sep: vscode.Range[] = [];
	const adInline: vscode.Range[] = [];
	const gutterPending: vscode.DecorationOptions[] = [];

	// Resolve gutter icon path
	const pendingIconPath = extensionPath
		? vscode.Uri.file(path.join(extensionPath, "media", "gutter-pending.svg"))
		: undefined;

	// Performance: count total ranges and truncate if needed
	let totalRanges = 0;
	let truncated = false;

	for (const range of review.hunkRanges) {
		const hunk = review.hunks.find((h) => h.id === range.hunkId);
		if (!hunk || hunk.resolved) continue;

		const hunkLineCount = range.addedEnd - range.addedStart;
		if (totalRanges + hunkLineCount > MAX_DECORATIONS) {
			truncated = true;
			break;
		}
		totalRanges += hunkLineCount;

		// Separator above hunk
		if (range.addedStart > 0) {
			sep.push(new vscode.Range(range.addedStart, 0, range.addedStart, 0));
		}

		// Gutter indicator on first line of hunk
		const gutterLine = range.addedStart < range.addedEnd
			? range.addedStart
			: Math.max(0, range.addedStart - 1);
		if (pendingIconPath) {
			gutterPending.push({
				range: new vscode.Range(gutterLine, 0, gutterLine, 0),
				renderOptions: {
					gutterIconPath: pendingIconPath,
					gutterIconSize: "contain",
				} as vscode.DecorationInstanceRenderOptions,
			});
		}

		// Build hover with removed content (shown on first added line)
		const hoverMessage = hunk.removed.length > 0
			? buildRemovedHover(hunk.removed)
			: undefined;

		for (let i = range.addedStart; i < range.addedEnd; i++) {
			const opts: vscode.DecorationOptions = {
				range: new vscode.Range(i, 0, i, 10000),
			};
			// Attach hover to first added line only
			if (i === range.addedStart && hoverMessage) {
				opts.hoverMessage = hoverMessage;
			}
			ad.push(opts);
		}

		// For pure deletions (no added lines), show hover on preceding context line (or line 0)
		if (range.addedStart === range.addedEnd && hunk.removed.length > 0) {
			const hoverLine = range.addedStart > 0 ? range.addedStart - 1 : 0;
			log.log(`applyDecorations: pure-delete hunk=${range.hunkId} addedStart=${range.addedStart} hoverLine=${hoverLine} (CodeLens will be on line ${range.addedStart})`);
			ad.push({
				range: new vscode.Range(hoverLine, 0, hoverLine, 0),
				hoverMessage,
			});
		}

		// Character-level inline changes (only for added lines since removed are in hover)
		const { addedLineChanges } = computeHunkInlineChanges(
			hunk.removed,
			hunk.added,
		);

		for (let li = 0; li < addedLineChanges.length; li++) {
			const lineIdx = range.addedStart + li;
			for (const change of addedLineChanges[li]) {
				adInline.push(new vscode.Range(lineIdx, change.start, lineIdx, change.end));
			}
		}
	}

	if (truncated) {
		log.log(`applyDecorations: truncated at ${MAX_DECORATIONS} decoration ranges for ${editor.document.uri.fsPath}`);
		vscode.window.showWarningMessage(
			`Claude Code Review: Too many changes (>${MAX_DECORATIONS} lines). Showing first hunks only.`,
		);
	}

	const tBuild = performance.now();
	editor.setDecorations(decoAdded, ad);
	editor.setDecorations(decoAddedInline, adInline);
	editor.setDecorations(decoGutterPending, gutterPending);
	editor.setDecorations(decoSeparator, sep);
	const tEnd = performance.now();
	log.log(`applyDecorations: ${fp.split("/").pop()}, hunks=${review.hunkRanges.length}, ranges=${ad.length}+${adInline.length} inline+${gutterPending.length} gutter, build=${(tBuild - t0).toFixed(1)}ms, setDecorations=${(tEnd - tBuild).toFixed(1)}ms, total=${(tEnd - t0).toFixed(1)}ms`);
}

export function clearDecorations(editor: vscode.TextEditor): void {
	const t0 = performance.now();
	editor.setDecorations(decoAdded, []);
	editor.setDecorations(decoAddedInline, []);
	editor.setDecorations(decoGutterPending, []);
	editor.setDecorations(decoSeparator, []);
	log.log(`clearDecorations: ${editor.document.uri.fsPath.split("/").pop()}, ${(performance.now() - t0).toFixed(1)}ms`);
}
