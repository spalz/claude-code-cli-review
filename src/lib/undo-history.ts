// Undo history — stack-based undo/redo for review hunk operations
import * as vscode from "vscode";
import * as log from "./log";
import type { ReviewSnapshot, IFileReview } from "../types";

/** Maximum undo/redo depth per file to prevent memory leaks */
const MAX_UNDO_DEPTH = 50;

type Snapshotable = IFileReview | ReviewSnapshot;

interface FileHistory {
	undoStack: ReviewSnapshot[];
	redoStack: ReviewSnapshot[];
	applyingEdit: boolean;
}

/** Global cross-file undo/redo order tracking */
interface GlobalEntry {
	filePath: string;
	timestamp: number;
}

const histories = new Map<string, FileHistory>();
const globalUndoOrder: GlobalEntry[] = [];
const globalRedoOrder: GlobalEntry[] = [];

function hunkSummary(hunks: { id: number; resolved: boolean }[]): string {
	return hunks.map((h) => `${h.id}:${h.resolved ? "R" : "U"}`).join(",");
}

function cloneHunks(hunks: Snapshotable["hunks"]): ReviewSnapshot["hunks"] {
	return hunks.map((h) => ({
		id: h.id,
		origStart: h.origStart,
		origCount: h.origCount,
		modStart: h.modStart,
		modCount: h.modCount,
		removed: [...h.removed],
		added: [...h.added],
		resolved: h.resolved,
		accepted: h.accepted,
	}));
}

function deepSnapshot(review: Snapshotable): ReviewSnapshot {
	return {
		filePath: review.filePath,
		originalContent: review.originalContent,
		modifiedContent: review.modifiedContent,
		changeType: review.changeType,
		hunks: cloneHunks(review.hunks),
		mergedLines: [...review.mergedLines],
		hunkRanges: review.hunkRanges.map((r) => ({ ...r })),
	};
}

/** Enforce stack depth limit by evicting oldest entries */
function enforceLimit(stack: ReviewSnapshot[]): void {
	while (stack.length > MAX_UNDO_DEPTH) {
		stack.shift();
	}
}

export function initHistory(fsPath: string): void {
	if (!histories.has(fsPath)) {
		histories.set(fsPath, { undoStack: [], redoStack: [], applyingEdit: false });
		log.log(`undo-history: init for ${fsPath}`);
	}
}

export function pushUndoState(fsPath: string, review: Snapshotable, preserveRedo = false): void {
	if (!histories.has(fsPath)) {
		initHistory(fsPath);
	}
	const hist = histories.get(fsPath)!;
	hist.undoStack.push(deepSnapshot(review));
	enforceLimit(hist.undoStack);
	if (!preserveRedo) {
		hist.redoStack.length = 0;
		// Clear global redo entries for this file
		for (let i = globalRedoOrder.length - 1; i >= 0; i--) {
			if (globalRedoOrder[i].filePath === fsPath) globalRedoOrder.splice(i, 1);
		}
	}

	// Track in global order
	globalUndoOrder.push({ filePath: fsPath, timestamp: Date.now() });
	enforceGlobalLimit(globalUndoOrder);

	log.log(`undo-history: push undo, stack=${hist.undoStack.length}, hunks=[${hunkSummary(review.hunks)}] for ${fsPath}`);
	updateContextKeys();
}

export function popUndoState(fsPath: string): ReviewSnapshot | undefined {
	const hist = histories.get(fsPath);
	if (!hist || hist.undoStack.length === 0) return undefined;
	const snapshot = hist.undoStack.pop()!;

	// Remove last global entry for this file
	for (let i = globalUndoOrder.length - 1; i >= 0; i--) {
		if (globalUndoOrder[i].filePath === fsPath) {
			globalUndoOrder.splice(i, 1);
			break;
		}
	}

	log.log(`undo-history: pop undo, remaining=${hist.undoStack.length}, hunks=[${hunkSummary(snapshot.hunks)}] for ${fsPath}`);
	updateContextKeys();
	return snapshot;
}

export function pushRedoState(fsPath: string, review: Snapshotable): void {
	const hist = histories.get(fsPath);
	if (!hist) return;
	hist.redoStack.push(deepSnapshot(review));
	enforceLimit(hist.redoStack);

	globalRedoOrder.push({ filePath: fsPath, timestamp: Date.now() });
	enforceGlobalLimit(globalRedoOrder);

	log.log(`undo-history: push redo, stack=${hist.redoStack.length} for ${fsPath}`);
	updateContextKeys();
}

export function popRedoState(fsPath: string): ReviewSnapshot | undefined {
	const hist = histories.get(fsPath);
	if (!hist || hist.redoStack.length === 0) return undefined;
	const snapshot = hist.redoStack.pop()!;

	for (let i = globalRedoOrder.length - 1; i >= 0; i--) {
		if (globalRedoOrder[i].filePath === fsPath) {
			globalRedoOrder.splice(i, 1);
			break;
		}
	}

	log.log(`undo-history: pop redo, remaining=${hist.redoStack.length} for ${fsPath}`);
	updateContextKeys();
	return snapshot;
}

/** Get the file path of the most recent global undo entry */
export function getLastUndoFilePath(): string | undefined {
	return globalUndoOrder.length > 0
		? globalUndoOrder[globalUndoOrder.length - 1].filePath
		: undefined;
}

/** Get the file path of the most recent global redo entry */
export function getLastRedoFilePath(): string | undefined {
	return globalRedoOrder.length > 0
		? globalRedoOrder[globalRedoOrder.length - 1].filePath
		: undefined;
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

	// Remove from global stacks
	for (let i = globalUndoOrder.length - 1; i >= 0; i--) {
		if (globalUndoOrder[i].filePath === fsPath) globalUndoOrder.splice(i, 1);
	}
	for (let i = globalRedoOrder.length - 1; i >= 0; i--) {
		if (globalRedoOrder[i].filePath === fsPath) globalRedoOrder.splice(i, 1);
	}

	if (count > 0) log.log(`undo-history: cleared ${count} entries for ${fsPath}`);
	updateContextKeys();
}

export function clearAllHistories(): void {
	const totalFiles = histories.size;
	histories.clear();
	globalUndoOrder.length = 0;
	globalRedoOrder.length = 0;
	if (totalFiles > 0) log.log(`undo-history: cleared all histories (${totalFiles} files)`);
	updateContextKeys();
}

function enforceGlobalLimit(stack: GlobalEntry[]): void {
	while (stack.length > MAX_UNDO_DEPTH * 2) {
		stack.shift();
	}
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
	log.log(`undo-history: updateContextKeys — ccr.canUndoReview=${canUndo}, ccr.canRedoReview=${canRedo}, totalFiles=${histories.size}`);
	vscode.commands.executeCommand("setContext", "ccr.canUndoReview", canUndo);
	vscode.commands.executeCommand("setContext", "ccr.canRedoReview", canRedo);
}
