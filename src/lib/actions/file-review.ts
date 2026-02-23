// File review actions — delegates to ReviewManager
import * as vscode from "vscode";
import { execSync } from "child_process";
import * as path from "path";
import * as state from "../state";
import { enterReviewMode } from "../review";
import { log } from "../log";
import type { ReviewManager } from "../review-manager";

let _manager: ReviewManager | null = null;

export function setReviewManager(manager: ReviewManager): void {
	_manager = manager;
}

export function addFileToReview(_workspacePath: string, absFilePath: string): void {
	_manager?.addFile(absFilePath);
}

export async function startReviewSession(workspacePath: string): Promise<void> {
	state.activeReviews.clear();
	state.setReviewFiles([]);
	state.setCurrentFileIndex(0);

	const changedFiles = new Set<string>();

	try {
		const staged = execSync("git diff --name-only --cached", {
			cwd: workspacePath,
			encoding: "utf8",
			timeout: 10000,
			stdio: "pipe",
		}).trim();
		if (staged) {
			staged.split("\n").forEach((f) => changedFiles.add(path.join(workspacePath, f)));
		}
	} catch {}

	try {
		const unstaged = execSync("git diff --name-only HEAD", {
			cwd: workspacePath,
			encoding: "utf8",
			timeout: 10000,
			stdio: "pipe",
		}).trim();
		if (unstaged) {
			unstaged.split("\n").forEach((f) => changedFiles.add(path.join(workspacePath, f)));
		}
	} catch {}

	try {
		const untracked = execSync("git ls-files --others --exclude-standard", {
			cwd: workspacePath,
			encoding: "utf8",
			timeout: 10000,
			stdio: "pipe",
		}).trim();
		if (untracked) {
			untracked.split("\n").forEach((f) => changedFiles.add(path.join(workspacePath, f)));
		}
	} catch {}

	if (changedFiles.size === 0) {
		vscode.window.showInformationMessage("No changes to review.");
		return;
	}

	for (const fp of changedFiles) {
		try {
			await enterReviewMode(fp, workspacePath);
		} catch (e) {
			log(`[ccr] skip ${fp}: ${(e as Error).message}`);
		}
	}

	const reviewable = [...changedFiles].filter((f) => state.activeReviews.has(f));
	if (reviewable.length === 0) {
		vscode.window.showInformationMessage("No reviewable changes found.");
		return;
	}

	state.setReviewFiles(reviewable);
	state.refreshAll();
	await _manager?.openFileForReview(reviewable[0]);
}
