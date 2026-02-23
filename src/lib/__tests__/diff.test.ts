import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseUnifiedDiff } from "../diff";
import { makeUnifiedDiff } from "./helpers";

// computeDiff requires fs/child_process — tested separately with mocks
vi.mock("../log", () => ({ log: vi.fn() }));

describe("parseUnifiedDiff", () => {
	it("parses a single hunk with removals and additions", () => {
		const diff = makeUnifiedDiff([{ removed: ["old"], added: ["new"], origStart: 1, modStart: 1 }]);
		const hunks = parseUnifiedDiff(diff);
		expect(hunks).toHaveLength(1);
		expect(hunks[0].removed).toEqual(["old"]);
		expect(hunks[0].added).toEqual(["new"]);
	});

	it("parses multiple hunks", () => {
		const diff = [
			"diff --git a/f b/f",
			"--- a/f",
			"+++ b/f",
			"@@ -1,2 +1,2 @@",
			"-a",
			"+b",
			"@@ -10,2 +10,2 @@",
			"-c",
			"+d",
		].join("\n");
		const hunks = parseUnifiedDiff(diff);
		expect(hunks).toHaveLength(2);
		expect(hunks[0].removed).toEqual(["a"]);
		expect(hunks[1].removed).toEqual(["c"]);
	});

	it("splits hunks on context lines within a @@ block", () => {
		const diff = [
			"@@ -1,5 +1,5 @@",
			"-old1",
			"+new1",
			" context",
			"-old2",
			"+new2",
		].join("\n");
		const hunks = parseUnifiedDiff(diff);
		expect(hunks).toHaveLength(2);
		expect(hunks[0].id).toBe(0);
		expect(hunks[1].id).toBe(1);
	});

	it("sub-hunks get correct positions (not header values)", () => {
		const diff = [
			"@@ -1,5 +1,5 @@",
			"-old1",
			"+new1",
			" context",
			"-old3",
			"+new3",
		].join("\n");
		const hunks = parseUnifiedDiff(diff);
		expect(hunks).toHaveLength(2);
		// First sub-hunk at position 1
		expect(hunks[0].origStart).toBe(1);
		expect(hunks[0].modStart).toBe(1);
		// Second sub-hunk: after 1 removed + 1 added + 1 context = orig pos 3, mod pos 3
		expect(hunks[1].origStart).toBe(3);
		expect(hunks[1].modStart).toBe(3);
	});

	it("sub-hunks: deletion then insertion separated by context", () => {
		const diff = [
			"@@ -1,4 +1,3 @@",
			"-deleted",
			" context",
			"+inserted",
		].join("\n");
		const hunks = parseUnifiedDiff(diff);
		expect(hunks).toHaveLength(2);
		// Deletion at orig=1, mod=1
		expect(hunks[0].origStart).toBe(1);
		expect(hunks[0].modStart).toBe(1);
		expect(hunks[0].removed).toEqual(["deleted"]);
		expect(hunks[0].added).toEqual([]);
		// Insertion at orig=3, mod=2 (after deletion removed 1 orig line, context advanced both)
		expect(hunks[1].origStart).toBe(3);
		expect(hunks[1].modStart).toBe(2);
		expect(hunks[1].removed).toEqual([]);
		expect(hunks[1].added).toEqual(["inserted"]);
	});

	it("multiple context lines between sub-hunks track positions correctly", () => {
		const diff = [
			"@@ -1,8 +1,8 @@",
			"-old1",
			"+new1",
			" ctx1",
			" ctx2",
			" ctx3",
			"-old5",
			"+new5",
		].join("\n");
		const hunks = parseUnifiedDiff(diff);
		expect(hunks).toHaveLength(2);
		expect(hunks[0].origStart).toBe(1);
		expect(hunks[0].modStart).toBe(1);
		// After first hunk (1 removed + 1 added) + 3 context: orig=5, mod=5
		expect(hunks[1].origStart).toBe(5);
		expect(hunks[1].modStart).toBe(5);
	});

	it("handles pure addition (only + lines)", () => {
		const diff = makeUnifiedDiff([{ removed: [], added: ["line1", "line2"], origStart: 1, modStart: 1 }]);
		const hunks = parseUnifiedDiff(diff);
		expect(hunks).toHaveLength(1);
		expect(hunks[0].removed).toEqual([]);
		expect(hunks[0].added).toEqual(["line1", "line2"]);
	});

	it("handles pure deletion (only - lines)", () => {
		const diff = makeUnifiedDiff([{ removed: ["gone1", "gone2"], added: [], origStart: 1, modStart: 1 }]);
		const hunks = parseUnifiedDiff(diff);
		expect(hunks).toHaveLength(1);
		expect(hunks[0].removed).toEqual(["gone1", "gone2"]);
		expect(hunks[0].added).toEqual([]);
	});

	it("returns empty array for empty input", () => {
		expect(parseUnifiedDiff("")).toEqual([]);
	});

	it("returns empty array for diff without @@ headers", () => {
		expect(parseUnifiedDiff("diff --git a/f b/f\n--- a/f\n+++ b/f\n")).toEqual([]);
	});

	it("sets correct origStart/modStart/origCount/modCount", () => {
		const diff = makeUnifiedDiff([{ removed: ["a", "b"], added: ["c"], origStart: 5, modStart: 7 }]);
		const hunks = parseUnifiedDiff(diff);
		expect(hunks[0].origStart).toBe(5);
		expect(hunks[0].modStart).toBe(7);
		expect(hunks[0].origCount).toBe(2);
		expect(hunks[0].modCount).toBe(1);
	});

	it("assigns sequential hunk ids", () => {
		const diff = [
			"@@ -1,1 +1,1 @@",
			"-a",
			"+b",
			"@@ -5,1 +5,1 @@",
			"-c",
			"+d",
		].join("\n");
		const hunks = parseUnifiedDiff(diff);
		expect(hunks.map((h) => h.id)).toEqual([0, 1]);
	});

	it("sets resolved=false and accepted=false by default", () => {
		const diff = makeUnifiedDiff([{ removed: ["x"], added: ["y"] }]);
		const hunks = parseUnifiedDiff(diff);
		expect(hunks[0].resolved).toBe(false);
		expect(hunks[0].accepted).toBe(false);
	});

	it("handles \\ No newline at end of file marker", () => {
		const diff = [
			"@@ -1,1 +1,1 @@",
			"-old",
			"\\ No newline at end of file",
			"+new",
		].join("\n");
		const hunks = parseUnifiedDiff(diff);
		expect(hunks).toHaveLength(1);
		expect(hunks[0].removed).toEqual(["old"]);
		expect(hunks[0].added).toEqual(["new"]);
	});

	it("handles mixed changes", () => {
		const diff = makeUnifiedDiff([{ removed: ["a", "b"], added: ["c", "d", "e"] }]);
		const hunks = parseUnifiedDiff(diff);
		expect(hunks[0].removed).toEqual(["a", "b"]);
		expect(hunks[0].added).toEqual(["c", "d", "e"]);
	});
});

describe("computeDiff", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("returns single create hunk for untracked new file", async () => {
		vi.doMock("child_process", () => ({
			execSync: vi.fn(() => { throw new Error("not tracked"); }),
		}));
		const { computeDiff } = await import("../diff");
		const hunks = computeDiff("", "line1\nline2", "/ws/file.ts", "/ws");
		expect(hunks).toHaveLength(1);
		expect(hunks[0].added).toEqual(["line1", "line2"]);
		expect(hunks[0].removed).toEqual([]);
	});

	it("returns empty array when both contents are empty and untracked", async () => {
		vi.doMock("child_process", () => ({
			execSync: vi.fn(() => { throw new Error("not tracked"); }),
		}));
		vi.doMock("fs", () => ({
			writeFileSync: vi.fn(),
			unlinkSync: vi.fn(),
		}));
		const { computeDiff } = await import("../diff");
		const hunks = computeDiff("same", "same", "/ws/file.ts", "/ws");
		// git diff --no-index with identical content returns empty
		expect(hunks).toEqual([]);
	});
});
