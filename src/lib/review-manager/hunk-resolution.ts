// Hunk resolution — accept/reject individual or all hunks, finalize files
import * as vscode from "vscode";
import * as fs from "fs";
import { log, logCat } from "../log";
import * as state from "../state";
import { buildFinalContent, rebuildMerged } from "../review";
import { clearDecorations } from "../decorations";
import { pushUndoState, hasUndoState, hasRedoState } from "../undo-history";
import { clearReviewState } from "../persistence";
import { FileReview } from "../review";
import { applyContentViaEdit } from "./content-application";
import type { ReviewManagerInternal } from "./types";

export async function resolveHunk(
    mgr: ReviewManagerInternal,
    filePath: string,
    hunkId: number,
    accept: boolean,
): Promise<void> {
    const tResolve = performance.now();
    const review = state.activeReviews.get(filePath);
    if (!review) return;
    const hunk = review.hunks.find((h) => h.id === hunkId);
    if (!hunk || hunk.resolved) return;

    const fname = filePath.split("/").pop();
    const preHunkState = review.hunks.map((h) => `${h.id}:${h.resolved ? "R" : "U"}`).join(",");
    logCat(
        "resolve",
        `ReviewManager.resolveHunk: START ${fname} hunkId=${hunkId} accept=${accept}, hunks=[${preHunkState}]`,
    );
    pushUndoState(filePath, review);

    hunk.resolved = true;
    hunk.accepted = accept;
    const postHunkState = review.hunks
        .map((h) => `${h.id}:${h.resolved ? (h.accepted ? "A" : "R") : "U"}`)
        .join(",");
    logCat(
        "resolve",
        `ReviewManager.resolveHunk: file=${filePath}, hunkId=${hunkId}, accept=${accept}, remaining=${review.unresolvedCount}, hunks=[${postHunkState}]`,
    );

    if (review.isFullyResolved) {
        logCat("resolve", `ReviewManager.resolveHunk: all hunks resolved, finalizing ${filePath}`);
        await finalizeFile(mgr, filePath);
    } else {
        logCat(
            "resolve",
            `ReviewManager.resolveHunk: pre-rebuild mergedLines=${review.mergedLines.length}, ranges=${review.hunkRanges.length}`,
        );
        rebuildMerged(review as FileReview);
        const newCount = review.hunkRanges.length;
        logCat(
            "resolve",
            `ReviewManager.resolveHunk: post-rebuild mergedLines=${review.mergedLines.length}, ranges=${newCount}`,
        );
        if (mgr.currentHunkIndex >= newCount) {
            mgr.currentHunkIndex = Math.max(0, newCount - 1);
        }
        // Reveal the next unresolved hunk to prevent scroll jumping
        const nextRange = review.hunkRanges[mgr.currentHunkIndex];
        const revealLine = nextRange
            ? nextRange.removedStart < nextRange.removedEnd
                ? nextRange.removedStart
                : nextRange.addedStart
            : undefined;

        // Both removed and added lines are in the buffer (inline diff).
        // Always use full-buffer replace via applyContentViaEdit — it has
        // its own minimal-diff logic that avoids CodeLens flash on unchanged hunks.
        logCat("resolve", `resolveHunk: applying full-buffer replace for ${filePath}`);
        await applyContentViaEdit(mgr, filePath, review.mergedLines.join("\n"), revealLine);
    }
    mgr.scheduleSave();
    logCat(
        "resolve",
        `ReviewManager.resolveHunk: END ${fname} hunkId=${hunkId}, total=${(performance.now() - tResolve).toFixed(1)}ms`,
    );
}

export async function resolveAllHunks(
    mgr: ReviewManagerInternal,
    filePath: string,
    accept: boolean,
): Promise<void> {
    const review = state.activeReviews.get(filePath);
    if (!review) return;
    const unresolvedCount = review.hunks.filter((h) => !h.resolved).length;
    logCat(
        "resolve",
        `resolveAllHunks: START ${filePath}, accept=${accept}, totalHunks=${review.hunks.length}, unresolved=${unresolvedCount}`,
    );
    pushUndoState(filePath, review);
    for (const h of review.hunks) {
        if (!h.resolved) {
            h.resolved = true;
            h.accepted = accept;
        }
    }
    logCat(
        "resolve",
        `resolveAllHunks: all ${unresolvedCount} hunks marked ${accept ? "accepted" : "rejected"}, finalizing`,
    );
    await finalizeFile(mgr, filePath);
    mgr.scheduleSave();
}

export async function finalizeFile(mgr: ReviewManagerInternal, filePath: string): Promise<void> {
    const review = state.activeReviews.get(filePath);
    if (!review) return;

    const changeType = review.changeType;
    const allRejected = review.hunks.every((h) => !h.accepted);
    const allAccepted = review.hunks.every((h) => h.accepted);
    logCat(
        "resolve",
        `ReviewManager.finalizeFile: ${filePath}, type=${changeType}, allAccepted=${allAccepted}, allRejected=${allRejected}`,
    );

    state.activeReviews.delete(filePath);
    logCat(
        "resolve",
        `finalizeFile: after delete — review=false, hasUndo=${hasUndoState(filePath)}, hasRedo=${hasRedoState(filePath)}`,
    );

    if (changeType === "create" && allRejected) {
        try {
            fs.unlinkSync(filePath);
            logCat("resolve", `finalizeFile: deleted created file ${filePath} (rejected new file)`);
        } catch (err) {
            logCat(
                "resolve",
                `finalizeFile: failed to delete created file ${filePath}: ${(err as Error).message}`,
            );
        }
    } else if (changeType === "delete" && allRejected) {
        fs.writeFileSync(filePath, review.originalContent, "utf8");
        logCat(
            "resolve",
            `finalizeFile: restored deleted file ${filePath} (rejected deletion, ${review.originalContent.length} chars)`,
        );
    } else if (changeType === "delete" && !allRejected) {
        try {
            fs.unlinkSync(filePath);
            logCat(
                "resolve",
                `finalizeFile: confirmed deletion of ${filePath} (accepted deletion)`,
            );
        } catch (err) {
            logCat(
                "resolve",
                `finalizeFile: failed to confirm-delete ${filePath}: ${(err as Error).message}`,
            );
        }
    } else {
        const finalContent = buildFinalContent(review);
        const acceptedCount = review.hunks.filter((h) => h.accepted).length;
        const rejectedCount = review.hunks.filter((h) => !h.accepted).length;
        logCat(
            "resolve",
            `finalizeFile: building final content — ${acceptedCount} accepted, ${rejectedCount} rejected, ${finalContent.length} chars`,
        );
        await applyContentViaEdit(mgr, filePath, finalContent);
    }

    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === filePath);
    if (editor) {
        clearDecorations(editor);
    }

    // Move to next unresolved file
    // NOTE: We defer refreshUI until AFTER the next file is opened (or confirmed absent).
    // Calling refreshUI here would briefly show "Review next file" in the webview
    // because the current file is already finalized but the next hasn't opened yet.
    const next = mgr.reviewFiles.find((f) => state.activeReviews.has(f));
    if (next) {
        mgr.currentFileIndex = mgr.reviewFiles.indexOf(next);
        mgr.currentHunkIndex = 0;
        await mgr.openFileForReview(next);
    } else {
        logCat("review", "All files reviewed — clearing review state");
        mgr.reviewFiles = [];
        mgr.currentFileIndex = 0;
        clearReviewState(mgr.wp);
        mgr.syncState();
        mgr.refreshUI();
        mgr._onReviewStateChange.fire(false);
    }

    // Update context key — onTabSwitch won't fire since the active editor didn't change.
    // Without this, ccr.activeFileInReview stays stale and Cmd+Z keybinding fails.
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        const activeFp = activeEditor.document.uri.fsPath;
        const activeReview = state.activeReviews.has(activeFp);
        const activeHasHistory = hasUndoState(activeFp) || hasRedoState(activeFp);
        logCat(
            "resolve",
            `finalizeFile: updating ccr.activeFileInReview=${activeReview || activeHasHistory} for ${activeFp.split("/").pop()}`,
        );
        vscode.commands.executeCommand(
            "setContext",
            "ccr.activeFileInReview",
            activeReview || activeHasHistory,
        );
    }
}
