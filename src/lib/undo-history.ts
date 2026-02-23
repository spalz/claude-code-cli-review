// Undo history — stack-based undo/redo for review hunk operations
import * as vscode from "vscode";
import * as log from "./log";
import type { ReviewSnapshot, IFileReview } from "../types";

type Snapshotable = IFileReview | ReviewSnapshot;

interface FileHistory {
	undoStack: ReviewSnapshot[];
	redoStack: ReviewSnapshot[];
	applyingEdit: boolean;
}

const histories = new Map<string, FileHistory>();

function hunkSummary(hunks: { id: number; resolved: boolean }[]): string {
	return hunks.map((h) => `${h.id}:${h.resolved ? "R" : "U"}`).join(",");
}

function deepSnapshot(review: Snapshotable): ReviewSnapshot {
	return {
		filePath: review.filePath,
		originalContent: review.originalContent,
		modifiedContent: review.modifiedContent,
		changeType: review.changeType,
		hunks: JSON.parse(JSON.stringify(review.hunks)),
		mergedLines: [...review.mergedLines],
		hunkRanges: review.hunkRanges.map((r) => ({ ...r })),
	};
}

export function initHistory(fsPath: string): void {
	if (!histories.has(fsPath)) {
		histories.set(fsPath, { undoStack: [], redoStack: [], applyingEdit: false });
		log.log(`undo-history: init for ${fsPath}`);
	}
}

export function pushUndoState(fsPath: string, review: Snapshotable): void {
	const hist = histories.get(fsPath);
	if (!hist) return;
	hist.undoStack.push(deepSnapshot(review));
	hist.redoStack.length = 0; // clear redo on new action
	const unresolvedCount = review.hunks.filter((h) => !h.resolved).length;
	log.log(`undo-history: push undo, stack=${hist.undoStack.length}, hunks=[${hunkSummary(review.hunks)}] for ${fsPath}`);
	updateContextKeys();
}

export function popUndoState(fsPath: string): ReviewSnapshot | undefined {
	const hist = histories.get(fsPath);
	if (!hist || hist.undoStack.length === 0) return undefined;
	const snapshot = hist.undoStack.pop()!;
	log.log(`undo-history: pop undo, remaining=${hist.undoStack.length}, hunks=[${hunkSummary(snapshot.hunks)}] for ${fsPath}`);
	updateContextKeys();
	return snapshot;
}

export function pushRedoState(fsPath: string, review: Snapshotable): void {
	const hist = histories.get(fsPath);
	if (!hist) return;
	hist.redoStack.push(deepSnapshot(review));
	log.log(`undo-history: push redo, stack=${hist.redoStack.length} for ${fsPath}`);
	updateContextKeys();
}

export function popRedoState(fsPath: string): ReviewSnapshot | undefined {
	const hist = histories.get(fsPath);
	if (!hist || hist.redoStack.length === 0) return undefined;
	const snapshot = hist.redoStack.pop()!;
	log.log(`undo-history: pop redo, remaining=${hist.redoStack.length} for ${fsPath}`);
	updateContextKeys();
	return snapshot;
}

export function hasUndoState(fsPath: string): boolean {
	return (histories.get(fsPath)?.undoStack.length ?? 0) > 0;
}

export function hasRedoState(fsPath: string): boolean {
	return (histories.get(fsPath)?.redoStack.length ?? 0) > 0;
}

export function setApplyingEdit(fsPath: string, value: boolean): void {
	const hist = histories.get(fsPath);
	if (hist) hist.applyingEdit = value;
}

export function isApplyingEdit(fsPath: string): boolean {
	return histories.get(fsPath)?.applyingEdit ?? false;
}

export function clearHistory(fsPath: string): void {
	const hist = histories.get(fsPath);
	const count = hist ? hist.undoStack.length + hist.redoStack.length : 0;
	histories.delete(fsPath);
	if (count > 0) log.log(`undo-history: cleared ${count} entries for ${fsPath}`);
	updateContextKeys();
}

export function clearAllHistories(): void {
	const totalFiles = histories.size;
	histories.clear();
	if (totalFiles > 0) log.log(`undo-history: cleared all histories (${totalFiles} files)`);
	updateContextKeys();
}

function updateContextKeys(): void {
	// Check if ANY file has undo/redo available
	let canUndo = false;
	let canRedo = false;
	for (const hist of histories.values()) {
		if (hist.undoStack.length > 0) canUndo = true;
		if (hist.redoStack.length > 0) canRedo = true;
		if (canUndo && canRedo) break;
	}
	vscode.commands.executeCommand("setContext", "ccr.canUndoReview", canUndo);
	vscode.commands.executeCommand("setContext", "ccr.canRedoReview", canRedo);
}
