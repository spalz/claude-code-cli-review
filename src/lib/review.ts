// FileReview model + merge/finalize logic
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import type { ChangeType, Hunk, HunkRange, MergedResult, IFileReview } from "../types";
import { computeDiff } from "./diff";
import * as state from "./state";

export class FileReview implements IFileReview {
	mergedLines: string[] = [];
	hunkRanges: HunkRange[] = [];
	changeType: ChangeType;

	constructor(
		public readonly filePath: string,
		public readonly originalContent: string,
		public readonly modifiedContent: string,
		public hunks: Hunk[],
		changeType?: ChangeType,
	) {
		if (changeType) {
			this.changeType = changeType;
		} else if (!originalContent) {
			this.changeType = "create";
		} else if (!modifiedContent) {
			this.changeType = "delete";
		} else {
			this.changeType = "edit";
		}
	}

	get unresolvedCount(): number {
		return this.hunks.filter((h) => !h.resolved).length;
	}

	get isFullyResolved(): boolean {
		return this.hunks.every((h) => h.resolved);
	}
}

export function buildMergedContent(modifiedLines: string[], hunks: Hunk[]): MergedResult {
	const result: string[] = [];
	const ranges: HunkRange[] = [];
	let modIdx = 0;
	const sorted = [...hunks].sort((a, b) => a.modStart - b.modStart);

	for (const hunk of sorted) {
		const modHunkStart = hunk.modStart - 1;

		while (modIdx < modHunkStart && modIdx < modifiedLines.length) {
			result.push(modifiedLines[modIdx]);
			modIdx++;
		}

		if (hunk.resolved) {
			const lines = hunk.accepted ? hunk.added : hunk.removed;
			for (const line of lines) result.push(line);
		} else {
			const removedStart = result.length;
			for (const line of hunk.removed) result.push(line);
			const removedEnd = result.length;

			const addedStart = result.length;
			for (const line of hunk.added) result.push(line);
			const addedEnd = result.length;

			ranges.push({
				hunkId: hunk.id,
				removedStart,
				removedEnd,
				addedStart,
				addedEnd,
			});
		}
		modIdx += hunk.added.length;
	}

	while (modIdx < modifiedLines.length) {
		result.push(modifiedLines[modIdx]);
		modIdx++;
	}

	return { lines: result, ranges };
}

export async function enterReviewMode(
	filePath: string,
	workspacePath: string,
): Promise<FileReview | null> {
	let originalContent = "";
	const relPath = path.relative(workspacePath, filePath);
	try {
		originalContent = execSync(`git show HEAD:"${relPath}"`, {
			cwd: workspacePath,
			encoding: "utf8",
			timeout: 5000,
			stdio: "pipe",
		});
	} catch {}

	let modifiedContent = "";
	try {
		modifiedContent = fs.readFileSync(filePath, "utf8");
	} catch {
		return null;
	}

	return createReview(filePath, originalContent, modifiedContent, workspacePath);
}

export function createReview(
	filePath: string,
	originalContent: string,
	modifiedContent: string,
	workspacePath: string,
): FileReview | null {
	if (originalContent === modifiedContent) return null;

	const hunks = computeDiff(originalContent, modifiedContent, filePath, workspacePath);
	if (hunks.length === 0) return null;

	const modLines = modifiedContent.split("\n");
	const { lines, ranges } = buildMergedContent(modLines, hunks);

	const review = new FileReview(filePath, originalContent, modifiedContent, hunks);
	review.mergedLines = lines;
	review.hunkRanges = ranges;
	state.activeReviews.set(filePath, review);
	return review;
}

export function buildFinalContent(review: IFileReview): string {
	const allAccepted = review.hunks.every((h) => h.accepted);
	if (allAccepted) return review.modifiedContent;

	const allRejected = review.hunks.every((h) => !h.accepted);
	if (allRejected) return review.originalContent;

	const origLines = review.originalContent.split("\n");
	const result: string[] = [];
	let oi = 0;

	for (const hunk of review.hunks) {
		const origHunkStart = hunk.origStart - 1;
		while (oi < origHunkStart) {
			result.push(origLines[oi]);
			oi++;
		}
		const lines = hunk.accepted ? hunk.added : hunk.removed;
		for (const line of lines) result.push(line);
		oi += hunk.removed.length;
	}

	while (oi < origLines.length) {
		result.push(origLines[oi]);
		oi++;
	}
	return result.join("\n");
}

export function rebuildMerged(review: FileReview): void {
	const modLines = review.modifiedContent.split("\n");
	const { lines, ranges } = buildMergedContent(modLines, review.hunks);
	review.mergedLines = lines;
	review.hunkRanges = ranges;
}
