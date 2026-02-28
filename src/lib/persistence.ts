// Persistence — save/restore review state across reloads
import * as fs from "fs";
import * as path from "path";
import * as log from "./log";
import type { PersistedReviewState, PersistedFileReview } from "../types";
import type { IFileReview } from "../types";

const STATE_FILENAME = "review-state.json";

function getStatePath(workspacePath: string): string {
    return path.join(workspacePath, ".claude", STATE_FILENAME);
}

export function saveReviewState(
    workspacePath: string,
    reviews: Map<string, IFileReview>,
    currentFileIndex: number,
): void {
    const files: PersistedFileReview[] = [];
    for (const [, review] of reviews) {
        files.push({
            filePath: review.filePath,
            originalContent: review.originalContent,
            modifiedContent: review.modifiedContent,
            hunks: review.hunks,
            changeType: review.changeType,
            sessionId: review.sessionId,
        });
    }

    const state: PersistedReviewState = {
        version: 1,
        timestamp: Date.now(),
        files,
        currentFileIndex,
    };

    const statePath = getStatePath(workspacePath);
    const tmpPath = statePath + ".tmp";

    try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(tmpPath, JSON.stringify(state), "utf8");
        fs.renameSync(tmpPath, statePath);
        log.log(`persistence: saved ${files.length} files`);
    } catch (err) {
        log.log(`persistence: save error: ${(err as Error).message}`);
        try {
            fs.unlinkSync(tmpPath);
        } catch {}
    }
}

export function loadReviewState(workspacePath: string): PersistedReviewState | null {
    const statePath = getStatePath(workspacePath);
    try {
        const raw = fs.readFileSync(statePath, "utf8");
        const state = JSON.parse(raw) as PersistedReviewState;
        if (state.version !== 1 || !Array.isArray(state.files)) {
            log.log("persistence: invalid state version or format");
            return null;
        }
        log.log(`persistence: loaded ${state.files.length} files`);
        return state;
    } catch {
        return null;
    }
}

export function clearReviewState(workspacePath: string): void {
    const statePath = getStatePath(workspacePath);
    try {
        fs.unlinkSync(statePath);
        log.log("persistence: cleared");
    } catch {}
}
