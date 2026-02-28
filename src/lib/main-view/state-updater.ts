import * as vscode from "vscode";
import * as path from "path";
import * as state from "../state";
import * as log from "../log";
import { hasUndoState, hasRedoState } from "../undo-history";
import type { PtyManager } from "../pty-manager";
import type { ReviewManager } from "../review-manager";
import type {
	KeybindingInfo,
	ReviewStateUpdate,
	ReviewFileInfo,
	PtySessionInfo,
} from "../../types";

export interface StateUpdatePayload {
	review: ReviewStateUpdate;
	activeSessions: PtySessionInfo[];
}

export function buildStateUpdate(
	wp: string,
	ptyManager: PtyManager,
	reviewManager?: ReviewManager,
): StateUpdatePayload {
	const files = state.getReviewFiles();
	const idx = state.getCurrentFileIndex();
	const remaining = files.filter((f) => state.activeReviews.has(f)).length;
	const currentFile = files[idx];
	const review = currentFile ? state.activeReviews.get(currentFile) : undefined;

	// Determine if the active editor is a file under review.
	// During file transitions (finalize → open next), activeTextEditor may lag behind
	// the ReviewManager state. Trust the manager: if transitioning and files remain,
	// we're opening one — report true to prevent toolbar flash to "Review next file".
	const activeEditor = vscode.window.activeTextEditor;
	const activeEditorPath = activeEditor?.document.uri.fsPath;
	const activeEditorInReview = reviewManager?.isTransitioning
		? remaining > 0
		: (activeEditorPath ? state.activeReviews.has(activeEditorPath) : false);

	// Compute undo/redo availability across all review files
	let canUndo = false;
	let canRedo = false;
	for (const f of files) {
		if (state.activeReviews.has(f)) {
			if (hasUndoState(f)) canUndo = true;
			if (hasRedoState(f)) canRedo = true;
			if (canUndo && canRedo) break;
		}
	}

	// Current hunk index from review manager
	const currentHunkIndex = reviewManager ? reviewManager.getCurrentHunkIndex() : 0;
	const currentFileIndex = reviewManager ? reviewManager.getCurrentFileIndex() : idx;

	// Count unresolved files
	const unresolvedFileCount = files.filter((f) => state.activeReviews.has(f)).length;

	const fileList: ReviewFileInfo[] = files.map((f, i) => {
		const r = state.activeReviews.get(f);
		const relName = path.relative(wp, f);
		const isExternal = relName.startsWith("..");
		return {
			path: f,
			name: isExternal ? f : relName,
			external: isExternal,
			active: i === idx,
			done: !r,
			unresolved: r ? r.unresolvedCount : 0,
			total: r ? r.hunks.length : 0,
			sessionId: r?.sessionId,
		};
	});

	return {
		review: {
			remaining,
			total: files.length,
			currentFile: currentFile ? path.relative(wp, currentFile) : null,
			unresolvedHunks: review ? review.unresolvedCount : 0,
			totalHunks: review ? review.hunks.length : 0,
			files: fileList,
			currentHunkIndex,
			currentFileIndex,
			unresolvedFileCount,
			canUndo,
			canRedo,
			activeEditorInReview,
		},
		activeSessions: ptyManager.getSessions(),
	};
}

export function getKeybindings(): KeybindingInfo[] {
	const isMac = process.platform === "darwin";
	const ext = vscode.extensions.getExtension("local.claude-code-review");
	const bindings: Array<{
		key: string;
		mac?: string;
		command: string;
	}> = ext?.packageJSON?.contributes?.keybindings || [];

	const descriptions: Record<string, string> = {
		"ccr.togglePanel": "Toggle panel",
		"ccr.sendSelection": "Send selection to active session",
		"ccr.acceptHunk": "Accept change",
		"ccr.rejectHunk": "Reject change",
		"ccr.nextHunk": "Next change",
		"ccr.prevHunk": "Previous change",
		"ccr.undo": "Undo review action",
		"ccr.redo": "Redo review action",
	};

	log.log(`_getKeybindings: found ${bindings.length} bindings, isMac=${isMac}`);

	return bindings.map((b) => ({
		key: formatKey(isMac ? b.mac || b.key : b.key),
		desc: descriptions[b.command] || b.command,
	}));
}

export function formatKey(keyStr: string): string {
	const isMac = process.platform === "darwin";
	const parts = keyStr.toLowerCase().split("+");

	const modMap: Record<string, string> = isMac
		? { ctrl: "\u2303", alt: "\u2325", shift: "\u21E7", cmd: "\u2318", meta: "\u2318" }
		: { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Win", meta: "Win" };

	const mods: string[] = [];
	let main = "";

	for (const p of parts) {
		if (modMap[p]) {
			mods.push(modMap[p]);
		} else {
			main = p.toUpperCase();
		}
	}

	return isMac ? mods.join("") + main : [...mods, main].join("+");
}
