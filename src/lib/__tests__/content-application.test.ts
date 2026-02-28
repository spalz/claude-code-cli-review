import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn(), logCat: vi.fn() }));

const mockDecorations = vi.hoisted(() => ({
    applyDecorations: vi.fn(),
    clearDecorations: vi.fn(),
}));
vi.mock("../decorations", () => mockDecorations);

const mockUndoHistory = vi.hoisted(() => ({
    initHistory: vi.fn(),
    pushUndoState: vi.fn(),
    popUndoState: vi.fn(),
    pushRedoState: vi.fn(),
    popRedoState: vi.fn(),
    hasUndoState: vi.fn().mockReturnValue(false),
    hasRedoState: vi.fn().mockReturnValue(false),
    setApplyingEdit: vi.fn(),
    isApplyingEdit: vi.fn().mockReturnValue(false),
    clearHistory: vi.fn(),
    clearAllHistories: vi.fn(),
}));
vi.mock("../undo-history", () => mockUndoHistory);

const mockFs = vi.hoisted(() => ({
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
}));
vi.mock("fs", () => mockFs);

const mockExecSync = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ execSync: mockExecSync }));

const mockServer = vi.hoisted(() => ({
    getSnapshot: vi.fn().mockReturnValue(undefined),
    clearSnapshot: vi.fn(),
}));
vi.mock("../server", () => mockServer);

const mockPersistence = vi.hoisted(() => ({
    saveReviewState: vi.fn(),
    loadReviewState: vi.fn().mockReturnValue(null),
    clearReviewState: vi.fn(),
}));
vi.mock("../persistence", () => mockPersistence);

import * as vscode from "vscode";
import * as state from "../state";
import { ReviewManager } from "../review-manager";

function setupManager(): ReviewManager {
    const mgr = new ReviewManager("/ws");
    mgr.setProviders({ refresh: vi.fn() }, { update: vi.fn() });
    return mgr;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    state.activeReviews.clear();
    state.setReviewFiles([]);
    mockFs.readFileSync.mockReturnValue("modified content");
    mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("git ls-files")) return "";
        if (cmd.includes("git show HEAD")) return "original";
        if (cmd.includes("git diff --no-index")) {
            const err = new Error("diff") as Error & { stdout: string };
            err.stdout = "@@ -1,1 +1,1 @@\n-original\n+modified content";
            throw err;
        }
        if (cmd.includes("git diff HEAD")) return "@@ -1,1 +1,1 @@\n-original\n+modified content";
        return "";
    });
    (vscode.window as any).visibleTextEditors = [];
    (vscode.window as any).activeTextEditor = null;
});

describe("saveWithoutFormatting (via applyContentViaEdit)", () => {
    it("uses fs.writeFileSync instead of doc.save()", async () => {
        const mgr = setupManager();
        mgr.addFile("/ws/file.ts");
        const review = state.activeReviews.get("/ws/file.ts")!;
        const mergedContent = review.mergedLines.join("\n");

        const mockDoc = {
            uri: { fsPath: "/ws/file.ts" },
            lineCount: 2,
            lineAt: (n: number) => ({ text: mergedContent.split("\n")[n] ?? "" }),
            getText: vi.fn().mockReturnValue("old text"),
            save: vi.fn().mockResolvedValue(true),
        };
        const mockEditor = {
            document: mockDoc,
            visibleRanges: [new vscode.Range(0, 0, 1, 0)],
            selection: new vscode.Selection(0, 0, 0, 0),
            revealRange: vi.fn(),
            edit: vi.fn().mockResolvedValue(true),
            setDecorations: vi.fn(),
        };
        (vscode.window as any).visibleTextEditors = [mockEditor];

        // Trigger applyContentViaEdit via resolveAllHunks
        await mgr.resolveAllHunks("/ws/file.ts", true);

        // doc.save() should NOT be called (we use saveWithoutFormatting)
        expect(mockDoc.save).not.toHaveBeenCalled();
        // fs.writeFileSync should be called (saveWithoutFormatting path)
        expect(mockFs.writeFileSync).toHaveBeenCalled();
        // workbench.action.files.revert should be called to clear dirty flag
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            "workbench.action.files.revert",
        );
    });

    it("setApplyingEdit is set during edit", async () => {
        const mgr = setupManager();
        mgr.addFile("/ws/file.ts");

        const mockDoc = {
            uri: { fsPath: "/ws/file.ts" },
            lineCount: 2,
            lineAt: () => ({ text: "" }),
            getText: vi.fn().mockReturnValue("old text"),
            save: vi.fn().mockResolvedValue(true),
        };
        const mockEditor = {
            document: mockDoc,
            visibleRanges: [new vscode.Range(0, 0, 1, 0)],
            selection: new vscode.Selection(0, 0, 0, 0),
            revealRange: vi.fn(),
            edit: vi.fn().mockResolvedValue(true),
            setDecorations: vi.fn(),
        };
        (vscode.window as any).visibleTextEditors = [mockEditor];

        await mgr.resolveAllHunks("/ws/file.ts", true);

        // setApplyingEdit(path, true) then setApplyingEdit(path, false) must both be called
        const setCalls = mockUndoHistory.setApplyingEdit.mock.calls.filter(
            (c: any[]) => c[0] === "/ws/file.ts",
        );
        const trueCall = setCalls.find((c: any[]) => c[1] === true);
        const falseCall = setCalls.find((c: any[]) => c[1] === false);
        expect(trueCall).toBeDefined();
        expect(falseCall).toBeDefined();
    });
});

describe("applyTargetedHunkEdit — buffer validation", () => {
    function setupMultiHunkFile(mgr: ReviewManager): string {
        // Create a file with 2-hunk diff
        mockFs.readFileSync.mockReturnValue("new1\nnew2");
        mockExecSync.mockImplementation((cmd: string) => {
            if (cmd.includes("git ls-files")) return "";
            if (cmd.includes("git show HEAD")) return "old1\nold2";
            if (cmd.includes("git diff HEAD"))
                return "@@ -1,1 +1,1 @@\n-old1\n+new1\n@@ -2,1 +2,1 @@\n-old2\n+new2";
            if (cmd.includes("git diff --no-index")) {
                const err = new Error("diff") as Error & { stdout: string };
                err.stdout = "@@ -1,1 +1,1 @@\n-old1\n+new1\n@@ -2,1 +2,1 @@\n-old2\n+new2";
                throw err;
            }
            return "";
        });
        mgr.addFile("/ws/multi.ts");
        return "/ws/multi.ts";
    }

    it("falls back to full replace when buffer diverged", async () => {
        const mgr = setupManager();
        const filePath = setupMultiHunkFile(mgr);
        const review = state.activeReviews.get(filePath)!;
        const mergedContent = review.mergedLines.join("\n");

        // Editor has DIVERGED content (e.g. formatOnSave added a line)
        const mockDoc = {
            uri: { fsPath: filePath },
            lineCount: 5,
            lineAt: () => ({ text: "diverged" }),
            getText: vi.fn().mockReturnValue("completely different content\nfrom formatOnSave"),
            save: vi.fn().mockResolvedValue(true),
        };
        const mockEditor = {
            document: mockDoc,
            visibleRanges: [new vscode.Range(0, 0, 4, 0)],
            selection: new vscode.Selection(0, 0, 0, 0),
            revealRange: vi.fn(),
            edit: vi.fn().mockResolvedValue(true),
            setDecorations: vi.fn(),
        };
        (vscode.window as any).visibleTextEditors = [mockEditor];
        (vscode.window as any).activeTextEditor = mockEditor;

        // Resolve first hunk — buffer diverged, should use full replace fallback
        await mgr.resolveHunk(filePath, review.hunks[0].id, true);

        // editor.edit should be called (via applyContentViaEdit fallback, not targeted edit)
        expect(mockEditor.edit).toHaveBeenCalled();
    });

    it("accept skips buffer edit when buffer matches (hover-based approach)", async () => {
        const mgr = setupManager();
        const filePath = setupMultiHunkFile(mgr);
        const review = state.activeReviews.get(filePath)!;
        const mergedContent = review.mergedLines.join("\n");

        // Editor has CORRECT pre-merge content
        const mockDoc = {
            uri: { fsPath: filePath },
            lineCount: review.mergedLines.length,
            lineAt: (n: number) => ({ text: review.mergedLines[n] ?? "" }),
            getText: vi.fn().mockReturnValue(mergedContent),
            save: vi.fn().mockResolvedValue(true),
        };
        const mockEditor = {
            document: mockDoc,
            visibleRanges: [new vscode.Range(0, 0, 3, 0)],
            selection: new vscode.Selection(0, 0, 0, 0),
            revealRange: vi.fn(),
            edit: vi.fn().mockResolvedValue(true),
            setDecorations: vi.fn(),
        };
        (vscode.window as any).visibleTextEditors = [mockEditor];
        (vscode.window as any).activeTextEditor = mockEditor;

        // Resolve first hunk (accept) — hover-based: added lines already in buffer, no edit needed
        await mgr.resolveHunk(filePath, review.hunks[0].id, true);

        // editor.edit should NOT be called — accept just updates decorations
        expect(mockEditor.edit).not.toHaveBeenCalled();
        // applyDecorations should be called instead
        expect(mockDecorations.applyDecorations).toHaveBeenCalled();
    });
});

describe("decoration lifecycle", () => {
    it("clearDecorations is called when file is finalized (all hunks resolved)", async () => {
        const mgr = setupManager();
        mgr.addFile("/ws/file.ts");
        const review = state.activeReviews.get("/ws/file.ts")!;
        const mergedContent = review.mergedLines.join("\n");

        const mockDoc = {
            uri: { fsPath: "/ws/file.ts" },
            lineCount: review.mergedLines.length,
            lineAt: (n: number) => ({ text: review.mergedLines[n] ?? "" }),
            getText: vi.fn().mockReturnValue(mergedContent),
            save: vi.fn().mockResolvedValue(true),
        };
        const mockEditor = {
            document: mockDoc,
            visibleRanges: [new vscode.Range(0, 0, 3, 0)],
            selection: new vscode.Selection(0, 0, 0, 0),
            revealRange: vi.fn(),
            edit: vi.fn().mockResolvedValue(true),
            setDecorations: vi.fn(),
        };
        (vscode.window as any).visibleTextEditors = [mockEditor];
        (vscode.window as any).activeTextEditor = mockEditor;

        mockDecorations.clearDecorations.mockClear();
        await mgr.resolveHunk("/ws/file.ts", review.hunks[0].id, true);

        // After last hunk resolved → file finalized → clearDecorations called
        expect(mockDecorations.clearDecorations).toHaveBeenCalledWith(mockEditor);
    });

    it("applyDecorations is called for partial resolution with matching buffer", async () => {
        const mgr = setupManager();
        // Create a file with 2 hunks
        mockFs.readFileSync.mockReturnValue("new1\nnew2");
        mockExecSync.mockImplementation((cmd: string) => {
            if (cmd.includes("git ls-files")) return "";
            if (cmd.includes("git show HEAD")) return "old1\nold2";
            if (cmd.includes("git diff HEAD"))
                return "@@ -1,1 +1,1 @@\n-old1\n+new1\n@@ -2,1 +2,1 @@\n-old2\n+new2";
            if (cmd.includes("git diff --no-index")) {
                const err = new Error("diff") as Error & { stdout: string };
                err.stdout = "@@ -1,1 +1,1 @@\n-old1\n+new1\n@@ -2,1 +2,1 @@\n-old2\n+new2";
                throw err;
            }
            return "";
        });
        mgr.addFile("/ws/multi.ts");
        const review = state.activeReviews.get("/ws/multi.ts")!;

        // Make getText dynamic — returns pre-merge initially, then post-merge after edit
        let currentContent = review.mergedLines.join("\n");
        const mockDoc = {
            uri: { fsPath: "/ws/multi.ts" },
            get lineCount() {
                return currentContent.split("\n").length;
            },
            lineAt: (n: number) => ({ text: currentContent.split("\n")[n] ?? "" }),
            getText: vi.fn().mockImplementation(() => currentContent),
            save: vi.fn().mockResolvedValue(true),
        };
        const mockEditor = {
            document: mockDoc,
            visibleRanges: [new vscode.Range(0, 0, 3, 0)],
            selection: new vscode.Selection(0, 0, 0, 0),
            revealRange: vi.fn(),
            edit: vi.fn().mockImplementation(async (callback: any) => {
                // Simulate successful edit — update currentContent to match expected post-edit
                // After resolving hunk 0 (accept), rebuild removes old1 line
                currentContent = review.mergedLines.join("\n");
                return true;
            }),
            setDecorations: vi.fn(),
        };
        (vscode.window as any).visibleTextEditors = [mockEditor];
        (vscode.window as any).activeTextEditor = mockEditor;

        mockDecorations.applyDecorations.mockClear();
        // Resolve only first hunk — not all resolved
        await mgr.resolveHunk("/ws/multi.ts", review.hunks[0].id, true);

        // applyDecorations should be called (file still has unresolved hunks, buffer matches)
        expect(mockDecorations.applyDecorations).toHaveBeenCalled();
    });
});
