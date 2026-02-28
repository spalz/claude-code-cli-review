// Review actions — delegates to ReviewManager
import type { ReviewManager } from "../review-manager";

let _manager: ReviewManager | null = null;

export function setReviewManager(manager: ReviewManager): void {
    _manager = manager;
}

export async function resolveHunk(
    filePath: string,
    hunkId: number,
    accept: boolean,
): Promise<void> {
    await _manager?.resolveHunk(filePath, hunkId, accept);
}

export async function resolveAllHunks(filePath: string, accept: boolean): Promise<void> {
    await _manager?.resolveAllHunks(filePath, accept);
}

export async function openFileForReview(filePath: string): Promise<void> {
    await _manager?.openFileForReview(filePath);
}
