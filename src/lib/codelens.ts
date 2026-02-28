// CodeLens provider — clickable Keep/Undo buttons per hunk
import * as vscode from "vscode";
import * as state from "./state";
import * as log from "./log";

export class ReviewCodeLensProvider implements vscode.CodeLensProvider {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChange.event;

	refresh(): void {
		log.log(`CodeLens.refresh: fired`);
		this._onDidChange.fire();
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const t0 = performance.now();
		const review = state.activeReviews.get(document.uri.fsPath);
		if (!review) return [];

		const lenses: vscode.CodeLens[] = [];
		const filePath = document.uri.fsPath;

		for (const range of review.hunkRanges) {
			const hunk = review.hunks.find((h) => h.id === range.hunkId);
			if (!hunk) {
				log.log(`CodeLens: hunk not found for hunkId=${range.hunkId}`);
				continue;
			}
			if (hunk.resolved) {
				log.log(`CodeLens: skip resolved hunk=${range.hunkId}`);
				continue;
			}

			// Place CodeLens on the first line of the hunk (removed lines come first in buffer)
			const lensLine = range.removedStart < range.removedEnd
				? range.removedStart
				: range.addedStart;
			log.log(`CodeLens: hunk=${range.hunkId} removed=${range.removedStart}-${range.removedEnd} added=${range.addedStart}-${range.addedEnd} lensLine=${lensLine} docLines=${document.lineCount}`);

			const lensRange = new vscode.Range(lensLine, 0, lensLine, 0);

			lenses.push(
				new vscode.CodeLens(lensRange, {
					title: "$(check) Keep",
					tooltip: "Accept this change (\u2318Y)",
					command: "ccr.acceptHunk",
					arguments: [filePath, hunk.id],
				}),
			);

			lenses.push(
				new vscode.CodeLens(lensRange, {
					title: "$(discard) Undo",
					tooltip: "Reject this change (\u2318N)",
					command: "ccr.rejectHunk",
					arguments: [filePath, hunk.id],
				}),
			);
		}

		log.log(`CodeLens.provide: ${document.uri.fsPath.split("/").pop()}, ${lenses.length / 2} hunks, ${(performance.now() - t0).toFixed(1)}ms`);
		return lenses;
	}
}
