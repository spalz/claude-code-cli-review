// Editor utilities — shared helpers for content application modules
import * as vscode from "vscode";
import * as fs from "fs";
import { logCat } from "../log";

/**
 * Save document content to disk without triggering formatOnSave.
 *
 * `doc.save()` runs through the VS Code save pipeline which includes
 * formatOnSave — formatters can add/remove lines, breaking hunk ranges
 * and decorations. Instead, we write directly to disk via fs and use
 * `revert` to clear the dirty flag (content matches disk, so no visible change).
 */
export async function saveWithoutFormatting(doc: vscode.TextDocument): Promise<void> {
	const content = doc.getText();
	fs.writeFileSync(doc.uri.fsPath, content, "utf8");
	// Clear dirty flag: since disk content now matches buffer, revert is a no-op visually
	try {
		await vscode.commands.executeCommand("workbench.action.files.revert");
	} catch {
		// revert may fail if doc is not active — that's ok, dirty flag is cosmetic
		logCat("content",`saveWithoutFormatting: revert failed for ${doc.uri.fsPath}, dirty flag may persist`);
	}
}
