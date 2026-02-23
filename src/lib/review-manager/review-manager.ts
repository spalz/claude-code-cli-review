// ReviewManager — central orchestrator for review lifecycle (thin delegation layer)
import * as vscode from "vscode";
import * as fs from "fs";
import * as log from "../log";
import * as state from "../state";
import { saveReviewState } from "../persistence";
import { clearAllHistories } from "../undo-history";
import type { ICodeLensProvider, IMainView, ReviewManagerInternal } from "./types";
import { addFile as addFileImpl } from "./file-addition";
import { applyContentViaEdit } from "./content-application";
import { resolveHunk as resolveHunkImpl, resolveAllHunks as resolveAllHunksImpl } from "./hunk-resolution";
import { navigateHunk as navigateHunkImpl, navigateFile as navigateFileImpl, reviewNextUnresolved as reviewNextUnresolvedImpl, openCurrentOrNext as openCurrentOrNextImpl, openFileForReview as openFileForReviewImpl } from "./navigation";
import { undoResolve as undoResolveImpl, redoResolve as redoResolveImpl, restoreFromSnapshot as restoreFromSnapshotImpl } from "./undo-redo";
import { restore as restoreImpl } from "./persistence";
import * as queries from "./queries";
import type { ReviewSnapshot } from "../../types";

export class ReviewManager implements vscode.Disposable {
	reviewFiles: string[] = [];
	currentFileIndex = 0;
	currentHunkIndex = 0;
	persistTimer: NodeJS.Timeout | null = null;
	codeLens: ICodeLensProvider | null = null;
	mainView: IMainView | null = null;
	readonly _onReviewStateChange = new vscode.EventEmitter<boolean>();
	readonly onReviewStateChange = this._onReviewStateChange.event;

	constructor(readonly wp: string) {}

	// --- Internal interface cast ---
	private get internal(): ReviewManagerInternal { return this; }

	// --- Providers ---
	setProviders(codeLens: ICodeLensProvider, mainView: IMainView): void {
		this.codeLens = codeLens;
		this.mainView = mainView;
	}

	// --- File addition ---
	async addFile(absFilePath: string): Promise<void> { await addFileImpl(this.internal, absFilePath); }

	// --- Content validation ---
	async ensureMergedContent(filePath: string): Promise<void> {
		const review = state.activeReviews.get(filePath);
		if (!review) return;
		const editor = vscode.window.visibleTextEditors.find(
			(e) => e.document.uri.fsPath === filePath,
		);
		if (!editor) return;
		const mergedContent = review.mergedLines.join("\n");
		if (editor.document.getText() !== mergedContent) {
			log.log(`ensureMergedContent: content mismatch for ${filePath}, reapplying`);
			await applyContentViaEdit(this.internal, filePath, mergedContent);
		}
	}

	// --- Resolve hunks ---
	async resolveHunk(filePath: string, hunkId: number, accept: boolean): Promise<void> {
		await resolveHunkImpl(this.internal, filePath, hunkId, accept);
	}
	async resolveAllHunks(filePath: string, accept: boolean): Promise<void> {
		await resolveAllHunksImpl(this.internal, filePath, accept);
	}

	// --- Navigation ---
	navigateHunk(delta: number): void { navigateHunkImpl(this.internal, delta); }
	async navigateFile(delta: number): Promise<void> { await navigateFileImpl(this.internal, delta); }
	async reviewNextUnresolved(): Promise<void> { await reviewNextUnresolvedImpl(this.internal); }
	async openCurrentOrNext(): Promise<void> { await openCurrentOrNextImpl(this.internal); }
	async openFileForReview(filePath: string): Promise<void> { await openFileForReviewImpl(this.internal, filePath); }

	// --- Undo/Redo ---
	async undoResolve(): Promise<void> { await undoResolveImpl(this.internal); }
	async redoResolve(): Promise<void> { await redoResolveImpl(this.internal); }
	restoreFromSnapshot(fsPath: string, snapshot: ReviewSnapshot): void {
		restoreFromSnapshotImpl(this.internal, fsPath, snapshot);
	}

	// --- Queries ---
	getReview(filePath: string) { return queries.getReview(filePath); }
	getUnresolvedFiles(): string[] { return queries.getUnresolvedFiles(this.internal); }
	get hasActiveReview(): boolean { return queries.hasActiveReview(); }
	getReviewFiles(): string[] { return queries.getReviewFiles(this.internal); }
	getCurrentFileIndex(): number { return queries.getCurrentFileIndex(this.internal); }
	getCurrentHunkIndex(): number { return queries.getCurrentHunkIndex(this.internal); }

	// --- Persistence ---
	scheduleSave(): void {
		if (this.persistTimer) clearTimeout(this.persistTimer);
		this.persistTimer = setTimeout(() => {
			saveReviewState(this.wp, state.activeReviews, this.currentFileIndex);
		}, 500);
	}

	saveNow(): void {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		saveReviewState(this.wp, state.activeReviews, this.currentFileIndex);
	}

	async restore(): Promise<boolean> { return restoreImpl(this.internal); }

	// --- State sync ---
	syncState(): void {
		state.setReviewFiles(this.reviewFiles);
		state.setCurrentFileIndex(this.currentFileIndex);
		state.setCurrentHunkIndex(this.currentHunkIndex);
	}

	refreshUI(): void {
		this.codeLens?.refresh();
		this.mainView?.update();
		state.refreshReview();
	}

	// --- Disposal ---
	dispose(): void {
		const count = state.activeReviews.size;
		log.log(`ReviewManager.dispose: restoring ${count} files to modifiedContent`);
		for (const [fp, review] of state.activeReviews) {
			try {
				fs.writeFileSync(fp, review.modifiedContent, "utf8");
				log.log(`ReviewManager.dispose: restored ${fp}`);
			} catch {}
		}
		this.saveNow();
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		clearAllHistories();
		this._onReviewStateChange.dispose();
	}
}
