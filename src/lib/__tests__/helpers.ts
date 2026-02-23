// Test data factories
import type { Hunk } from "../../types";

export function makeHunk(overrides?: Partial<Hunk>): Hunk {
	return {
		id: 0,
		origStart: 1,
		origCount: 1,
		modStart: 1,
		modCount: 1,
		removed: ["old line"],
		added: ["new line"],
		resolved: false,
		accepted: false,
		...overrides,
	};
}

export function makeUnifiedDiff(
	hunks: Array<{ removed?: string[]; added?: string[]; origStart?: number; modStart?: number }>,
): string {
	const lines: string[] = ["diff --git a/file b/file", "--- a/file", "+++ b/file"];
	for (const h of hunks) {
		const removed = h.removed ?? [];
		const added = h.added ?? [];
		const os = h.origStart ?? 1;
		const ms = h.modStart ?? 1;
		lines.push(`@@ -${os},${removed.length} +${ms},${added.length} @@`);
		for (const r of removed) lines.push(`-${r}`);
		for (const a of added) lines.push(`+${a}`);
	}
	return lines.join("\n");
}
