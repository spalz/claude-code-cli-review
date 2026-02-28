import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn(), logCat: vi.fn() }));
vi.mock("child_process", () => ({ execSync: vi.fn() }));

import { FileReview, buildMergedContent, buildFinalContent, rebuildMerged } from "../review";
import { makeHunk } from "./helpers";
import type { Hunk } from "../../types";

describe("FileReview", () => {
	it("sets changeType=create when originalContent is empty", () => {
		const r = new FileReview("/f", "", "content", [makeHunk()]);
		expect(r.changeType).toBe("create");
	});

	it("sets changeType=delete when modifiedContent is empty", () => {
		const r = new FileReview("/f", "content", "", [makeHunk()]);
		expect(r.changeType).toBe("delete");
	});

	it("sets changeType=edit when both non-empty", () => {
		const r = new FileReview("/f", "a", "b", [makeHunk()]);
		expect(r.changeType).toBe("edit");
	});

	it("explicit changeType overrides auto-detection", () => {
		const r = new FileReview("/f", "", "content", [makeHunk()], "edit");
		expect(r.changeType).toBe("edit");
	});

	it("unresolvedCount counts unresolved hunks", () => {
		const h1 = makeHunk({ id: 0, resolved: false });
		const h2 = makeHunk({ id: 1, resolved: true });
		const r = new FileReview("/f", "a", "b", [h1, h2]);
		expect(r.unresolvedCount).toBe(1);
	});

	it("isFullyResolved when all hunks resolved", () => {
		const h1 = makeHunk({ id: 0, resolved: true });
		const h2 = makeHunk({ id: 1, resolved: true });
		const r = new FileReview("/f", "a", "b", [h1, h2]);
		expect(r.isFullyResolved).toBe(true);
	});

	it("isFullyResolved=false when any hunk unresolved", () => {
		const r = new FileReview("/f", "a", "b", [makeHunk({ resolved: false })]);
		expect(r.isFullyResolved).toBe(false);
	});
});

describe("buildMergedContent", () => {
	it("unresolved hunk shows only added lines (hover-based approach)", () => {
		const hunk = makeHunk({ id: 0, modStart: 1, removed: ["old"], added: ["new"] });
		const { lines, ranges } = buildMergedContent(["new"], [hunk]);
		expect(lines).not.toContain("old");
		expect(lines).toContain("new");
		expect(ranges).toHaveLength(1);
		expect(ranges[0].hunkId).toBe(0);
		expect(ranges[0].removedStart).toBe(ranges[0].addedStart);
		expect(ranges[0].removedEnd).toBe(ranges[0].addedStart);
	});

	it("resolved+accepted hunk shows only added lines", () => {
		const hunk = makeHunk({ id: 0, modStart: 1, resolved: true, accepted: true, removed: ["old"], added: ["new"] });
		const { lines, ranges } = buildMergedContent(["new"], [hunk]);
		expect(lines).toContain("new");
		expect(lines).not.toContain("old");
		expect(ranges).toHaveLength(0);
	});

	it("resolved+rejected hunk shows only removed lines", () => {
		const hunk = makeHunk({ id: 0, modStart: 1, resolved: true, accepted: false, removed: ["old"], added: ["new"] });
		const { lines, ranges } = buildMergedContent(["new"], [hunk]);
		expect(lines).toContain("old");
		expect(lines).not.toContain("new");
		expect(ranges).toHaveLength(0);
	});

	it("preserves context lines between hunks", () => {
		const h1 = makeHunk({ id: 0, modStart: 1, modCount: 1, removed: ["old1"], added: ["new1"] });
		const h2 = makeHunk({ id: 1, modStart: 3, modCount: 1, removed: ["old2"], added: ["new2"] });
		const modLines = ["new1", "ctx", "new2"];
		const { lines } = buildMergedContent(modLines, [h1, h2]);
		expect(lines).toContain("ctx");
	});

	it("empty hunks array returns modified lines only", () => {
		const { lines, ranges } = buildMergedContent(["a", "b"], []);
		expect(lines).toEqual(["a", "b"]);
		expect(ranges).toEqual([]);
	});

	it("ranges.hunkId matches hunk.id", () => {
		const hunk = makeHunk({ id: 42, modStart: 1 });
		const { ranges } = buildMergedContent(["new line"], [hunk]);
		expect(ranges[0].hunkId).toBe(42);
	});

	it("handles multiple hunks with mixed resolved/unresolved", () => {
		const h1 = makeHunk({ id: 0, modStart: 1, modCount: 1, resolved: true, accepted: true, removed: ["old1"], added: ["new1"] });
		const h2 = makeHunk({ id: 1, modStart: 2, modCount: 1, removed: ["old2"], added: ["new2"] });
		const { lines, ranges } = buildMergedContent(["new1", "new2"], [h1, h2]);
		expect(ranges).toHaveLength(1); // only h2 unresolved
		expect(ranges[0].hunkId).toBe(1);
		expect(lines).toContain("new1"); // accepted
		expect(lines).not.toContain("old2"); // unresolved only has added lines
		expect(lines).toContain("new2");
	});
});

describe("buildFinalContent", () => {
	function makeReview(hunks: Hunk[], orig: string, mod: string) {
		return new FileReview("/f", orig, mod, hunks);
	}

	it("all accepted returns modifiedContent", () => {
		const h = makeHunk({ resolved: true, accepted: true });
		const r = makeReview([h], "orig", "mod");
		expect(buildFinalContent(r)).toBe("mod");
	});

	it("all rejected returns originalContent", () => {
		const h = makeHunk({ resolved: true, accepted: false });
		const r = makeReview([h], "orig", "mod");
		expect(buildFinalContent(r)).toBe("orig");
	});

	it("mixed: reconstructs from original + accepted hunks", () => {
		const orig = "line1\nold2\nold3\nline4";
		const mod = "line1\nnew2\nnew3\nline4";
		const h1 = makeHunk({ id: 0, origStart: 2, origCount: 1, modStart: 2, modCount: 1, removed: ["old2"], added: ["new2"], resolved: true, accepted: true });
		const h2 = makeHunk({ id: 1, origStart: 3, origCount: 1, modStart: 3, modCount: 1, removed: ["old3"], added: ["new3"], resolved: true, accepted: false });
		const r = makeReview([h1, h2], orig, mod);
		const result = buildFinalContent(r);
		expect(result).toBe("line1\nnew2\nold3\nline4");
	});
});

describe("rebuildMerged", () => {
	it("updates mergedLines and hunkRanges after resolve", () => {
		const h1 = makeHunk({ id: 0, modStart: 1, modCount: 1, removed: ["old"], added: ["new"], resolved: true, accepted: true });
		const review = new FileReview("/f", "old", "new", [h1]);
		rebuildMerged(review);
		expect(review.mergedLines).toContain("new");
		expect(review.hunkRanges).toHaveLength(0); // all resolved
	});
});
