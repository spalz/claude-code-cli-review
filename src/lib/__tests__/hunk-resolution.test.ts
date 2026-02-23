import { describe, it, expect } from "vitest";
import { buildMergedContent } from "../review";
import type { Hunk } from "../../types";

function makeHunk(id: number, origStart: number, removed: string[], modStart: number, added: string[], resolved = false, accepted = false): Hunk {
	return { id, origStart, origCount: removed.length, modStart, modCount: added.length, removed, added, resolved, accepted };
}

describe("buildMergedContent — targeted edit consistency", () => {
	it("pure addition accept: no lines to delete (deleteStart === deleteEnd)", () => {
		// Hunk adds lines but removes nothing → when accepted, removed range is empty
		const h = makeHunk(0, 1, [], 1, ["new line A", "new line B"]);
		const modLines = ["new line A", "new line B", "existing"];
		const { lines, ranges } = buildMergedContent(modLines, [h]);
		expect(ranges).toHaveLength(1);
		// removedStart === removedEnd → no lines to delete
		expect(ranges[0].removedStart).toBe(ranges[0].removedEnd);

		// After resolving (accept), rebuild should have only the added + context lines
		h.resolved = true;
		h.accepted = true;
		const after = buildMergedContent(modLines, [h]);
		expect(after.lines).toEqual(["new line A", "new line B", "existing"]);
		expect(after.ranges).toHaveLength(0);
	});

	it("pure deletion reject: no lines to delete (deleteStart === deleteEnd)", () => {
		// Hunk removes lines but adds nothing → when rejected, added range is empty
		const h = makeHunk(0, 1, ["old line"], 1, []);
		const modLines = ["context"];
		const { lines, ranges } = buildMergedContent(modLines, [h]);
		expect(ranges).toHaveLength(1);
		// addedStart === addedEnd → rejecting means no added lines to delete
		expect(ranges[0].addedStart).toBe(ranges[0].addedEnd);

		// After rejecting, rebuild keeps removed lines
		h.resolved = true;
		h.accepted = false;
		const after = buildMergedContent(modLines, [h]);
		expect(after.lines).toEqual(["old line", "context"]);
	});

	it("normal accept: removed lines disappear, added stay", () => {
		const h = makeHunk(0, 1, ["old"], 1, ["new"]);
		const modLines = ["new"];
		const { ranges } = buildMergedContent(modLines, [h]);
		const deleteStart = ranges[0].removedStart;
		const deleteEnd = ranges[0].removedEnd;
		expect(deleteEnd - deleteStart).toBe(1); // one line to delete

		h.resolved = true;
		h.accepted = true;
		const after = buildMergedContent(modLines, [h]);
		expect(after.lines).toEqual(["new"]);
	});

	it("normal reject: added lines disappear, removed stay", () => {
		const h = makeHunk(0, 1, ["old"], 1, ["new"]);
		const modLines = ["new"];
		const { ranges } = buildMergedContent(modLines, [h]);
		const deleteStart = ranges[0].addedStart;
		const deleteEnd = ranges[0].addedEnd;
		expect(deleteEnd - deleteStart).toBe(1); // one line to delete

		h.resolved = true;
		h.accepted = false;
		const after = buildMergedContent(modLines, [h]);
		expect(after.lines).toEqual(["old"]);
	});

	it("last hunk in file: deleteEnd equals total line count", () => {
		const h = makeHunk(0, 2, ["last-old"], 2, ["last-new"]);
		const modLines = ["context", "last-new"];
		const { lines, ranges } = buildMergedContent(modLines, [h]);
		// Lines: context, last-old, last-new
		expect(lines).toEqual(["context", "last-old", "last-new"]);
		// Accepting → delete removed (last-old), which is the second-to-last line
		// deleteEnd for removed = ranges[0].removedEnd
		expect(ranges[0].removedEnd).toBe(2);
		expect(ranges[0].addedEnd).toBe(lines.length); // deleteEnd === lineCount edge case
	});

	it("multiple hunks: sequential resolution keeps consistent mergedLines length", () => {
		const h0 = makeHunk(0, 1, ["a"], 1, ["A"]);
		const h1 = makeHunk(1, 2, ["b"], 2, ["B"]);
		const modLines = ["A", "B"];

		// Both unresolved
		const m0 = buildMergedContent(modLines, [h0, h1]);
		expect(m0.lines).toEqual(["a", "A", "b", "B"]); // removed+added for each
		expect(m0.ranges).toHaveLength(2);

		// Resolve first hunk (accept)
		h0.resolved = true;
		h0.accepted = true;
		const m1 = buildMergedContent(modLines, [h0, h1]);
		expect(m1.lines).toEqual(["A", "b", "B"]); // accepted keeps added only
		expect(m1.ranges).toHaveLength(1);

		// Resolve second hunk (reject)
		h1.resolved = true;
		h1.accepted = false;
		const m2 = buildMergedContent(modLines, [h0, h1]);
		expect(m2.lines).toEqual(["A", "b"]); // rejected keeps removed only
		expect(m2.ranges).toHaveLength(0);
	});

	it("sequential keep operations maintain consistent mergedLines count", () => {
		// Simulate: file with 5 hunks, keep them one by one
		const hunks = [
			makeHunk(0, 1, ["a"], 1, ["A"]),
			makeHunk(1, 2, ["b"], 2, ["B"]),
			makeHunk(2, 3, ["c"], 3, ["C"]),
			makeHunk(3, 4, ["d"], 4, ["D"]),
			makeHunk(4, 5, ["e"], 5, ["E"]),
		];
		const modLines = ["A", "B", "C", "D", "E"];

		// Initial: 5 unresolved hunks, 10 merged lines (old+new for each)
		const m0 = buildMergedContent(modLines, hunks);
		expect(m0.ranges).toHaveLength(5);
		expect(m0.lines).toHaveLength(10);

		// Resolve first 3 hunks (accept)
		for (let i = 0; i < 3; i++) {
			hunks[i].resolved = true;
			hunks[i].accepted = true;
		}
		const m1 = buildMergedContent(modLines, hunks);
		expect(m1.ranges).toHaveLength(2); // 2 unresolved remain
		expect(m1.lines).toHaveLength(7); // 3 accepted (just new) + 2 unresolved (old+new each)

		// Resolve 4th hunk (reject)
		hunks[3].resolved = true;
		hunks[3].accepted = false;
		const m2 = buildMergedContent(modLines, hunks);
		expect(m2.ranges).toHaveLength(1);
		expect(m2.lines).toHaveLength(6); // 3 accepted + 1 rejected (just old) + 1 unresolved (old+new)
	});

	it("pre-rebuild content equals editor buffer for targeted edit validation", () => {
		// This tests the invariant that preMergedContent before rebuild
		// should match what the editor buffer contains
		const hunks = [
			makeHunk(0, 1, ["old1"], 1, ["new1"]),
			makeHunk(1, 2, ["old2"], 2, ["new2"]),
		];
		const modLines = ["new1", "new2"];

		const before = buildMergedContent(modLines, hunks);
		const preMergedContent = before.lines.join("\n");

		// Resolve hunk 0
		hunks[0].resolved = true;
		hunks[0].accepted = true;
		const after = buildMergedContent(modLines, hunks);

		// After resolve, merged content changed — but preMergedContent still represents
		// what the buffer should have had before the rebuild
		expect(after.lines.join("\n")).not.toBe(preMergedContent);
		// The range for the resolved hunk should indicate what to delete from preMergedContent
		// In the pre-rebuild state, hunk 0 had removedStart=0, removedEnd=1
		expect(before.ranges[0].removedStart).toBe(0);
		expect(before.ranges[0].removedEnd).toBe(1);
	});

	it("undo restores hunkRanges to previous state", () => {
		const makeHunks = () => [
			makeHunk(0, 1, ["old1"], 1, ["new1"]),
			makeHunk(1, 2, ["old2"], 2, ["new2"]),
		];

		const modLines = ["new1", "new2"];
		const hunks = makeHunks();
		const before = buildMergedContent(modLines, hunks);
		expect(before.ranges).toHaveLength(2);

		// Simulate resolve
		hunks[0].resolved = true;
		hunks[0].accepted = true;
		const after = buildMergedContent(modLines, hunks);
		expect(after.ranges).toHaveLength(1);

		// Simulate undo — recreate hunks from snapshot
		const undoHunks = makeHunks();
		const restored = buildMergedContent(modLines, undoHunks);
		expect(restored.ranges).toHaveLength(2);
		expect(restored.lines).toEqual(before.lines);
	});
});
