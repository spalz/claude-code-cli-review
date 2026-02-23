// CodeLens provider — clickable Keep/Undo buttons per hunk + file navigation
import * as vscode from "vscode";
import * as state from "./state";

export class ReviewCodeLensProvider implements vscode.CodeLensProvider {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChange.event;

	refresh(): void {
		this._onDidChange.fire();
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const review = state.activeReviews.get(document.uri.fsPath);
		if (!review) return [];

		const lenses: vscode.CodeLens[] = [];
		const filePath = document.uri.fsPath;
		const unresolvedRanges = review.hunkRanges.filter((range) => {
			const hunk = review.hunks.find((h) => h.id === range.hunkId);
			return hunk && !hunk.resolved;
		});

		let hunkIdx = 0;
		for (const range of review.hunkRanges) {
			const hunk = review.hunks.find((h) => h.id === range.hunkId);
			if (!hunk || hunk.resolved) continue;
			hunkIdx++;

			// Place CodeLens on the first line of the hunk (removed or added)
			const line = range.removedStart < range.removedEnd
				? range.removedStart
				: range.addedStart;
			const lensRange = new vscode.Range(line, 0, line, 0);

			// Keep button
			lenses.push(
				new vscode.CodeLens(lensRange, {
					title: "$(check) Keep",
					tooltip: "Accept this change (⌘Y)",
					command: "ccr.acceptHunk",
					arguments: [filePath, hunk.id],
				}),
			);

			// Undo button
			lenses.push(
				new vscode.CodeLens(lensRange, {
					title: "$(discard) Undo",
					tooltip: "Reject this change (⌘N)",
					command: "ccr.rejectHunk",
					arguments: [filePath, hunk.id],
				}),
			);

			// Hunk counter (if multiple)
			if (unresolvedRanges.length > 1) {
				lenses.push(
					new vscode.CodeLens(lensRange, {
						title: `${hunkIdx}/${unresolvedRanges.length}`,
						tooltip: `Change ${hunkIdx} of ${unresolvedRanges.length}`,
						command: "",
					}),
				);
			}
		}

		// "Review next file ›" after last hunk if more files remain
		const remaining = state.getReviewFiles().filter((f) => state.activeReviews.has(f));
		if (remaining.length > 1) {
			const lastRange = unresolvedRanges[unresolvedRanges.length - 1];
			if (lastRange) {
				const lastLine = Math.min(
					(lastRange.addedEnd > 0 ? lastRange.addedEnd : lastRange.removedEnd),
					document.lineCount - 1,
				);
				lenses.push(
					new vscode.CodeLens(new vscode.Range(lastLine, 0, lastLine, 0), {
						title: `$(arrow-right) Next file (${remaining.length - 1} remaining)`,
						tooltip: "Open the next file with unresolved changes",
						command: "ccr.reviewNextUnresolved",
					}),
				);
			}
		}

		return lenses;
	}
}
