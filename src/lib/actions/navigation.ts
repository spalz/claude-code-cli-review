// Navigation actions — delegates to ReviewManager
import type { ReviewManager } from "../review-manager";

let _manager: ReviewManager | null = null;

export function setReviewManager(manager: ReviewManager): void {
	_manager = manager;
}

export async function navigateHunk(direction: number): Promise<void> {
	_manager?.navigateHunk(direction);
}

export async function keepCurrentFile(): Promise<void> {
	const editor = await import("vscode").then((v) => v.window.activeTextEditor);
	if (!editor) return;
	await _manager?.resolveAllHunks(editor.document.uri.fsPath, true);
}

export async function undoCurrentFile(): Promise<void> {
	const editor = await import("vscode").then((v) => v.window.activeTextEditor);
	if (!editor) return;
	await _manager?.resolveAllHunks(editor.document.uri.fsPath, false);
}

export async function reviewNextUnresolved(): Promise<void> {
	await _manager?.reviewNextUnresolved();
}

export async function navigateFile(direction: number): Promise<void> {
	await _manager?.navigateFile(direction);
}
