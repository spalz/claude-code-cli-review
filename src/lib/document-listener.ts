// Document listener — clears undo history when document is closed
import * as vscode from "vscode";
import { clearHistory } from "./undo-history";

export function registerDocumentListener(
	context: vscode.ExtensionContext,
): vscode.Disposable {
	const disposable = vscode.workspace.onDidCloseTextDocument((doc) => {
		clearHistory(doc.uri.fsPath);
	});
	context.subscriptions.push(disposable);
	return disposable;
}
