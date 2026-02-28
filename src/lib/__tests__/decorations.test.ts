import { describe, it, expect, vi, beforeEach } from "vitest";

// Add missing members to vscode mock before importing the module under test
vi.mock("vscode", async () => {
    const mock = await import("./mocks/vscode");
    return {
        ...mock,
        window: {
            ...mock.window,
            createTextEditorDecorationType: vi.fn(() => ({
                key: "deco-" + Math.random().toString(36).slice(2, 8),
                dispose: vi.fn(),
            })),
        },
    };
});

vi.mock("../log", () => ({ log: vi.fn(), logCat: vi.fn() }));
vi.mock("../inline-diff", () => ({
    computeHunkInlineChanges: vi.fn(() => ({ addedLineChanges: [], removedLineChanges: [] })),
}));

import { applyDecorations, clearDecorations } from "../decorations";
import type { IFileReview, Hunk, HunkRange } from "../../types";

function makeEditor(lineCount = 0) {
    return {
        setDecorations: vi.fn(),
        document: { uri: { fsPath: "/test/file.ts" }, lineCount },
    } as unknown as import("vscode").TextEditor;
}

function makeReview(hunks: Hunk[], hunkRanges: HunkRange[], lineCount = 0): IFileReview {
    return {
        filePath: "/test/file.ts",
        originalContent: "",
        modifiedContent: "",
        changeType: "edit",
        hunks,
        mergedLines: Array(lineCount).fill(""),
        hunkRanges,
        get unresolvedCount() {
            return hunks.filter((h) => !h.resolved).length;
        },
        get isFullyResolved() {
            return hunks.every((h) => h.resolved);
        },
    };
}

function makeHunk(overrides: Partial<Hunk> & { id: number }): Hunk {
    return {
        origStart: 1,
        origCount: 1,
        modStart: 1,
        modCount: 1,
        removed: [],
        added: [],
        resolved: false,
        accepted: false,
        ...overrides,
    };
}

describe("applyDecorations", () => {
    let editor: ReturnType<typeof makeEditor>;

    beforeEach(() => {
        editor = makeEditor();
    });

    it("sets correct ranges for added lines with hover for removed content", () => {
        const hunks = [makeHunk({ id: 1, removed: ["old"], added: ["new1", "new2"] })];
        const ranges: HunkRange[] = [
            { hunkId: 1, removedStart: 6, removedEnd: 6, addedStart: 6, addedEnd: 8 },
        ];
        const review = makeReview(hunks, ranges, 10);
        editor = makeEditor(10);

        applyDecorations(editor, review);

        const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls).toHaveLength(4);

        // First call: added decorations (DecorationOptions with hover)
        const addedRanges = calls[0][1];
        expect(addedRanges).toHaveLength(2);
        expect(addedRanges[0].range.start.line).toBe(6);
        expect(addedRanges[0].hoverMessage).toBeDefined();
        expect(addedRanges[1].range.start.line).toBe(7);
        expect(addedRanges[1].hoverMessage).toBeUndefined();

        // Second call: addedInline decorations
        const inlineRanges = calls[1][1];
        expect(inlineRanges).toHaveLength(0);

        // Third call: separator decorations
        const sepRanges = calls[3][1];
        expect(sepRanges).toHaveLength(1);
        expect(sepRanges[0].start.line).toBe(6);
    });

    it("skips resolved hunks", () => {
        const hunks = [makeHunk({ id: 1, resolved: true, removed: ["x"], added: ["y"] })];
        const ranges: HunkRange[] = [
            { hunkId: 1, removedStart: 1, removedEnd: 1, addedStart: 1, addedEnd: 2 },
        ];
        const review = makeReview(hunks, ranges);

        applyDecorations(editor, review);

        const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
        // All three decoration sets should be empty arrays
        expect(calls[0][1]).toHaveLength(0);
        expect(calls[1][1]).toHaveLength(0);
        expect(calls[3][1]).toHaveLength(0);
    });

    it("handles empty hunkRanges", () => {
        const review = makeReview([], []);

        applyDecorations(editor, review);

        const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls).toHaveLength(4);
        expect(calls[0][1]).toHaveLength(0);
        expect(calls[1][1]).toHaveLength(0);
        expect(calls[3][1]).toHaveLength(0);
    });

    it("handles hunkRange with no matching hunk", () => {
        const hunks: Hunk[] = [];
        const ranges: HunkRange[] = [
            { hunkId: 999, removedStart: 1, removedEnd: 1, addedStart: 1, addedEnd: 2 },
        ];
        const review = makeReview(hunks, ranges);

        applyDecorations(editor, review);

        const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls[0][1]).toHaveLength(0);
        expect(calls[1][1]).toHaveLength(0);
        expect(calls[3][1]).toHaveLength(0);
    });

    it("handles hunk with only removals (no added lines)", () => {
        const hunks = [makeHunk({ id: 1, removed: ["a", "b"], added: [] })];
        const ranges: HunkRange[] = [
            { hunkId: 1, removedStart: 3, removedEnd: 3, addedStart: 3, addedEnd: 3 },
        ];
        const review = makeReview(hunks, ranges, 7);
        editor = makeEditor(7);

        applyDecorations(editor, review);

        const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
        // Pure deletion: hover added on preceding context line (line 2)
        expect(calls[0][1]).toHaveLength(1);
        expect(calls[0][1][0].range.start.line).toBe(2);
        expect(calls[0][1][0].hoverMessage).toBeDefined();
        expect(calls[1][1]).toHaveLength(0); // no inline
    });

    it("handles hunk with only additions (no removed lines)", () => {
        const hunks = [makeHunk({ id: 1, removed: [], added: ["new"] })];
        const ranges: HunkRange[] = [
            { hunkId: 1, removedStart: 3, removedEnd: 3, addedStart: 3, addedEnd: 4 },
        ];
        const review = makeReview(hunks, ranges, 6);
        editor = makeEditor(6);

        applyDecorations(editor, review);

        const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls[0][1]).toHaveLength(1); // added
        expect(calls[0][1][0].range.start.line).toBe(3);
        expect(calls[0][1][0].hoverMessage).toBeUndefined(); // no removed lines
        // separator at addedStart
        expect(calls[3][1]).toHaveLength(1);
        expect(calls[3][1][0].start.line).toBe(3);
    });

    it("does not add separator when addedStart is 0", () => {
        const hunks = [makeHunk({ id: 1, removed: [], added: ["y"] })];
        const ranges: HunkRange[] = [
            { hunkId: 1, removedStart: 0, removedEnd: 0, addedStart: 0, addedEnd: 1 },
        ];
        const review = makeReview(hunks, ranges, 1);
        editor = makeEditor(1);

        applyDecorations(editor, review);

        const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls[3][1]).toHaveLength(0); // no separator
    });

    it("handles multiple unresolved hunks", () => {
        const hunks = [
            makeHunk({ id: 1, removed: ["a"], added: ["b"] }),
            makeHunk({ id: 2, removed: ["c"], added: ["d", "e"] }),
        ];
        const ranges: HunkRange[] = [
            { hunkId: 1, removedStart: 3, removedEnd: 3, addedStart: 3, addedEnd: 4 },
            { hunkId: 2, removedStart: 11, removedEnd: 11, addedStart: 11, addedEnd: 13 },
        ];
        const review = makeReview(hunks, ranges, 15);
        editor = makeEditor(15);

        applyDecorations(editor, review);

        const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls[0][1]).toHaveLength(3); // 1 + 2 added
        expect(calls[1][1]).toHaveLength(0); // no inline (mocked)
        expect(calls[3][1]).toHaveLength(2); // 2 separators
    });

    it("mixes resolved and unresolved hunks", () => {
        const hunks = [
            makeHunk({ id: 1, resolved: true, removed: ["a"], added: ["b"] }),
            makeHunk({ id: 2, removed: ["c"], added: ["d"] }),
        ];
        const ranges: HunkRange[] = [
            { hunkId: 1, removedStart: 3, removedEnd: 3, addedStart: 3, addedEnd: 4 },
            { hunkId: 2, removedStart: 11, removedEnd: 11, addedStart: 11, addedEnd: 12 },
        ];
        const review = makeReview(hunks, ranges, 14);
        editor = makeEditor(14);

        applyDecorations(editor, review);

        const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls[0][1]).toHaveLength(1); // only hunk 2 added
        expect(calls[1][1]).toHaveLength(0); // no inline (mocked)
    });
});

describe("line-count guard", () => {
    it("clears decorations when lineCount differs from mergedLines length", () => {
        const hunks = [makeHunk({ id: 1, removed: ["old"], added: ["new1", "new2"] })];
        const ranges: HunkRange[] = [
            { hunkId: 1, removedStart: 1, removedEnd: 1, addedStart: 1, addedEnd: 3 },
        ];
        // Editor has 3 lines but review expects 5 merged lines → mismatch
        const review = makeReview(hunks, ranges, 5);
        const editor = makeEditor(3);

        applyDecorations(editor, review);

        const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
        // Guard should call clearDecorations (4 empty arrays) and return early
        expect(calls).toHaveLength(4);
        expect(calls[0][1]).toEqual([]);
        expect(calls[1][1]).toEqual([]);
        expect(calls[2][1]).toEqual([]);
        expect(calls[3][1]).toEqual([]);
    });

    it("applies decorations normally when lineCount matches mergedLines length", () => {
        const hunks = [makeHunk({ id: 1, removed: ["old"], added: ["new"] })];
        const ranges: HunkRange[] = [
            { hunkId: 1, removedStart: 1, removedEnd: 1, addedStart: 1, addedEnd: 2 },
        ];
        const review = makeReview(hunks, ranges, 4);
        const editor = makeEditor(4);

        applyDecorations(editor, review);

        const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls[0][1]).toHaveLength(1); // added (with hover)
        expect(calls[1][1]).toHaveLength(0); // inline (mocked empty)
    });
});

describe("gutter indicators", () => {
    it("gutter pending decorations are empty when initDecorations not called", () => {
        const hunks = [makeHunk({ id: 1, removed: ["old"], added: ["new"] })];
        const ranges: HunkRange[] = [
            { hunkId: 1, removedStart: 3, removedEnd: 3, addedStart: 3, addedEnd: 4 },
        ];
        const review = makeReview(hunks, ranges, 6);
        const editor = makeEditor(6);

        applyDecorations(editor, review);

        const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
        // calls[2] = decoGutterPending — should be empty (no extensionPath set)
        expect(calls[2][1]).toHaveLength(0);
    });
});

describe("pure deletion hover", () => {
    it("shows hover on line 0 when addedStart is 0 for pure deletion", () => {
        const hunks = [makeHunk({ id: 1, removed: ["a", "b"], added: [] })];
        const ranges: HunkRange[] = [
            { hunkId: 1, removedStart: 0, removedEnd: 0, addedStart: 0, addedEnd: 0 },
        ];
        const review = makeReview(hunks, ranges, 1);
        const editor = makeEditor(1);

        applyDecorations(editor, review);

        const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
        const addedRanges = calls[0][1];
        // Should have 1 decoration on line 0 with hover
        expect(addedRanges).toHaveLength(1);
        expect(addedRanges[0].range.start.line).toBe(0);
        expect(addedRanges[0].hoverMessage).toBeDefined();
    });

    it("shows hover on preceding line when addedStart > 0 for pure deletion", () => {
        const hunks = [makeHunk({ id: 1, removed: ["x"], added: [] })];
        const ranges: HunkRange[] = [
            { hunkId: 1, removedStart: 5, removedEnd: 5, addedStart: 5, addedEnd: 5 },
        ];
        const review = makeReview(hunks, ranges, 7);
        const editor = makeEditor(7);

        applyDecorations(editor, review);

        const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
        const addedRanges = calls[0][1];
        expect(addedRanges).toHaveLength(1);
        expect(addedRanges[0].range.start.line).toBe(4); // addedStart - 1
        expect(addedRanges[0].hoverMessage).toBeDefined();
    });
});

describe("truncation", () => {
    it("truncates when total decoration ranges exceed MAX_DECORATIONS", () => {
        // Create enough hunks to exceed 150 lines
        const hunks: Hunk[] = [];
        const ranges: HunkRange[] = [];
        let line = 0;
        for (let i = 0; i < 20; i++) {
            hunks.push(makeHunk({ id: i, removed: ["old"], added: Array(10).fill("new") }));
            ranges.push({
                hunkId: i,
                removedStart: line,
                removedEnd: line,
                addedStart: line,
                addedEnd: line + 10,
            });
            line += 10;
        }
        // 20 hunks × 10 lines = 200, exceeds 150
        const review = makeReview(hunks, ranges, line);
        const editor = makeEditor(line);

        applyDecorations(editor, review);

        const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
        const addedCount = calls[0][1].length;
        // Should be truncated — fewer than 200 decorations
        expect(addedCount).toBeLessThan(200);
        expect(addedCount).toBeLessThanOrEqual(150);
    });
});

describe("clearDecorations", () => {
    it("calls setDecorations with empty arrays for all four types", () => {
        const editor = makeEditor();

        clearDecorations(editor);

        const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls).toHaveLength(4);
        expect(calls[0][1]).toEqual([]);
        expect(calls[1][1]).toEqual([]);
        expect(calls[2][1]).toEqual([]);
        expect(calls[3][1]).toEqual([]);
    });
});
