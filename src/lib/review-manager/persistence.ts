// Persistence — restore review state from disk
import * as fs from "fs";
import * as log from "../log";
import * as state from "../state";
import { loadReviewState } from "../persistence";
import { FileReview, buildMergedContent } from "../review";
import type { ReviewManagerInternal } from "./types";

export async function restore(mgr: ReviewManagerInternal): Promise<boolean> {
	const saved = loadReviewState(mgr.wp);
	if (!saved || saved.files.length === 0) return false;

	log.log(`ReviewManager.restore: restoring ${saved.files.length} files`);

	for (const pf of saved.files) {
		// Check file still exists for edit/create types
		if (pf.changeType !== "delete" && !fs.existsSync(pf.filePath)) {
			log.log(`ReviewManager.restore: skip missing file ${pf.filePath}`);
			continue;
		}

		const review = new FileReview(
			pf.filePath,
			pf.originalContent,
			pf.modifiedContent,
			pf.hunks,
			pf.changeType,
		);
		// For delete reviews, modifiedContent is "" — use empty array to match handleDeletion behavior
		const modLines = pf.changeType === "delete" ? [] : pf.modifiedContent.split("\n");
		const { lines, ranges } = buildMergedContent(modLines, pf.hunks);
		review.mergedLines = lines;
		review.hunkRanges = ranges;
		state.activeReviews.set(pf.filePath, review);
		mgr.reviewFiles.push(pf.filePath);
	}

	mgr.currentFileIndex = Math.min(saved.currentFileIndex, mgr.reviewFiles.length - 1);
	mgr.syncState();
	mgr.refreshUI();
	mgr._onReviewStateChange.fire(mgr.reviewFiles.length > 0);
	return mgr.reviewFiles.length > 0;
}
