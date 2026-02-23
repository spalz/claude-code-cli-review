import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn() }));

import { ReviewCodeLensProvider } from "../codelens";
import * as state from "../state";
import { makeHunk } from "./helpers";
import type { IFileReview, HunkRange } from "../../types";

function makeHunkRange(overrides?: Partial<HunkRange>): HunkRange {
	return {
		hunkId: 0,
		removedStart: 1,
		removedEnd: 2,
		addedStart: 2,
		addedEnd: 3,
		...overrides,
	};
}

function makeFakeReview(overrides?: Partial<IFileReview>): IFileReview {
	const hunks = overrides?.hunks ?? [makeHunk({ id: 0 })];
	const hunkRanges = overrides?.hunkRanges ?? [makeHunkRange({ hunkId: 0 })];
	return {
		filePath: "/test/file.ts",
		originalContent: "old",
		modifiedContent: "new",
		changeType: "edit",
		hunks,
		mergedLines: ["line1", "line2", "line3", "line4"],
		hunkRanges,
		get unresolvedCount() {
			return this.hunks.filter((h) => !h.resolved).length;
		},
		get isFullyResolved() {
			return this.unresolvedCount === 0;
		},
		...overrides,
	};
}

function makeDocument(fsPath: string, lineCount = 100) {
	return {
		uri: { fsPath },
		lineCount,
	} as unknown as import("vscode").TextDocument;
}

describe("ReviewCodeLensProvider", () => {
	let provider: ReviewCodeLensProvider;

	beforeEach(() => {
		provider = new ReviewCodeLensProvider();
		state.activeReviews.clear();
		state.setReviewFiles([]);
	});

	it("returns empty array for non-review files", () => {
		const doc = makeDocument("/some/random/file.ts");
		const lenses = provider.provideCodeLenses(doc);
		expect(lenses).toEqual([]);
	});

	it("returns Keep and Undo lenses for a single unresolved hunk", () => {
		const review = makeFakeReview();
		state.activeReviews.set("/test/file.ts", review);

		const doc = makeDocument("/test/file.ts");
		const lenses = provider.provideCodeLenses(doc);

		expect(lenses).toHaveLength(2);
		expect(lenses[0].command?.title).toBe("$(check) Keep");
		expect(lenses[0].command?.command).toBe("ccr.acceptHunk");
		expect(lenses[0].command?.arguments).toEqual(["/test/file.ts", 0]);
		expect(lenses[1].command?.title).toBe("$(discard) Undo");
		expect(lenses[1].command?.command).toBe("ccr.rejectHunk");
		expect(lenses[1].command?.arguments).toEqual(["/test/file.ts", 0]);
	});

	it("places lenses on removedStart when removedStart < removedEnd", () => {
		const review = makeFakeReview({
			hunkRanges: [makeHunkRange({ hunkId: 0, removedStart: 5, removedEnd: 8, addedStart: 10, addedEnd: 12 })],
		});
		state.activeReviews.set("/test/file.ts", review);

		const doc = makeDocument("/test/file.ts");
		const lenses = provider.provideCodeLenses(doc);

		expect(lenses[0].range.start.line).toBe(5);
	});

	it("places lenses on addedStart when removedStart equals removedEnd", () => {
		const review = makeFakeReview({
			hunkRanges: [makeHunkRange({ hunkId: 0, removedStart: 3, removedEnd: 3, addedStart: 4, addedEnd: 6 })],
		});
		state.activeReviews.set("/test/file.ts", review);

		const doc = makeDocument("/test/file.ts");
		const lenses = provider.provideCodeLenses(doc);

		expect(lenses[0].range.start.line).toBe(4);
	});

	it("shows hunk counter when multiple unresolved hunks exist", () => {
		const hunks = [
			makeHunk({ id: 0, resolved: false }),
			makeHunk({ id: 1, resolved: false }),
		];
		const hunkRanges = [
			makeHunkRange({ hunkId: 0, removedStart: 1, removedEnd: 2 }),
			makeHunkRange({ hunkId: 1, removedStart: 5, removedEnd: 6 }),
		];
		const review = makeFakeReview({ hunks, hunkRanges });
		state.activeReviews.set("/test/file.ts", review);

		const doc = makeDocument("/test/file.ts");
		const lenses = provider.provideCodeLenses(doc);

		// Each hunk: Keep + Undo + counter = 3 lenses per hunk, total 6
		expect(lenses).toHaveLength(6);
		// First hunk counter
		expect(lenses[2].command?.title).toBe("1/2");
		expect(lenses[2].command?.tooltip).toBe("Change 1 of 2");
		expect(lenses[2].command?.command).toBe("");
		// Second hunk counter
		expect(lenses[5].command?.title).toBe("2/2");
		expect(lenses[5].command?.tooltip).toBe("Change 2 of 2");
	});

	it("does not show hunk counter for single unresolved hunk", () => {
		const review = makeFakeReview();
		state.activeReviews.set("/test/file.ts", review);

		const doc = makeDocument("/test/file.ts");
		const lenses = provider.provideCodeLenses(doc);

		// Only Keep + Undo, no counter
		expect(lenses).toHaveLength(2);
	});

	it("skips resolved hunks entirely", () => {
		const hunks = [
			makeHunk({ id: 0, resolved: true, accepted: true }),
			makeHunk({ id: 1, resolved: false }),
		];
		const hunkRanges = [
			makeHunkRange({ hunkId: 0, removedStart: 1, removedEnd: 2 }),
			makeHunkRange({ hunkId: 1, removedStart: 5, removedEnd: 6 }),
		];
		const review = makeFakeReview({ hunks, hunkRanges });
		state.activeReviews.set("/test/file.ts", review);

		const doc = makeDocument("/test/file.ts");
		const lenses = provider.provideCodeLenses(doc);

		// Only hunk 1 gets lenses (Keep + Undo, no counter since only 1 unresolved)
		expect(lenses).toHaveLength(2);
		expect(lenses[0].command?.arguments).toEqual(["/test/file.ts", 1]);
	});

	it("does not show next file lens (removed feature)", () => {
		const review = makeFakeReview();
		state.activeReviews.set("/test/file.ts", review);
		state.activeReviews.set("/test/other.ts", makeFakeReview({ filePath: "/test/other.ts" }));
		state.setReviewFiles(["/test/file.ts", "/test/other.ts"]);

		const doc = makeDocument("/test/file.ts");
		const lenses = provider.provideCodeLenses(doc);

		// No "Next file" lens — only Keep + Undo + counter
		expect(lenses.every((l) => l.command?.command !== "ccr.reviewNextUnresolved")).toBe(true);
	});

	it("does not show next file lens when reviewFiles lists files not in activeReviews", () => {
		const review = makeFakeReview();
		state.activeReviews.set("/test/file.ts", review);
		// second file listed but not in activeReviews
		state.setReviewFiles(["/test/file.ts", "/test/gone.ts"]);

		const doc = makeDocument("/test/file.ts");
		const lenses = provider.provideCodeLenses(doc);

		expect(lenses.every((l) => l.command?.command !== "ccr.reviewNextUnresolved")).toBe(true);
	});

	it("returns empty when all hunks are resolved", () => {
		const hunks = [makeHunk({ id: 0, resolved: true, accepted: true })];
		const hunkRanges = [makeHunkRange({ hunkId: 0 })];
		const review = makeFakeReview({ hunks, hunkRanges });
		state.activeReviews.set("/test/file.ts", review);

		const doc = makeDocument("/test/file.ts");
		const lenses = provider.provideCodeLenses(doc);

		expect(lenses).toHaveLength(0);
	});

	it("no next file lens even with large hunk ranges", () => {
		const review = makeFakeReview({
			hunkRanges: [makeHunkRange({ hunkId: 0, addedEnd: 999 })],
		});
		state.activeReviews.set("/test/file.ts", review);
		state.activeReviews.set("/test/other.ts", makeFakeReview());
		state.setReviewFiles(["/test/file.ts", "/test/other.ts"]);

		const doc = makeDocument("/test/file.ts", 10);
		const lenses = provider.provideCodeLenses(doc);

		expect(lenses.every((l) => l.command?.command !== "ccr.reviewNextUnresolved")).toBe(true);
	});

	it("refresh fires onDidChangeCodeLenses event", () => {
		const listener = vi.fn();
		provider.onDidChangeCodeLenses(listener);
		provider.refresh();
		expect(listener).toHaveBeenCalledOnce();
	});
});
