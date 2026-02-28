import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeUnifiedDiff } from "./helpers";

vi.mock("../log", () => ({ log: vi.fn(), logCat: vi.fn() }));

// Hoisted mocks for fs and child_process — used by computeDiff tests.
// parseUnifiedDiff is a pure function and doesn't use these.
const mockFs = vi.hoisted(() => ({
	writeFileSync: vi.fn(),
	unlinkSync: vi.fn(),
}));
vi.mock("fs", () => mockFs);

const mockExecSync = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ execSync: mockExecSync }));

import { parseUnifiedDiff, computeDiff } from "../diff";

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
		vi.clearAllMocks();
		// Default: git diff --no-index returns a simple diff
		mockExecSync.mockImplementation((cmd: string) => {
			if (typeof cmd === "string" && cmd.includes("git diff --no-index")) {
				const err = new Error("diff") as Error & { stdout: string };
				err.stdout = "@@ -1,1 +1,1 @@\n-original\n+modified";
				throw err;
			}
			return "";
		});
	});

	it("returns single create hunk for untracked new file", () => {
		const hunks = computeDiff("", "line1\nline2", "/ws/file.ts", "/ws");
		expect(hunks).toHaveLength(1);
		expect(hunks[0].added).toEqual(["line1", "line2"]);
		expect(hunks[0].removed).toEqual([]);
	});

	it("returns empty array when contents are identical", () => {
		// git diff --no-index with identical content returns empty string
		mockExecSync.mockReturnValue("");
		const hunks = computeDiff("same", "same", "/ws/file.ts", "/ws");
		expect(hunks).toEqual([]);
	});

	it("uses diffTempFiles (git diff --no-index) instead of git diff HEAD", () => {
		mockExecSync.mockImplementation((cmd: string) => {
			if (typeof cmd === "string" && cmd.includes("git diff --no-index")) {
				const err = new Error("diff") as Error & { stdout: string };
				err.stdout = "@@ -1,1 +1,1 @@\n-old line\n+new line";
				throw err;
			}
			return "";
		});
		const hunks = computeDiff("old line", "new line", "/ws/file.ts", "/ws");
		expect(hunks).toHaveLength(1);
		expect(hunks[0].removed).toEqual(["old line"]);
		expect(hunks[0].added).toEqual(["new line"]);
		// Verify git diff HEAD was NOT called
		const calls = mockExecSync.mock.calls.map(c => c[0] as string);
		expect(calls.some(c => c.includes("git diff HEAD"))).toBe(false);
		expect(calls.some(c => c.includes("git diff --no-index"))).toBe(true);
	});

	it("normalizes trailing newlines to prevent spurious last-line diffs", () => {
		const writtenContents: string[] = [];
		mockFs.writeFileSync.mockImplementation((_path: string, content: string) => {
			writtenContents.push(content);
		});
		mockExecSync.mockImplementation((cmd: string) => {
			if (typeof cmd === "string" && cmd.includes("git diff --no-index")) {
				const err = new Error("diff") as Error & { stdout: string };
				err.stdout = "@@ -3,3 +3,0 @@\n-\n-// NOTE\n-// see";
				throw err;
			}
			return "";
		});

		// Original ends with \n, modified does NOT — normalization should add \n
		const original = "line1\nline2\nline3\n";
		const modified = "line1\nline2\nline3";  // no trailing newline
		computeDiff(original, modified, "/ws/file.ts", "/ws");

		// Both temp files should have trailing newline (normalization)
		expect(writtenContents.length).toBeGreaterThanOrEqual(2);
		expect(writtenContents[0].endsWith("\n")).toBe(true);
		expect(writtenContents[1].endsWith("\n")).toBe(true);
	});

	it("does not double-add newline when content already ends with \\n", () => {
		const writtenContents: string[] = [];
		mockFs.writeFileSync.mockImplementation((_path: string, content: string) => {
			writtenContents.push(content);
		});
		mockExecSync.mockReturnValue("");

		const original = "line1\nline2\n";
		const modified = "line1\nline2\n";
		computeDiff(original, modified, "/ws/file.ts", "/ws");

		// Should NOT have double newlines
		expect(writtenContents[0]).toBe("line1\nline2\n");
		expect(writtenContents[1]).toBe("line1\nline2\n");
	});
});
