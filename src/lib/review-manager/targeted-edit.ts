// Targeted hunk edit — removes only resolved hunk lines instead of full buffer replace
import * as vscode from "vscode";
import { logCat } from "../log";
import * as state from "../state";
import { applyDecorations } from "../decorations";
import { FileReview } from "../review";
import { setApplyingEdit } from "../undo-history";
import { saveWithoutFormatting } from "./editor-utils";
import type { ReviewManagerInternal } from "./types";

/**
 * Targeted edit: remove only the resolved hunk's lines instead of replacing
 * the entire buffer. This preserves scroll position naturally because
 * unaffected lines don't move.
 *
 * @param deleteStart - 0-based line index (inclusive)
 * @param deleteEnd   - 0-based line index (exclusive)
 * @param revealLine  - line to reveal after edit (next unresolved hunk)
 */
export async function applyTargetedHunkEdit(
    mgr: ReviewManagerInternal,
    filePath: string,
    deleteStart: number,
    deleteEnd: number,
    revealLine?: number,
): Promise<boolean> {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === filePath);
    if (!editor || deleteStart >= deleteEnd) return false;

    const doc = editor.document;
    if (deleteEnd > doc.lineCount) return false;

    logCat(
        "content",
        `applyTargetedHunkEdit: deleting lines ${deleteStart}-${deleteEnd} in ${filePath} (docLines=${doc.lineCount})`,
    );

    setApplyingEdit(filePath, true);
    let editSuccess = false;
    try {
        // Build a range that covers the lines to delete (including trailing newline).
        // When deleting at end-of-file, grab the newline from the previous line instead.
        const rangeStart =
            deleteStart > 0 && deleteEnd >= doc.lineCount
                ? new vscode.Position(deleteStart - 1, doc.lineAt(deleteStart - 1).text.length)
                : new vscode.Position(deleteStart, 0);
        const rangeEnd =
            deleteEnd < doc.lineCount
                ? new vscode.Position(deleteEnd, 0)
                : new vscode.Position(deleteEnd - 1, doc.lineAt(deleteEnd - 1).text.length);
        const deleteRange = new vscode.Range(rangeStart, rangeEnd);

        editSuccess = await editor.edit((eb) => eb.delete(deleteRange), {
            undoStopBefore: true,
            undoStopAfter: true,
        });
        logCat(
            "content",
            `applyTargetedHunkEdit: edit result=${editSuccess}, docLines after=${doc.lineCount}`,
        );
        if (editSuccess) {
            await saveWithoutFormatting(doc);
            const rev = state.activeReviews.get(filePath);
            if (rev) (rev as FileReview).mergedApplied = true;
        }
    } finally {
        setApplyingEdit(filePath, false);
    }

    if (editSuccess) {
        // Verify buffer matches expected merged content; fallback to full replace if not
        const review = state.activeReviews.get(filePath);
        if (review) {
            const expected = review.mergedLines.join("\n");
            const bufferMatch = doc.getText() === expected;
            logCat(
                "content",
                `applyTargetedHunkEdit: post-edit verify bufferMatch=${bufferMatch}, expectedLines=${review.mergedLines.length}, docLines=${doc.lineCount}`,
            );
            if (!bufferMatch) {
                logCat(
                    "content",
                    `applyTargetedHunkEdit: content mismatch after delete, falling back to full replace`,
                );
                const retrySuccess = await editor.edit(
                    (eb) =>
                        eb.replace(
                            new vscode.Range(
                                0,
                                0,
                                doc.lineCount - 1,
                                doc.lineAt(doc.lineCount - 1).text.length,
                            ),
                            expected,
                        ),
                    { undoStopBefore: false, undoStopAfter: true },
                );
                if (retrySuccess) await saveWithoutFormatting(doc);
            }
            if (doc.getText() === expected) {
                applyDecorations(editor, review);
            } else {
                logCat(
                    "content",
                    `applyTargetedHunkEdit: buffer still mismatched after fallback, skipping decorations`,
                );
            }
        }
    }

    if (revealLine !== undefined) {
        const clampedLine = Math.min(revealLine, editor.document.lineCount - 1);
        editor.revealRange(
            new vscode.Range(clampedLine, 0, clampedLine, 0),
            vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
    }

    mgr.syncState();
    mgr.refreshUI();
    return editSuccess;
}
