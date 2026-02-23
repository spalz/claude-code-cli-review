// ReviewManager internal types — interfaces for decomposed helper functions
import type * as vscode from "vscode";

export interface ICodeLensProvider {
	refresh(): void;
}

export interface IMainView {
	update(): void;
}

/**
 * Internal interface exposing ReviewManager's private fields to helper modules.
 * Helper functions accept `ReviewManagerInternal` instead of accessing private members directly.
 */
export interface ReviewManagerInternal {
	readonly wp: string;
	reviewFiles: string[];
	currentFileIndex: number;
	currentHunkIndex: number;
	codeLens: ICodeLensProvider | null;
	mainView: IMainView | null;
	persistTimer: NodeJS.Timeout | null;
	readonly _onReviewStateChange: vscode.EventEmitter<boolean>;

	syncState(): void;
	refreshUI(): void;
	scheduleSave(): void;
	openFileForReview(filePath: string): Promise<void>;
}
