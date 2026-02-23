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

vi.mock("../log", () => ({ log: vi.fn() }));

import { applyDecorations, clearDecorations } from "../decorations";
import type { IFileReview, Hunk, HunkRange } from "../../types";

function makeEditor() {
	return {
		setDecorations: vi.fn(),
		document: { uri: { fsPath: "/test/file.ts" } },
	} as unknown as import("vscode").TextEditor;
}

function makeReview(hunks: Hunk[], hunkRanges: HunkRange[]): IFileReview {
	return {
		filePath: "/test/file.ts",
		originalContent: "",
		modifiedContent: "",
		changeType: "edit",
		hunks,
		mergedLines: [],
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

	it("sets correct ranges for added and removed lines", () => {
		const hunks = [makeHunk({ id: 1, removed: ["old"], added: ["new1", "new2"] })];
		const ranges: HunkRange[] = [
			{ hunkId: 1, removedStart: 5, removedEnd: 6, addedStart: 6, addedEnd: 8 },
		];
		const review = makeReview(hunks, ranges);

		applyDecorations(editor, review);

		const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls).toHaveLength(3);

		// First call: removed decorations
		const removedRanges = calls[0][1];
		expect(removedRanges).toHaveLength(1);
		expect(removedRanges[0].start.line).toBe(5);

		// Second call: added decorations
		const addedRanges = calls[1][1];
		expect(addedRanges).toHaveLength(2);
		expect(addedRanges[0].start.line).toBe(6);
		expect(addedRanges[1].start.line).toBe(7);

		// Third call: separator decorations
		const sepRanges = calls[2][1];
		expect(sepRanges).toHaveLength(1);
		expect(sepRanges[0].start.line).toBe(5);
	});

	it("skips resolved hunks", () => {
		const hunks = [makeHunk({ id: 1, resolved: true, removed: ["x"], added: ["y"] })];
		const ranges: HunkRange[] = [
			{ hunkId: 1, removedStart: 0, removedEnd: 1, addedStart: 1, addedEnd: 2 },
		];
		const review = makeReview(hunks, ranges);

		applyDecorations(editor, review);

		const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
		// All three decoration sets should be empty arrays
		expect(calls[0][1]).toHaveLength(0);
		expect(calls[1][1]).toHaveLength(0);
		expect(calls[2][1]).toHaveLength(0);
	});

	it("handles empty hunkRanges", () => {
		const review = makeReview([], []);

		applyDecorations(editor, review);

		const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls).toHaveLength(3);
		expect(calls[0][1]).toHaveLength(0);
		expect(calls[1][1]).toHaveLength(0);
		expect(calls[2][1]).toHaveLength(0);
	});

	it("handles hunkRange with no matching hunk", () => {
		const hunks: Hunk[] = [];
		const ranges: HunkRange[] = [
			{ hunkId: 999, removedStart: 0, removedEnd: 1, addedStart: 1, addedEnd: 2 },
		];
		const review = makeReview(hunks, ranges);

		applyDecorations(editor, review);

		const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls[0][1]).toHaveLength(0);
		expect(calls[1][1]).toHaveLength(0);
		expect(calls[2][1]).toHaveLength(0);
	});

	it("handles hunk with only removals (no added lines)", () => {
		const hunks = [makeHunk({ id: 1, removed: ["a", "b"], added: [] })];
		const ranges: HunkRange[] = [
			{ hunkId: 1, removedStart: 3, removedEnd: 5, addedStart: 5, addedEnd: 5 },
		];
		const review = makeReview(hunks, ranges);

		applyDecorations(editor, review);

		const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls[0][1]).toHaveLength(2); // removed
		expect(calls[1][1]).toHaveLength(0); // added
	});

	it("handles hunk with only additions (no removed lines)", () => {
		const hunks = [makeHunk({ id: 1, removed: [], added: ["new"] })];
		const ranges: HunkRange[] = [
			{ hunkId: 1, removedStart: 3, removedEnd: 3, addedStart: 3, addedEnd: 4 },
		];
		const review = makeReview(hunks, ranges);

		applyDecorations(editor, review);

		const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls[0][1]).toHaveLength(0); // removed
		expect(calls[1][1]).toHaveLength(1); // added
		// separator at addedStart since removedStart == removedEnd
		expect(calls[2][1]).toHaveLength(1);
		expect(calls[2][1][0].start.line).toBe(3);
	});

	it("does not add separator when firstLine is 0", () => {
		const hunks = [makeHunk({ id: 1, removed: ["x"], added: ["y"] })];
		const ranges: HunkRange[] = [
			{ hunkId: 1, removedStart: 0, removedEnd: 1, addedStart: 1, addedEnd: 2 },
		];
		const review = makeReview(hunks, ranges);

		applyDecorations(editor, review);

		const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls[2][1]).toHaveLength(0); // no separator
	});

	it("handles multiple unresolved hunks", () => {
		const hunks = [
			makeHunk({ id: 1, removed: ["a"], added: ["b"] }),
			makeHunk({ id: 2, removed: ["c"], added: ["d", "e"] }),
		];
		const ranges: HunkRange[] = [
			{ hunkId: 1, removedStart: 2, removedEnd: 3, addedStart: 3, addedEnd: 4 },
			{ hunkId: 2, removedStart: 10, removedEnd: 11, addedStart: 11, addedEnd: 13 },
		];
		const review = makeReview(hunks, ranges);

		applyDecorations(editor, review);

		const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls[0][1]).toHaveLength(2); // 1 + 1 removed
		expect(calls[1][1]).toHaveLength(3); // 1 + 2 added
		expect(calls[2][1]).toHaveLength(2); // 2 separators
	});

	it("mixes resolved and unresolved hunks", () => {
		const hunks = [
			makeHunk({ id: 1, resolved: true, removed: ["a"], added: ["b"] }),
			makeHunk({ id: 2, removed: ["c"], added: ["d"] }),
		];
		const ranges: HunkRange[] = [
			{ hunkId: 1, removedStart: 2, removedEnd: 3, addedStart: 3, addedEnd: 4 },
			{ hunkId: 2, removedStart: 10, removedEnd: 11, addedStart: 11, addedEnd: 12 },
		];
		const review = makeReview(hunks, ranges);

		applyDecorations(editor, review);

		const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls[0][1]).toHaveLength(1); // only hunk 2 removed
		expect(calls[1][1]).toHaveLength(1); // only hunk 2 added
	});
});

describe("clearDecorations", () => {
	it("calls setDecorations with empty arrays for all three types", () => {
		const editor = makeEditor();

		clearDecorations(editor);

		const calls = (editor.setDecorations as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls).toHaveLength(3);
		expect(calls[0][1]).toEqual([]);
		expect(calls[1][1]).toEqual([]);
		expect(calls[2][1]).toEqual([]);
	});
});
