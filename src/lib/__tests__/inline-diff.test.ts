import { describe, it, expect } from "vitest";
import { computeInlineChanges, computeHunkInlineChanges } from "../inline-diff";

describe("computeInlineChanges", () => {
	it("returns empty for identical lines", () => {
		const { removedChanges, addedChanges } = computeInlineChanges("hello world", "hello world");
		expect(removedChanges).toEqual([]);
		expect(addedChanges).toEqual([]);
	});

	it("returns full range when removed is empty", () => {
		const { removedChanges, addedChanges } = computeInlineChanges("", "hello world");
		expect(removedChanges).toEqual([]);
		expect(addedChanges).toEqual([{ start: 0, end: 11 }]);
	});

	it("returns full range when added is empty", () => {
		const { removedChanges, addedChanges } = computeInlineChanges("hello world", "");
		expect(removedChanges).toEqual([{ start: 0, end: 11 }]);
		expect(addedChanges).toEqual([]);
	});

	it("highlights single word change", () => {
		const { removedChanges, addedChanges } = computeInlineChanges(
			"const x = 1;",
			"const x = 2;",
		);
		// "1;" changed to "2;" — both are single tokens
		expect(removedChanges.length).toBeGreaterThan(0);
		expect(addedChanges.length).toBeGreaterThan(0);
		// Common tokens "const", "x", "=" should not be highlighted
		expect(removedChanges[0].start).toBeGreaterThan(0);
		expect(addedChanges[0].start).toBeGreaterThan(0);
	});

	it("highlights only changed token in middle of line", () => {
		const { removedChanges, addedChanges } = computeInlineChanges(
			"function foo(bar) {",
			"function baz(bar) {",
		);
		// "foo(bar)" vs "baz(bar)" — "foo(bar)" and "baz(bar)" are single \S+ tokens
		expect(removedChanges).toHaveLength(1);
		expect(addedChanges).toHaveLength(1);
	});

	it("handles purely whitespace lines", () => {
		const { removedChanges, addedChanges } = computeInlineChanges("  ", "    ");
		expect(removedChanges.length).toBeGreaterThanOrEqual(0);
		expect(addedChanges.length).toBeGreaterThanOrEqual(0);
	});

	it("handles lines with special characters", () => {
		const { removedChanges, addedChanges } = computeInlineChanges(
			'import { a } from "./old";',
			'import { a } from "./new";',
		);
		expect(removedChanges.length).toBeGreaterThan(0);
		expect(addedChanges.length).toBeGreaterThan(0);
	});

	it("handles completely different lines", () => {
		const { removedChanges, addedChanges } = computeInlineChanges(
			"alpha beta gamma",
			"one two three",
		);
		// No common tokens — each word highlighted separately (whitespace between is also unmatched)
		expect(removedChanges.length).toBeGreaterThan(0);
		expect(addedChanges.length).toBeGreaterThan(0);
		// First change starts at 0, last change ends at line length
		expect(removedChanges[0].start).toBe(0);
		expect(removedChanges[removedChanges.length - 1].end).toBe(16);
		expect(addedChanges[0].start).toBe(0);
		expect(addedChanges[addedChanges.length - 1].end).toBe(13);
	});
});

describe("computeHunkInlineChanges", () => {
	it("returns empty arrays for empty inputs", () => {
		const result = computeHunkInlineChanges([], []);
		expect(result.removedLineChanges).toEqual([]);
		expect(result.addedLineChanges).toEqual([]);
	});

	it("pairs lines by index", () => {
		const result = computeHunkInlineChanges(
			["const a = 1;"],
			["const a = 2;"],
		);
		expect(result.removedLineChanges).toHaveLength(1);
		expect(result.addedLineChanges).toHaveLength(1);
		// Should have character-level changes, not full-line
		expect(result.removedLineChanges[0][0].start).toBeGreaterThan(0);
	});

	it("marks unpaired added lines as fully changed", () => {
		const result = computeHunkInlineChanges(
			["old"],
			["new1", "new2", "new3"],
		);
		// First line paired, next two unpaired
		expect(result.addedLineChanges).toHaveLength(3);
		expect(result.addedLineChanges[1]).toEqual([{ start: 0, end: 4 }]);
		expect(result.addedLineChanges[2]).toEqual([{ start: 0, end: 4 }]);
	});

	it("marks unpaired removed lines as fully changed", () => {
		const result = computeHunkInlineChanges(
			["old1", "old2", "old3"],
			["new"],
		);
		expect(result.removedLineChanges).toHaveLength(3);
		expect(result.removedLineChanges[1]).toEqual([{ start: 0, end: 4 }]);
		expect(result.removedLineChanges[2]).toEqual([{ start: 0, end: 4 }]);
	});

	it("handles only removed lines (no added)", () => {
		const result = computeHunkInlineChanges(["a", "b"], []);
		expect(result.removedLineChanges).toHaveLength(2);
		expect(result.addedLineChanges).toHaveLength(0);
		expect(result.removedLineChanges[0]).toEqual([{ start: 0, end: 1 }]);
	});

	it("handles only added lines (no removed)", () => {
		const result = computeHunkInlineChanges([], ["a", "b"]);
		expect(result.removedLineChanges).toHaveLength(0);
		expect(result.addedLineChanges).toHaveLength(2);
		expect(result.addedLineChanges[0]).toEqual([{ start: 0, end: 1 }]);
	});
});
