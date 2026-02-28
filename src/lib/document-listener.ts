// Document listener — clears undo history when document is closed
import * as vscode from "vscode";
import { clearHistory, hasUndoState } from "./undo-history";
import { logCat } from "./log";

export function registerDocumentListener(context: vscode.ExtensionContext): vscode.Disposable {
    const disposable = vscode.workspace.onDidCloseTextDocument((doc) => {
        const fp = doc.uri.fsPath;
        if (hasUndoState(fp)) {
            logCat(
                "resolve",
                `document-listener: CLEARING undo history for closed doc ${fp.split("/").pop()}`,
            );
        }
        clearHistory(fp);
    });
    context.subscriptions.push(disposable);
    return disposable;
}
