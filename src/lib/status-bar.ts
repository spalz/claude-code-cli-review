// Review StatusBar — single "Review next file" button
import * as vscode from "vscode";
import * as state from "./state";
import * as log from "./log";

let reviewItem: vscode.StatusBarItem = undefined!;
let _editorDisposable: vscode.Disposable | undefined;

export function createReviewStatusBar(
	context: vscode.ExtensionContext,
	_workspacePath: string,
): void {
	reviewItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5);
	reviewItem.command = "ccr.reviewNextUnresolved";
	context.subscriptions.push(reviewItem);

	_editorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
		updateReviewStatusBar();
	});
	context.subscriptions.push(_editorDisposable);

	log.log("Review StatusBar created");
}

export function updateReviewStatusBar(): void {
	const files = state.getReviewFiles();
	const remaining = files.filter((f) => state.activeReviews.has(f));

	if (remaining.length === 0) {
		reviewItem.hide();
		return;
	}

	reviewItem.text = `$(play) Review next file (${remaining.length} remaining)`;
	reviewItem.tooltip = "Open the next file with unresolved changes";
	reviewItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
	reviewItem.show();
}

export function dispose(): void {
	_editorDisposable?.dispose();
}
