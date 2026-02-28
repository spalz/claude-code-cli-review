// Queries — read-only accessors for review state
import * as state from "../state";
import type { ReviewManagerInternal } from "./types";

export function getReview(filePath: string) {
    return state.activeReviews.get(filePath);
}

export function getUnresolvedFiles(mgr: ReviewManagerInternal): string[] {
    return mgr.reviewFiles.filter((f) => state.activeReviews.has(f));
}

export function hasActiveReview(): boolean {
    return state.activeReviews.size > 0;
}

export function getReviewFiles(mgr: ReviewManagerInternal): string[] {
    return mgr.reviewFiles;
}

export function getCurrentFileIndex(mgr: ReviewManagerInternal): number {
    return mgr.currentFileIndex;
}

export function getCurrentHunkIndex(mgr: ReviewManagerInternal): number {
    return mgr.currentHunkIndex;
}
