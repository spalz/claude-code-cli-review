import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn(), logCat: vi.fn() }));

import {
    initHistory,
    pushUndoState,
    popUndoState,
    pushRedoState,
    popRedoState,
    hasUndoState,
    hasRedoState,
    setApplyingEdit,
    isApplyingEdit,
    clearHistory,
    clearAllHistories,
    getLastUndoFilePath,
    getLastRedoFilePath,
} from "../undo-history";
import type { IFileReview, ChangeType } from "../../types";

function makeFakeReview(overrides?: Partial<IFileReview>): IFileReview {
    return {
        filePath: "/ws/file.ts",
        originalContent: "old",
        modifiedContent: "new",
        changeType: "edit" as ChangeType,
        hunks: [
            {
                id: 0,
                origStart: 1,
                origCount: 1,
                modStart: 1,
                modCount: 1,
                removed: ["old"],
                added: ["new"],
                resolved: false,
                accepted: false,
            },
        ],
        mergedLines: ["old", "new"],
        hunkRanges: [{ hunkId: 0, removedStart: 0, removedEnd: 1, addedStart: 1, addedEnd: 2 }],
        get unresolvedCount() {
            return this.hunks.filter((h) => !h.resolved).length;
        },
        get isFullyResolved() {
            return this.hunks.every((h) => h.resolved);
        },
        ...overrides,
    };
}

beforeEach(() => {
    clearAllHistories();
});

describe("undo-history (stack-based)", () => {
    it("pushUndoState + popUndoState round-trip", () => {
        initHistory("/ws/file.ts");
        const review = makeFakeReview();
        pushUndoState("/ws/file.ts", review);

        expect(hasUndoState("/ws/file.ts")).toBe(true);
        const snapshot = popUndoState("/ws/file.ts");
        expect(snapshot).toBeDefined();
        expect(snapshot!.filePath).toBe("/ws/file.ts");
        expect(snapshot!.hunks).toEqual(review.hunks);
        expect(hasUndoState("/ws/file.ts")).toBe(false);
    });

    it("deep copy — mutation of original does not affect snapshot", () => {
        initHistory("/ws/file.ts");
        const review = makeFakeReview();
        pushUndoState("/ws/file.ts", review);

        review.hunks[0].resolved = true;
        review.mergedLines.push("extra");

        const snapshot = popUndoState("/ws/file.ts");
        expect(snapshot!.hunks[0].resolved).toBe(false);
        expect(snapshot!.mergedLines).toEqual(["old", "new"]);
    });

    it("popUndoState returns undefined when empty", () => {
        initHistory("/ws/file.ts");
        expect(popUndoState("/ws/file.ts")).toBeUndefined();
    });

    it("popUndoState returns undefined for unknown file", () => {
        expect(popUndoState("/ws/nope.ts")).toBeUndefined();
    });

    it("stack order: LIFO", () => {
        initHistory("/ws/file.ts");
        const r1 = makeFakeReview({ mergedLines: ["state1"] });
        const r2 = makeFakeReview({ mergedLines: ["state2"] });
        const r3 = makeFakeReview({ mergedLines: ["state3"] });

        pushUndoState("/ws/file.ts", r1);
        pushUndoState("/ws/file.ts", r2);
        pushUndoState("/ws/file.ts", r3);

        expect(popUndoState("/ws/file.ts")!.mergedLines).toEqual(["state3"]);
        expect(popUndoState("/ws/file.ts")!.mergedLines).toEqual(["state2"]);
        expect(popUndoState("/ws/file.ts")!.mergedLines).toEqual(["state1"]);
        expect(popUndoState("/ws/file.ts")).toBeUndefined();
    });

    it("pushUndoState clears redo stack", () => {
        initHistory("/ws/file.ts");
        const r1 = makeFakeReview({ mergedLines: ["state1"] });
        const r2 = makeFakeReview({ mergedLines: ["state2"] });

        pushRedoState("/ws/file.ts", r1);
        expect(hasRedoState("/ws/file.ts")).toBe(true);

        pushUndoState("/ws/file.ts", r2);
        expect(hasRedoState("/ws/file.ts")).toBe(false);
    });

    it("pushUndoState with preserveRedo=true keeps redo stack", () => {
        initHistory("/ws/file.ts");
        const r1 = makeFakeReview({ mergedLines: ["redo1"] });
        const r2 = makeFakeReview({ mergedLines: ["redo2"] });
        const r3 = makeFakeReview({ mergedLines: ["current"] });

        pushRedoState("/ws/file.ts", r1);
        pushRedoState("/ws/file.ts", r2);
        expect(hasRedoState("/ws/file.ts")).toBe(true);

        pushUndoState("/ws/file.ts", r3, true);
        expect(hasRedoState("/ws/file.ts")).toBe(true);

        // Redo stack still has both entries
        const snap1 = popRedoState("/ws/file.ts");
        expect(snap1!.mergedLines).toEqual(["redo2"]);
        const snap2 = popRedoState("/ws/file.ts");
        expect(snap2!.mergedLines).toEqual(["redo1"]);
    });

    it("pushUndoState with preserveRedo=false (default) clears redo stack", () => {
        initHistory("/ws/file.ts");
        pushRedoState("/ws/file.ts", makeFakeReview({ mergedLines: ["redo"] }));

        pushUndoState("/ws/file.ts", makeFakeReview({ mergedLines: ["new"] }), false);
        expect(hasRedoState("/ws/file.ts")).toBe(false);
    });

    it("multiple redo operations preserve full redo stack", () => {
        // Simulate: 5 undos → redo stack has 5 entries → redo 5 times
        // Each redo calls pushUndoState(_, _, true) — redo stack should shrink by 1 each time
        initHistory("/ws/file.ts");
        const states = Array.from({ length: 5 }, (_, i) =>
            makeFakeReview({ mergedLines: [`redo${i}`] }),
        );
        for (const s of states) pushRedoState("/ws/file.ts", s);

        // Simulate 5 redo operations: pop redo, push undo with preserveRedo
        for (let i = 4; i >= 0; i--) {
            const snapshot = popRedoState("/ws/file.ts");
            expect(snapshot).toBeDefined();
            expect(snapshot!.mergedLines).toEqual([`redo${i}`]);
            pushUndoState(
                "/ws/file.ts",
                makeFakeReview({ mergedLines: [`before-redo${i}`] }),
                true,
            );
        }

        // All redo consumed
        expect(hasRedoState("/ws/file.ts")).toBe(false);
        // All pushed to undo (5 redo pops + 5 undo pushes = 5 undo entries)
        expect(hasUndoState("/ws/file.ts")).toBe(true);
    });

    it("redo stack round-trip", () => {
        initHistory("/ws/file.ts");
        const review = makeFakeReview();
        pushRedoState("/ws/file.ts", review);

        expect(hasRedoState("/ws/file.ts")).toBe(true);
        const snapshot = popRedoState("/ws/file.ts");
        expect(snapshot).toBeDefined();
        expect(snapshot!.mergedLines).toEqual(review.mergedLines);
        expect(hasRedoState("/ws/file.ts")).toBe(false);
    });

    it("clearHistory clears both stacks", () => {
        initHistory("/ws/file.ts");
        pushUndoState("/ws/file.ts", makeFakeReview());
        pushRedoState("/ws/file.ts", makeFakeReview());

        clearHistory("/ws/file.ts");
        expect(hasUndoState("/ws/file.ts")).toBe(false);
        expect(hasRedoState("/ws/file.ts")).toBe(false);
    });

    it("clearAllHistories clears everything", () => {
        initHistory("/ws/a.ts");
        initHistory("/ws/b.ts");
        pushUndoState("/ws/a.ts", makeFakeReview());
        pushUndoState("/ws/b.ts", makeFakeReview());

        clearAllHistories();
        expect(hasUndoState("/ws/a.ts")).toBe(false);
        expect(hasUndoState("/ws/b.ts")).toBe(false);
    });

    it("isApplyingEdit guard flag", () => {
        initHistory("/ws/file.ts");
        expect(isApplyingEdit("/ws/file.ts")).toBe(false);
        setApplyingEdit("/ws/file.ts", true);
        expect(isApplyingEdit("/ws/file.ts")).toBe(true);
        setApplyingEdit("/ws/file.ts", false);
        expect(isApplyingEdit("/ws/file.ts")).toBe(false);
    });

    it("isApplyingEdit returns false for unknown file", () => {
        expect(isApplyingEdit("/ws/nope.ts")).toBe(false);
    });

    it("pushUndoState auto-initializes history if not present", () => {
        pushUndoState("/ws/file.ts", makeFakeReview());
        expect(hasUndoState("/ws/file.ts")).toBe(true);
    });

    it("pushRedoState without initHistory is a no-op", () => {
        pushRedoState("/ws/file.ts", makeFakeReview());
        expect(hasRedoState("/ws/file.ts")).toBe(false);
    });

    it("enforces MAX_UNDO_DEPTH=50 limit by evicting oldest", () => {
        initHistory("/ws/file.ts");
        for (let i = 0; i < 55; i++) {
            pushUndoState("/ws/file.ts", makeFakeReview({ mergedLines: [`state${i}`] }));
        }
        // Pop all — should get exactly 50 (not 55)
        let count = 0;
        while (popUndoState("/ws/file.ts")) count++;
        expect(count).toBe(50);
    });

    it("enforces MAX_UNDO_DEPTH on redo stack too", () => {
        initHistory("/ws/file.ts");
        for (let i = 0; i < 55; i++) {
            pushRedoState("/ws/file.ts", makeFakeReview({ mergedLines: [`redo${i}`] }));
        }
        let count = 0;
        while (popRedoState("/ws/file.ts")) count++;
        expect(count).toBe(50);
    });

    it("evicted entries are oldest (FIFO eviction)", () => {
        initHistory("/ws/file.ts");
        for (let i = 0; i < 55; i++) {
            pushUndoState("/ws/file.ts", makeFakeReview({ mergedLines: [`s${i}`] }));
        }
        // Last popped should be state5 (0-4 evicted)
        const snapshots: string[][] = [];
        let snap;
        while ((snap = popUndoState("/ws/file.ts"))) snapshots.push(snap.mergedLines);
        // snapshots[0] is most recent (s54), last is oldest remaining (s5)
        expect(snapshots[0]).toEqual(["s54"]);
        expect(snapshots[snapshots.length - 1]).toEqual(["s5"]);
    });
});

describe("cross-file global tracking", () => {
    it("getLastUndoFilePath returns most recent file", () => {
        initHistory("/ws/a.ts");
        initHistory("/ws/b.ts");
        pushUndoState("/ws/a.ts", makeFakeReview({ filePath: "/ws/a.ts" }));
        pushUndoState("/ws/b.ts", makeFakeReview({ filePath: "/ws/b.ts" }));
        expect(getLastUndoFilePath()).toBe("/ws/b.ts");
    });

    it("getLastUndoFilePath returns undefined when empty", () => {
        expect(getLastUndoFilePath()).toBeUndefined();
    });

    it("getLastRedoFilePath returns most recent file", () => {
        initHistory("/ws/a.ts");
        initHistory("/ws/b.ts");
        pushRedoState("/ws/a.ts", makeFakeReview({ filePath: "/ws/a.ts" }));
        pushRedoState("/ws/b.ts", makeFakeReview({ filePath: "/ws/b.ts" }));
        expect(getLastRedoFilePath()).toBe("/ws/b.ts");
    });

    it("popUndoState removes file from global order", () => {
        initHistory("/ws/a.ts");
        initHistory("/ws/b.ts");
        pushUndoState("/ws/a.ts", makeFakeReview({ filePath: "/ws/a.ts" }));
        pushUndoState("/ws/b.ts", makeFakeReview({ filePath: "/ws/b.ts" }));
        popUndoState("/ws/b.ts");
        expect(getLastUndoFilePath()).toBe("/ws/a.ts");
    });

    it("clearHistory removes file from global stacks", () => {
        initHistory("/ws/a.ts");
        pushUndoState("/ws/a.ts", makeFakeReview({ filePath: "/ws/a.ts" }));
        pushRedoState("/ws/a.ts", makeFakeReview({ filePath: "/ws/a.ts" }));
        clearHistory("/ws/a.ts");
        expect(getLastUndoFilePath()).toBeUndefined();
        expect(getLastRedoFilePath()).toBeUndefined();
    });

    it("clearAllHistories clears global stacks", () => {
        initHistory("/ws/a.ts");
        pushUndoState("/ws/a.ts", makeFakeReview());
        pushRedoState("/ws/a.ts", makeFakeReview());
        clearAllHistories();
        expect(getLastUndoFilePath()).toBeUndefined();
        expect(getLastRedoFilePath()).toBeUndefined();
    });
});

describe("updateContextKeys side effects", () => {
    let executeCommand: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        const vscode = await import("./mocks/vscode");
        executeCommand = vscode.commands.executeCommand;
        executeCommand.mockClear();
    });

    it("sets canUndo=true and canRedo=false after pushUndoState", () => {
        initHistory("/ws/file.ts");
        pushUndoState("/ws/file.ts", makeFakeReview());

        expect(executeCommand).toHaveBeenCalledWith("setContext", "ccr.canUndoReview", true);
        expect(executeCommand).toHaveBeenCalledWith("setContext", "ccr.canRedoReview", false);
    });

    it("sets canUndo=false after popUndoState empties the stack", () => {
        initHistory("/ws/file.ts");
        pushUndoState("/ws/file.ts", makeFakeReview());
        executeCommand.mockClear();

        popUndoState("/ws/file.ts");

        expect(executeCommand).toHaveBeenCalledWith("setContext", "ccr.canUndoReview", false);
        expect(executeCommand).toHaveBeenCalledWith("setContext", "ccr.canRedoReview", false);
    });

    it("sets canRedo=true after pushRedoState", () => {
        initHistory("/ws/file.ts");
        pushRedoState("/ws/file.ts", makeFakeReview());

        expect(executeCommand).toHaveBeenCalledWith("setContext", "ccr.canRedoReview", true);
    });

    it("sets canRedo=false after popRedoState empties the stack", () => {
        initHistory("/ws/file.ts");
        pushRedoState("/ws/file.ts", makeFakeReview());
        executeCommand.mockClear();

        popRedoState("/ws/file.ts");

        expect(executeCommand).toHaveBeenCalledWith("setContext", "ccr.canRedoReview", false);
    });

    it("multi-file canUndo: true when any file has undo, false when all cleared", () => {
        initHistory("/ws/a.ts");
        initHistory("/ws/b.ts");

        pushUndoState("/ws/a.ts", makeFakeReview({ filePath: "/ws/a.ts" }));
        expect(executeCommand).toHaveBeenCalledWith("setContext", "ccr.canUndoReview", true);

        // Clear only a.ts history
        clearHistory("/ws/a.ts");
        expect(executeCommand).toHaveBeenCalledWith("setContext", "ccr.canUndoReview", false);
    });

    it("multi-file canUndo remains true when one file still has undo", () => {
        initHistory("/ws/a.ts");
        initHistory("/ws/b.ts");

        pushUndoState("/ws/a.ts", makeFakeReview({ filePath: "/ws/a.ts" }));
        pushUndoState("/ws/b.ts", makeFakeReview({ filePath: "/ws/b.ts" }));
        executeCommand.mockClear();

        // Clear only a.ts
        clearHistory("/ws/a.ts");
        expect(executeCommand).toHaveBeenCalledWith("setContext", "ccr.canUndoReview", true);
    });

    it("preserveRedo=true keeps canRedo=true", () => {
        initHistory("/ws/file.ts");
        pushRedoState("/ws/file.ts", makeFakeReview());
        executeCommand.mockClear();

        pushUndoState("/ws/file.ts", makeFakeReview(), true);

        expect(executeCommand).toHaveBeenCalledWith("setContext", "ccr.canRedoReview", true);
        expect(executeCommand).toHaveBeenCalledWith("setContext", "ccr.canUndoReview", true);
    });

    it("clearAllHistories sets both context keys to false", () => {
        initHistory("/ws/a.ts");
        pushUndoState("/ws/a.ts", makeFakeReview());
        pushRedoState("/ws/a.ts", makeFakeReview());
        executeCommand.mockClear();

        clearAllHistories();

        expect(executeCommand).toHaveBeenCalledWith("setContext", "ccr.canUndoReview", false);
        expect(executeCommand).toHaveBeenCalledWith("setContext", "ccr.canRedoReview", false);
    });
});
