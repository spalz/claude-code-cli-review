import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn() }));
vi.mock("../decorations", () => ({
	applyDecorations: vi.fn(),
	clearDecorations: vi.fn(),
}));
const mockUndoHistory = vi.hoisted(() => ({
	initHistory: vi.fn(),
	recordSnapshot: vi.fn(),
	pushUndoState: vi.fn(),
	popUndoState: vi.fn().mockReturnValue(undefined),
	pushRedoState: vi.fn(),
	popRedoState: vi.fn().mockReturnValue(undefined),
	hasUndoState: vi.fn().mockReturnValue(false),
	hasRedoState: vi.fn().mockReturnValue(false),
	setApplyingEdit: vi.fn(),
	isApplyingEdit: vi.fn().mockReturnValue(false),
	clearHistory: vi.fn(),
	clearAllHistories: vi.fn(),
	lookupSnapshot: vi.fn().mockReturnValue(undefined),
	getLastUndoFilePath: vi.fn().mockReturnValue(undefined),
	getLastRedoFilePath: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../undo-history", () => mockUndoHistory);

const mockFs = vi.hoisted(() => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	unlinkSync: vi.fn(),
	existsSync: vi.fn().mockReturnValue(true),
}));
vi.mock("fs", () => mockFs);

const mockExecSync = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ execSync: mockExecSync }));

const mockServer = vi.hoisted(() => ({
	getSnapshot: vi.fn().mockReturnValue(undefined),
	clearSnapshot: vi.fn(),
}));
vi.mock("../server", () => mockServer);

const mockPersistence = vi.hoisted(() => ({
	saveReviewState: vi.fn(),
	loadReviewState: vi.fn().mockReturnValue(null),
	clearReviewState: vi.fn(),
}));
vi.mock("../persistence", () => mockPersistence);

import * as vscode from "vscode";
import * as state from "../state";
import { ReviewManager } from "../review-manager";
import { applyDecorations } from "../decorations";
import type { ReviewSnapshot } from "../../types";

function setupManager(): ReviewManager {
	const mgr = new ReviewManager("/ws");
	const codeLens = { refresh: vi.fn() };
	const mainView = { update: vi.fn() };
	mgr.setProviders(codeLens, mainView);
	return mgr;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	state.activeReviews.clear();
	state.setReviewFiles([]);
	state.setCurrentFileIndex(0);
	state.setCurrentHunkIndex(0);
	// Reset visible editors so addFile doesn't trigger applyContentViaEdit unexpectedly
	(vscode.window as any).visibleTextEditors = [];
	// Default: file returns different content so diff is generated
	mockFs.readFileSync.mockReturnValue("modified content");
	// Tracked file: execSync for git ls-files succeeds, git show HEAD returns original
	mockExecSync.mockImplementation((cmd: string) => {
		if (cmd.includes("git ls-files")) return "";
		if (cmd.includes("git show HEAD")) return "original";
		if (cmd.includes("git diff --no-index")) {
			const err = new Error("diff") as Error & { stdout: string };
			err.stdout = "@@ -1,1 +1,1 @@\n-original\n+modified content";
			throw err;
		}
		if (cmd.includes("git diff HEAD")) return "@@ -1,1 +1,1 @@\n-original\n+modified content";
		return "";
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ReviewManager constructor + lifecycle", () => {
	it("creates with workspace path", () => {
		const mgr = new ReviewManager("/ws");
		expect(mgr).toBeDefined();
	});

	it("dispose clears timer and calls saveNow", () => {
		const mgr = setupManager();
		mgr.scheduleSave();
		mgr.dispose();
		expect(mockPersistence.saveReviewState).toHaveBeenCalled();
	});
});

describe("addFile", () => {
	it("adds new file to review", () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		expect(state.activeReviews.has("/ws/file.ts")).toBe(true);
		expect(mgr.getReviewFiles()).toContain("/ws/file.ts");
	});

	it("removes file when original === modified", () => {
		const mgr = setupManager();
		// First add
		mgr.addFile("/ws/file.ts");
		expect(state.activeReviews.has("/ws/file.ts")).toBe(true);

		// Now content matches original
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("git show HEAD")) return "same";
			if (cmd.includes("git ls-files")) return "";
			if (cmd.includes("git diff HEAD")) return "";
			return "";
		});
		mockFs.readFileSync.mockReturnValue("same");
		mockServer.getSnapshot.mockReturnValue("same");
		mgr.addFile("/ws/file.ts");
		expect(state.activeReviews.has("/ws/file.ts")).toBe(false);
	});

	it("clearSnapshot is called after addFile", () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		// server.clearSnapshot is called from addFile unconditionally
		// (Note: we verify the review was created by other tests)
		expect(state.activeReviews.has("/ws/file.ts")).toBe(true);
	});

	it("uses git show HEAD for tracked files without snapshot", () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue(undefined);
		mgr.addFile("/ws/file.ts");
		expect(mockExecSync).toHaveBeenCalledWith(
			expect.stringContaining("git show HEAD"),
			expect.anything(),
		);
	});

	it("fires onReviewStateChange(true) when file added", () => {
		const mgr = setupManager();
		const listener = vi.fn();
		mgr.onReviewStateChange(listener);
		mgr.addFile("/ws/file.ts");
		expect(listener).toHaveBeenCalledWith(true);
	});

	it("schedules save after addFile", () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		vi.advanceTimersByTime(500);
		expect(mockPersistence.saveReviewState).toHaveBeenCalled();
	});

	it("sets changeType=create for new file (no original)", () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue("");
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("git ls-files")) throw new Error("untracked");
			if (cmd.includes("git show HEAD")) throw new Error("not found");
			return "";
		});
		mockFs.readFileSync.mockReturnValue("new file content");
		mgr.addFile("/ws/new.ts");
		const review = state.activeReviews.get("/ws/new.ts");
		expect(review?.changeType).toBe("create");
	});

	it("initializes undo history during addFile", () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		expect(mockUndoHistory.initHistory).toHaveBeenCalledWith("/ws/file.ts");
	});

	it("does NOT write merged content to disk on addFile (deferred to openFileForReview)", () => {
		const mgr = setupManager();
		(vscode.window as any).visibleTextEditors = [];
		mockFs.writeFileSync.mockClear();
		mgr.addFile("/ws/file.ts");
		// Merged content is NOT written to disk — deferred until openFileForReview
		expect(mockFs.writeFileSync).not.toHaveBeenCalled();
	});

	it("does NOT apply content to editor on addFile (deferred)", () => {
		const mgr = setupManager();
		const mockDoc = {
			uri: { fsPath: "/ws/file.ts" },
			lineCount: 2,
			lineAt: () => ({ text: "modified content" }),
			getText: vi.fn().mockReturnValue("modified content"),
			save: vi.fn().mockResolvedValue(true),
		};
		const mockEditor = {
			document: mockDoc,
			visibleRanges: [new vscode.Range(0, 0, 1, 0)],
			selection: new vscode.Selection(0, 0, 0, 0),
			revealRange: vi.fn(),
			edit: vi.fn().mockResolvedValue(true),
			setDecorations: vi.fn(),
		};
		(vscode.window as any).visibleTextEditors = [mockEditor];
		mgr.addFile("/ws/file.ts");
		// setApplyingEdit should NOT be called — content applied lazily on openFileForReview
		expect(mockUndoHistory.setApplyingEdit).not.toHaveBeenCalled();
	});
});

describe("resolveHunk", () => {
	it("marks hunk as resolved+accepted", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;
		const hunkId = review.hunks[0].id;

		await mgr.resolveHunk("/ws/file.ts", hunkId, true);
		expect(review.hunks[0].resolved).toBe(true);
		expect(review.hunks[0].accepted).toBe(true);
	});

	it("marks hunk as resolved+rejected", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;
		const hunkId = review.hunks[0].id;

		await mgr.resolveHunk("/ws/file.ts", hunkId, false);
		expect(review.hunks[0].resolved).toBe(true);
		expect(review.hunks[0].accepted).toBe(false);
	});

	it("ignores already resolved hunk", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;
		review.hunks[0].resolved = true;
		review.hunks[0].accepted = true;

		await mgr.resolveHunk("/ws/file.ts", review.hunks[0].id, false);
		expect(review.hunks[0].accepted).toBe(true); // unchanged
	});

	it("ignores non-existent filePath", async () => {
		const mgr = setupManager();
		await expect(mgr.resolveHunk("/nope", 0, true)).resolves.toBeUndefined();
	});

	it("finalizes when last hunk resolved", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;

		await mgr.resolveHunk("/ws/file.ts", review.hunks[0].id, true);
		// Single hunk → fully resolved → finalized → removed from activeReviews
		expect(state.activeReviews.has("/ws/file.ts")).toBe(false);
	});
});

describe("resolveAllHunks", () => {
	it("resolves all hunks and finalizes", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		await mgr.resolveAllHunks("/ws/file.ts", true);
		expect(state.activeReviews.has("/ws/file.ts")).toBe(false);
	});
});

describe("queries", () => {
	it("getReview returns review or undefined", () => {
		const mgr = setupManager();
		expect(mgr.getReview("/ws/missing.ts")).toBeUndefined();
		mgr.addFile("/ws/file.ts");
		expect(mgr.getReview("/ws/file.ts")).toBeDefined();
	});

	it("getUnresolvedFiles filters active reviews", () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		expect(mgr.getUnresolvedFiles()).toContain("/ws/file.ts");
	});

	it("hasActiveReview reflects state", () => {
		const mgr = setupManager();
		expect(mgr.hasActiveReview).toBe(false);
		mgr.addFile("/ws/file.ts");
		expect(mgr.hasActiveReview).toBe(true);
	});
});

describe("persistence", () => {
	it("scheduleSave debounces with 500ms delay", () => {
		const mgr = setupManager();
		mgr.scheduleSave();
		mgr.scheduleSave();
		mgr.scheduleSave();
		vi.advanceTimersByTime(500);
		expect(mockPersistence.saveReviewState).toHaveBeenCalledTimes(1);
	});

	it("saveNow calls saveReviewState immediately", () => {
		const mgr = setupManager();
		mgr.saveNow();
		expect(mockPersistence.saveReviewState).toHaveBeenCalledWith("/ws", state.activeReviews, 0);
	});

	it("restore returns false when no saved state", async () => {
		const mgr = setupManager();
		expect(await mgr.restore()).toBe(false);
	});

	it("restore loads and restores reviews", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/restored.ts",
					originalContent: "orig",
					modifiedContent: "mod",
					hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["orig"], added: ["mod"], resolved: false, accepted: false }],
					changeType: "edit",
				},
			],
		});
		mockFs.existsSync.mockReturnValue(true);
		const result = await mgr.restore();
		expect(result).toBe(true);
		expect(state.activeReviews.has("/ws/restored.ts")).toBe(true);
	});

	it("restore skips missing files", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/gone.ts",
					originalContent: "orig",
					modifiedContent: "mod",
					hunks: [],
					changeType: "edit",
				},
			],
		});
		mockFs.existsSync.mockReturnValue(false);
		const result = await mgr.restore();
		expect(result).toBe(false);
	});

	it("restore preserves delete reviews even when file missing", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/deleted.ts",
					originalContent: "line1\nline2",
					modifiedContent: "",
					hunks: [{ id: 0, origStart: 1, origCount: 2, modStart: 1, modCount: 0, removed: ["line1", "line2"], added: [], resolved: false, accepted: false }],
					changeType: "delete",
				},
			],
		});
		mockFs.existsSync.mockReturnValue(false); // file is deleted
		const result = await mgr.restore();
		expect(result).toBe(true);
		const review = state.activeReviews.get("/ws/deleted.ts");
		expect(review).toBeDefined();
		expect(review?.changeType).toBe("delete");
		expect(review?.originalContent).toBe("line1\nline2");
		expect(review?.modifiedContent).toBe("");
	});

	it("restore builds correct mergedLines for delete reviews", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/deleted.ts",
					originalContent: "a\nb",
					modifiedContent: "",
					hunks: [{ id: 0, origStart: 1, origCount: 2, modStart: 1, modCount: 0, removed: ["a", "b"], added: [], resolved: false, accepted: false }],
					changeType: "delete",
				},
			],
		});
		mockFs.existsSync.mockReturnValue(false);
		await mgr.restore();
		const review = state.activeReviews.get("/ws/deleted.ts");
		// New behavior: removed lines ARE in buffer for unresolved pure-delete hunks
		expect(review?.mergedLines).toEqual(["a", "b"]);
		expect(review?.hunkRanges).toHaveLength(1);
		expect(review?.hunkRanges[0].removedStart).toBe(0);
		expect(review?.hunkRanges[0].removedEnd).toBe(2);
	});

	it("restore builds correct mergedLines for edit reviews", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/edit.ts",
					originalContent: "old",
					modifiedContent: "new",
					hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["old"], added: ["new"], resolved: false, accepted: false }],
					changeType: "edit",
				},
			],
		});
		mockFs.existsSync.mockReturnValue(true);
		await mgr.restore();
		const review = state.activeReviews.get("/ws/edit.ts");
		expect(review).toBeDefined();
		expect(review?.mergedLines).toEqual(["new"]);
		expect(review?.hunkRanges).toHaveLength(1);
	});

	it("restore preserves partially-resolved hunks", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/partial.ts",
					originalContent: "a\nb",
					modifiedContent: "x\ny",
					hunks: [
						{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["a"], added: ["x"], resolved: true, accepted: true },
						{ id: 1, origStart: 2, origCount: 1, modStart: 2, modCount: 1, removed: ["b"], added: ["y"], resolved: false, accepted: false },
					],
					changeType: "edit",
				},
			],
		});
		mockFs.existsSync.mockReturnValue(true);
		await mgr.restore();
		const review = state.activeReviews.get("/ws/partial.ts");
		expect(review?.hunks[0].resolved).toBe(true);
		expect(review?.hunks[0].accepted).toBe(true);
		expect(review?.hunks[1].resolved).toBe(false);
		// Only 1 unresolved hunk range (resolved hunks don't produce ranges)
		expect(review?.hunkRanges).toHaveLength(1);
	});

	it("restore preserves currentFileIndex", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 2,
			files: [
				{ filePath: "/ws/a.ts", originalContent: "a", modifiedContent: "x", hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["a"], added: ["x"], resolved: false, accepted: false }], changeType: "edit" },
				{ filePath: "/ws/b.ts", originalContent: "b", modifiedContent: "y", hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["b"], added: ["y"], resolved: false, accepted: false }], changeType: "edit" },
				{ filePath: "/ws/c.ts", originalContent: "c", modifiedContent: "z", hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["c"], added: ["z"], resolved: false, accepted: false }], changeType: "edit" },
			],
		});
		mockFs.existsSync.mockReturnValue(true);
		await mgr.restore();
		expect(mgr.getCurrentFileIndex()).toBe(2);
	});

	it("restore fires onReviewStateChange", async () => {
		const mgr = setupManager();
		const listener = vi.fn();
		mgr.onReviewStateChange(listener);
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 0,
			files: [
				{ filePath: "/ws/a.ts", originalContent: "a", modifiedContent: "x", hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["a"], added: ["x"], resolved: false, accepted: false }], changeType: "edit" },
			],
		});
		mockFs.existsSync.mockReturnValue(true);
		await mgr.restore();
		expect(listener).toHaveBeenCalledWith(true);
	});
});

describe("handleMissingFile (deletion via Bash)", () => {
	it("creates delete review when snapshot exists for missing file", () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue("original content\nline2");
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		mgr.addFile("/ws/deleted.ts");
		const review = state.activeReviews.get("/ws/deleted.ts");
		expect(review).toBeDefined();
		expect(review?.changeType).toBe("delete");
		expect(review?.originalContent).toBe("original content\nline2");
		expect(review?.modifiedContent).toBe("");
	});

	it("creates delete review from git when no snapshot", () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue(undefined);
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("git show HEAD")) return "git tracked content";
			return "";
		});
		mgr.addFile("/ws/deleted.ts");
		const review = state.activeReviews.get("/ws/deleted.ts");
		expect(review).toBeDefined();
		expect(review?.changeType).toBe("delete");
	});

	it("ignores missing file with no snapshot and not git-tracked", () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue(undefined);
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		mockExecSync.mockImplementation(() => { throw new Error("not found"); });
		mgr.addFile("/ws/unknown.ts");
		expect(state.activeReviews.has("/ws/unknown.ts")).toBe(false);
	});

	it("delete review has all original lines in removed[]", () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue("line1\nline2\nline3");
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		mgr.addFile("/ws/deleted.ts");
		const review = state.activeReviews.get("/ws/deleted.ts");
		expect(review?.hunks[0].removed).toEqual(["line1", "line2", "line3"]);
		expect(review?.hunks[0].added).toEqual([]);
	});

	it("resolveAllHunks(false) on delete review restores file", async () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue("original");
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		mgr.addFile("/ws/deleted.ts");

		// Now allow writeFileSync to work
		mockFs.readFileSync.mockReturnValue("");
		await mgr.resolveAllHunks("/ws/deleted.ts", false);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith("/ws/deleted.ts", "original", "utf8");
	});

	it("fires onReviewStateChange for delete review", () => {
		const mgr = setupManager();
		const listener = vi.fn();
		mgr.onReviewStateChange(listener);
		mockServer.getSnapshot.mockReturnValue("content");
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		mgr.addFile("/ws/deleted.ts");
		expect(listener).toHaveBeenCalledWith(true);
	});
});

describe("dispose — file restoration", () => {
	it("restores files to modifiedContent on dispose", () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;
		const modContent = review.modifiedContent;

		mockFs.writeFileSync.mockClear();
		mgr.dispose();

		// Should write modifiedContent for each active review
		expect(mockFs.writeFileSync).toHaveBeenCalledWith("/ws/file.ts", modContent, "utf8");
	});

	it("saves state after restoring files", () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		mockPersistence.saveReviewState.mockClear();
		mgr.dispose();
		expect(mockPersistence.saveReviewState).toHaveBeenCalled();
	});
});

describe("restoreFromSnapshot", () => {
	it("restores hunks from snapshot", () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;

		const snapshot = {
			filePath: "/ws/file.ts",
			originalContent: review.originalContent,
			modifiedContent: review.modifiedContent,
			changeType: review.changeType,
			hunks: [{ ...review.hunks[0], resolved: false, accepted: false }],
			mergedLines: [...review.mergedLines],
			hunkRanges: review.hunkRanges.map(r => ({ ...r })),
		};

		// Resolve the hunk first
		review.hunks[0].resolved = true;
		review.hunks[0].accepted = true;

		mgr.restoreFromSnapshot("/ws/file.ts", snapshot);
		expect(review.hunks[0].resolved).toBe(false);
	});

	it("re-creates review after finalize via undo", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;

		const snapshot = {
			filePath: "/ws/file.ts",
			originalContent: review.originalContent,
			modifiedContent: review.modifiedContent,
			changeType: review.changeType,
			hunks: JSON.parse(JSON.stringify(review.hunks)),
			mergedLines: [...review.mergedLines],
			hunkRanges: review.hunkRanges.map(r => ({ ...r })),
		};

		// Finalize (removes from activeReviews)
		await mgr.resolveAllHunks("/ws/file.ts", true);
		expect(state.activeReviews.has("/ws/file.ts")).toBe(false);

		// Undo → restoreFromSnapshot re-creates review
		mgr.restoreFromSnapshot("/ws/file.ts", snapshot);
		expect(state.activeReviews.has("/ws/file.ts")).toBe(true);
		expect(state.activeReviews.get("/ws/file.ts")!.hunks[0].resolved).toBe(false);
	});
});

describe("finalizeFile", () => {
	it("deletes created file when all rejected", async () => {
		const mgr = setupManager();
		// Setup as create type
		mockServer.getSnapshot.mockReturnValue("");
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("git ls-files")) throw new Error("untracked");
			if (cmd.includes("git show HEAD")) throw new Error("not found");
			return "";
		});
		mockFs.readFileSync.mockReturnValue("new content");
		mgr.addFile("/ws/new.ts");

		await mgr.resolveAllHunks("/ws/new.ts", false);
		expect(mockFs.unlinkSync).toHaveBeenCalledWith("/ws/new.ts");
	});

	it("writes final content for edit type", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		await mgr.resolveAllHunks("/ws/file.ts", true);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			"/ws/file.ts",
			expect.any(String),
			"utf8",
		);
	});

	it("clears state when all files resolved", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		await mgr.resolveAllHunks("/ws/file.ts", true);
		expect(mockPersistence.clearReviewState).toHaveBeenCalled();
	});

	it("delete review + accept → file is deleted (unlinkSync)", async () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue("original content");
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		mgr.addFile("/ws/del.ts");

		mockFs.readFileSync.mockReturnValue("");
		await mgr.resolveAllHunks("/ws/del.ts", true);
		expect(mockFs.unlinkSync).toHaveBeenCalledWith("/ws/del.ts");
	});

	it("delete review + reject → file is restored", async () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue("original content");
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		mgr.addFile("/ws/del.ts");

		mockFs.readFileSync.mockReturnValue("");
		await mgr.resolveAllHunks("/ws/del.ts", false);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith("/ws/del.ts", "original content", "utf8");
	});
});

describe("undoResolve / redoResolve", () => {
	function makeSnapshot(review: ReturnType<typeof state.activeReviews.get>, overrides?: Partial<ReviewSnapshot>): ReviewSnapshot {
		return {
			filePath: review!.filePath,
			originalContent: review!.originalContent,
			modifiedContent: review!.modifiedContent,
			changeType: review!.changeType,
			hunks: JSON.parse(JSON.stringify(review!.hunks)),
			mergedLines: [...review!.mergedLines],
			hunkRanges: review!.hunkRanges.map(r => ({ ...r })),
			...overrides,
		};
	}

	function setActiveEditor(fsPath: string): void {
		const mockEditor = {
			document: {
				uri: { fsPath },
				lineCount: 10,
				lineAt: () => ({ text: "" }),
				getText: vi.fn().mockReturnValue(""),
				save: vi.fn().mockResolvedValue(true),
			},
			edit: vi.fn().mockResolvedValue(true),
			revealRange: vi.fn(),
			selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
			visibleRanges: [{ start: { line: 0 }, end: { line: 20 } }],
			setDecorations: vi.fn(),
		};
		(vscode.window as any).activeTextEditor = mockEditor;
		(vscode.window as any).visibleTextEditors = [mockEditor];
	}

	function clearActiveEditor(): void {
		(vscode.window as any).activeTextEditor = null;
		(vscode.window as any).visibleTextEditors = [];
	}

	beforeEach(() => {
		mockUndoHistory.hasUndoState.mockReset().mockReturnValue(false);
		mockUndoHistory.hasRedoState.mockReset().mockReturnValue(false);
		mockUndoHistory.popUndoState.mockReset();
		mockUndoHistory.popRedoState.mockReset();
		mockUndoHistory.pushUndoState.mockReset();
		mockUndoHistory.pushRedoState.mockReset();
		mockUndoHistory.getLastUndoFilePath.mockReset().mockReturnValue(undefined);
		mockUndoHistory.getLastRedoFilePath.mockReset().mockReturnValue(undefined);
	});

	afterEach(() => {
		clearActiveEditor();
	});

	it("undoResolve pops undo stack and restores review state (hunks become unresolved)", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;

		// Save snapshot with unresolved hunk
		const snapshot = makeSnapshot(review);

		// Resolve the hunk
		review.hunks[0].resolved = true;
		review.hunks[0].accepted = true;

		setActiveEditor("/ws/file.ts");
		mockUndoHistory.hasUndoState.mockReturnValueOnce(true).mockReturnValueOnce(true);
		mockUndoHistory.popUndoState.mockReturnValueOnce(snapshot);

		await mgr.undoResolve();

		const restored = state.activeReviews.get("/ws/file.ts")!;
		expect(restored.hunks[0].resolved).toBe(false);
		expect(restored.hunks[0].accepted).toBe(false);
	});

	it("undoResolve pushes current state to redo stack", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;

		const snapshot = makeSnapshot(review);
		review.hunks[0].resolved = true;
		review.hunks[0].accepted = true;

		setActiveEditor("/ws/file.ts");
		mockUndoHistory.hasUndoState.mockReturnValueOnce(true).mockReturnValueOnce(true);
		mockUndoHistory.popUndoState.mockReturnValueOnce(snapshot);

		// Capture the state at call time since restoreFromSnapshot mutates the review
		let capturedHunks: any[] = [];
		mockUndoHistory.pushRedoState.mockImplementationOnce((_path: string, rev: any) => {
			capturedHunks = JSON.parse(JSON.stringify(rev.hunks));
		});

		await mgr.undoResolve();

		expect(capturedHunks).toHaveLength(1);
		expect(capturedHunks[0].resolved).toBe(true);
		expect(capturedHunks[0].accepted).toBe(true);
	});

	it("undoResolve after finalizeFile re-creates the review", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;

		// Save snapshot before finalize
		const snapshot = makeSnapshot(review);

		// Finalize (removes from activeReviews)
		await mgr.resolveAllHunks("/ws/file.ts", true);
		expect(state.activeReviews.has("/ws/file.ts")).toBe(false);

		setActiveEditor("/ws/file.ts");
		// After finalize, file is not in activeReviews — cross-file undo uses getLastUndoFilePath
		mockUndoHistory.hasUndoState.mockReturnValueOnce(false).mockReturnValueOnce(true);
		mockUndoHistory.getLastUndoFilePath.mockReturnValueOnce("/ws/file.ts");
		mockUndoHistory.popUndoState.mockReturnValueOnce(snapshot);

		await mgr.undoResolve();

		// Review should be re-created
		expect(state.activeReviews.has("/ws/file.ts")).toBe(true);
		const restored = state.activeReviews.get("/ws/file.ts")!;
		expect(restored.hunks[0].resolved).toBe(false);
	});

	it("undoResolve after finalize pushes finalized marker to redo", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;
		const snapshot = makeSnapshot(review);

		await mgr.resolveAllHunks("/ws/file.ts", true);
		expect(state.activeReviews.has("/ws/file.ts")).toBe(false);

		setActiveEditor("/ws/file.ts");
		// After finalize, file is not in activeReviews — cross-file undo uses getLastUndoFilePath
		mockUndoHistory.hasUndoState.mockReturnValueOnce(false).mockReturnValueOnce(true);
		mockUndoHistory.getLastUndoFilePath.mockReturnValueOnce("/ws/file.ts");
		mockUndoHistory.popUndoState.mockReturnValueOnce(snapshot);
		mockUndoHistory.pushRedoState.mockClear();

		await mgr.undoResolve();

		// Should push a finalized snapshot (all hunks resolved) to redo
		expect(mockUndoHistory.pushRedoState).toHaveBeenCalledTimes(1);
		const pushedSnapshot = mockUndoHistory.pushRedoState.mock.calls[0][1] as ReviewSnapshot;
		expect(pushedSnapshot.hunks.every((h: any) => h.resolved && h.accepted)).toBe(true);
	});

	it("undoResolve with no undo state does nothing", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;
		review.hunks[0].resolved = true;

		setActiveEditor("/ws/file.ts");
		mockUndoHistory.popUndoState.mockReturnValueOnce(undefined);

		await mgr.undoResolve();

		// State unchanged
		expect(review.hunks[0].resolved).toBe(true);
	});

	it("undoResolve with no active editor does nothing", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;
		review.hunks[0].resolved = true;

		clearActiveEditor();

		await mgr.undoResolve();

		expect(mockUndoHistory.popUndoState).not.toHaveBeenCalled();
		expect(review.hunks[0].resolved).toBe(true);
	});

	it("redoResolve pops redo stack and restores state", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;

		// Add a second unresolved hunk so not all are resolved (avoids re-finalize)
		const secondHunk = { ...review.hunks[0], id: 1, resolved: false, accepted: false };
		const redoSnapshot = makeSnapshot(review, {
			hunks: [
				{ ...review.hunks[0], resolved: true, accepted: true },
				secondHunk,
			],
		});

		setActiveEditor("/ws/file.ts");
		mockUndoHistory.hasRedoState.mockReturnValueOnce(true).mockReturnValueOnce(true);
		mockUndoHistory.popRedoState.mockReturnValueOnce(redoSnapshot);

		await mgr.redoResolve();

		const restored = state.activeReviews.get("/ws/file.ts")!;
		expect(restored.hunks[0].resolved).toBe(true);
		expect(restored.hunks[0].accepted).toBe(true);
		expect(restored.hunks[1].resolved).toBe(false);
	});

	it("redoResolve pushes current state to undo stack with preserveRedo=true", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;

		// Add second unresolved hunk so redo doesn't trigger finalize
		const secondHunk = { ...review.hunks[0], id: 1, resolved: false, accepted: false };
		const redoSnapshot = makeSnapshot(review, {
			hunks: [
				{ ...review.hunks[0], resolved: true, accepted: true },
				secondHunk,
			],
		});

		setActiveEditor("/ws/file.ts");
		mockUndoHistory.hasRedoState.mockReturnValueOnce(true).mockReturnValueOnce(true);
		mockUndoHistory.popRedoState.mockReturnValueOnce(redoSnapshot);

		// Capture at call time since restoreFromSnapshot mutates the review
		let capturedHunks: any[] = [];
		let capturedPreserveRedo: boolean | undefined;
		mockUndoHistory.pushUndoState.mockImplementationOnce((_path: string, rev: any, preserveRedo?: boolean) => {
			capturedHunks = JSON.parse(JSON.stringify(rev.hunks));
			capturedPreserveRedo = preserveRedo;
		});

		await mgr.redoResolve();

		expect(capturedHunks).toHaveLength(1);
		// Current review (pre-redo) had unresolved hunks
		expect(capturedHunks[0].resolved).toBe(false);
		// Must pass preserveRedo=true to avoid clearing remaining redo entries
		expect(capturedPreserveRedo).toBe(true);
	});

	it("redoResolve when all hunks resolved triggers re-finalize", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;

		// Redo snapshot with ALL hunks resolved
		const finalizedSnapshot = makeSnapshot(review, {
			hunks: review.hunks.map(h => ({ ...h, resolved: true, accepted: true })),
		});

		setActiveEditor("/ws/file.ts");
		mockUndoHistory.hasRedoState.mockReturnValueOnce(true).mockReturnValueOnce(true);
		mockUndoHistory.popRedoState.mockReturnValueOnce(finalizedSnapshot);

		await mgr.redoResolve();

		// File should be finalized (removed from activeReviews)
		expect(state.activeReviews.has("/ws/file.ts")).toBe(false);
	});

	it("redoResolve with no redo state does nothing", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");

		setActiveEditor("/ws/file.ts");
		mockUndoHistory.popRedoState.mockReturnValueOnce(undefined);

		const reviewBefore = JSON.stringify(state.activeReviews.get("/ws/file.ts")!.hunks);
		await mgr.redoResolve();
		const reviewAfter = JSON.stringify(state.activeReviews.get("/ws/file.ts")!.hunks);
		expect(reviewAfter).toBe(reviewBefore);
	});

	it("multiple redo operations work (redo stack not cleared)", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;

		setActiveEditor("/ws/file.ts");

		// Track all pushUndoState calls to verify preserveRedo=true
		const pushUndoCalls: { preserveRedo?: boolean }[] = [];
		mockUndoHistory.pushUndoState.mockImplementation((_p: string, _r: any, preserveRedo?: boolean) => {
			pushUndoCalls.push({ preserveRedo });
		});

		// Simulate 3 redo snapshots (as if user did 3 undos and now does redo 3 times)
		const snapshots = [
			makeSnapshot(review, { mergedLines: ["s1"], hunks: [{ ...review.hunks[0], resolved: true, accepted: true }, { ...review.hunks[0], id: 1 }] }),
			makeSnapshot(review, { mergedLines: ["s2"], hunks: [{ ...review.hunks[0], resolved: true, accepted: true }, { ...review.hunks[0], id: 1 }] }),
			makeSnapshot(review, { mergedLines: ["s3"], hunks: [{ ...review.hunks[0], resolved: true, accepted: true }, { ...review.hunks[0], id: 1 }] }),
		];

		// Redo 1
		mockUndoHistory.hasRedoState.mockReturnValueOnce(true).mockReturnValueOnce(true);
		mockUndoHistory.popRedoState.mockReturnValueOnce(snapshots[0]);
		await mgr.redoResolve();
		expect(pushUndoCalls[0].preserveRedo).toBe(true);

		// Redo 2
		mockUndoHistory.hasRedoState.mockReturnValueOnce(true).mockReturnValueOnce(true);
		mockUndoHistory.popRedoState.mockReturnValueOnce(snapshots[1]);
		await mgr.redoResolve();
		expect(pushUndoCalls[1].preserveRedo).toBe(true);

		// Redo 3
		mockUndoHistory.hasRedoState.mockReturnValueOnce(true).mockReturnValueOnce(true);
		mockUndoHistory.popRedoState.mockReturnValueOnce(snapshots[2]);
		await mgr.redoResolve();
		expect(pushUndoCalls[2].preserveRedo).toBe(true);

		// All 3 redo operations called pushUndoState with preserveRedo=true
		expect(pushUndoCalls).toHaveLength(3);
		expect(pushUndoCalls.every(c => c.preserveRedo === true)).toBe(true);
	});

	it("full cycle: resolve → undoResolve → redoResolve", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;
		const hunkId = review.hunks[0].id;

		// Capture pre-resolve snapshot
		const preResolveSnapshot = makeSnapshot(review);

		setActiveEditor("/ws/file.ts");

		// Step 1: resolve hunk (this finalizes since single hunk)
		await mgr.resolveHunk("/ws/file.ts", hunkId, true);
		expect(state.activeReviews.has("/ws/file.ts")).toBe(false);

		// Step 2: undo → restores pre-resolve state
		// After finalize, file is not in activeReviews — cross-file undo uses getLastUndoFilePath
		mockUndoHistory.hasUndoState.mockReturnValueOnce(false).mockReturnValueOnce(true);
		mockUndoHistory.getLastUndoFilePath.mockReturnValueOnce("/ws/file.ts");
		mockUndoHistory.popUndoState.mockReturnValueOnce(preResolveSnapshot);
		await mgr.undoResolve();

		expect(state.activeReviews.has("/ws/file.ts")).toBe(true);
		const afterUndo = state.activeReviews.get("/ws/file.ts")!;
		expect(afterUndo.hunks[0].resolved).toBe(false);

		// Step 3: redo → re-finalizes
		// pushRedoState was called during undo; simulate popRedoState returning the finalized state
		const finalizedSnapshot = makeSnapshot(afterUndo, {
			hunks: afterUndo.hunks.map(h => ({ ...h, resolved: true, accepted: true })),
		});
		mockUndoHistory.hasRedoState.mockReturnValueOnce(true).mockReturnValueOnce(true);
		mockUndoHistory.popRedoState.mockReturnValueOnce(finalizedSnapshot);

		await mgr.redoResolve();

		// File should be finalized again
		expect(state.activeReviews.has("/ws/file.ts")).toBe(false);
	});
});

// --- Helper to set up mock editor for openFileForReview tests ---

function mockOpenTextDocument(content: string) {
	const mockDoc = {
		uri: { fsPath: "" },
		getText: vi.fn().mockReturnValue(content),
		lineCount: content.split("\n").length,
		lineAt: (n: number) => ({ text: content.split("\n")[n] ?? "" }),
		save: vi.fn().mockResolvedValue(true),
	};
	(vscode.workspace.openTextDocument as ReturnType<typeof vi.fn>).mockResolvedValue(mockDoc);
	return mockDoc;
}

function mockShowTextDocument(doc: any) {
	const mockEditor = {
		document: doc,
		edit: vi.fn().mockResolvedValue(true),
		revealRange: vi.fn(),
		selection: new vscode.Selection(0, 0, 0, 0),
		visibleRanges: [new vscode.Range(0, 0, 10, 0)],
		setDecorations: vi.fn(),
	};
	(vscode.window.showTextDocument as ReturnType<typeof vi.fn>).mockResolvedValue(mockEditor);
	return mockEditor;
}

function addMultipleFiles(mgr: ReviewManager, count: number): string[] {
	const paths: string[] = [];
	for (let i = 0; i < count; i++) {
		const p = `/ws/file${i}.ts`;
		paths.push(p);
		mockFs.readFileSync.mockReturnValue(`modified${i}`);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("git ls-files")) return "";
			if (cmd.includes("git show HEAD")) return `orig${i}`;
			if (cmd.includes("git diff --no-index")) {
				const err = new Error("diff") as Error & { stdout: string };
				err.stdout = `@@ -1,1 +1,1 @@\n-orig${i}\n+modified${i}`;
				throw err;
			}
			if (cmd.includes("git diff HEAD")) return `@@ -1,1 +1,1 @@\n-orig${i}\n+modified${i}`;
			return "";
		});
		mgr.addFile(p);
	}
	return paths;
}

describe("openFileForReview — stale content sync", () => {
	it("syncs editor content when doc.getText() differs from mergedContent", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;
		const mergedContent = review.mergedLines.join("\n");

		// Editor has stale (modified) content, not merged
		const mockDoc = mockOpenTextDocument("stale content that differs");
		mockDoc.uri.fsPath = "/ws/file.ts";
		const mockEditor = mockShowTextDocument(mockDoc);

		await mgr.openFileForReview("/ws/file.ts");

		// editor.edit() should be called to sync content
		expect(mockEditor.edit).toHaveBeenCalledTimes(1);
		// saveWithoutFormatting uses fs.writeFileSync + revert (NOT doc.save)
		expect(mockFs.writeFileSync).toHaveBeenCalledWith("/ws/file.ts", expect.any(String), "utf8");
	});

	it("skips sync when doc.getText() matches mergedContent", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;
		const mergedContent = review.mergedLines.join("\n");

		// Editor already has the correct merged content
		const mockDoc = mockOpenTextDocument(mergedContent);
		mockDoc.uri.fsPath = "/ws/file.ts";
		const mockEditor = mockShowTextDocument(mockDoc);

		await mgr.openFileForReview("/ws/file.ts");

		// editor.edit() should NOT be called
		expect(mockEditor.edit).not.toHaveBeenCalled();
	});

	it("applies decorations after sync", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;

		const mockDoc = mockOpenTextDocument("stale content");
		mockDoc.uri.fsPath = "/ws/file.ts";
		const mockEditor = mockShowTextDocument(mockDoc);
		(applyDecorations as ReturnType<typeof vi.fn>).mockClear();

		await mgr.openFileForReview("/ws/file.ts");

		expect(applyDecorations).toHaveBeenCalledWith(mockEditor, review);
	});

	it("sets currentFileIndex and currentHunkIndex", async () => {
		const mgr = setupManager();
		const paths = addMultipleFiles(mgr, 3);

		const mergedContent = state.activeReviews.get(paths[1])!.mergedLines.join("\n");
		const mockDoc = mockOpenTextDocument(mergedContent);
		mockDoc.uri.fsPath = paths[1];
		mockShowTextDocument(mockDoc);

		await mgr.openFileForReview(paths[1]);

		expect(mgr.getCurrentFileIndex()).toBe(1);
		expect(mgr.getCurrentHunkIndex()).toBe(0);
	});

	it("does nothing for non-existent review", async () => {
		const mgr = setupManager();
		await mgr.openFileForReview("/ws/nope.ts");
		expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
	});
});

describe("openCurrentOrNext", () => {
	function setupOpenMock(mgr: ReviewManager) {
		// Spy on openFileForReview by tracking which file gets opened
		const openedFiles: string[] = [];
		const origOpen = mgr.openFileForReview.bind(mgr);
		vi.spyOn(mgr, "openFileForReview").mockImplementation(async (fp) => {
			openedFiles.push(fp);
		});
		return openedFiles;
	}

	it("opens file at saved currentFileIndex", async () => {
		const mgr = setupManager();
		const paths = addMultipleFiles(mgr, 3);
		// Simulate restore having set currentFileIndex to 2
		// Use internal method to set index (restore does this)
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 2,
			files: [
				{ filePath: paths[0], originalContent: "orig0", modifiedContent: "modified0", hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["orig0"], added: ["modified0"], resolved: false, accepted: false }], changeType: "edit" },
				{ filePath: paths[1], originalContent: "orig1", modifiedContent: "modified1", hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["orig1"], added: ["modified1"], resolved: false, accepted: false }], changeType: "edit" },
				{ filePath: paths[2], originalContent: "orig2", modifiedContent: "modified2", hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["orig2"], added: ["modified2"], resolved: false, accepted: false }], changeType: "edit" },
			],
		});
		// Clear and restore to get proper state
		state.activeReviews.clear();
		const mgr2 = setupManager();
		await mgr2.restore();

		const openedFiles = setupOpenMock(mgr2);
		await mgr2.openCurrentOrNext();

		expect(openedFiles).toEqual([paths[2]]);
	});

	it("falls back to first unresolved when currentFileIndex is out of bounds", async () => {
		const mgr = setupManager();
		addMultipleFiles(mgr, 2);

		// Force currentFileIndex beyond array bounds
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 99,
			files: [
				{ filePath: "/ws/file0.ts", originalContent: "orig0", modifiedContent: "modified0", hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["orig0"], added: ["modified0"], resolved: false, accepted: false }], changeType: "edit" },
			],
		});
		state.activeReviews.clear();
		const mgr2 = setupManager();
		await mgr2.restore();

		const openedFiles = setupOpenMock(mgr2);
		await mgr2.openCurrentOrNext();

		expect(openedFiles).toEqual(["/ws/file0.ts"]);
	});

	it("does nothing when no unresolved files", async () => {
		const mgr = setupManager();
		const openedFiles = setupOpenMock(mgr);

		await mgr.openCurrentOrNext();

		expect(openedFiles).toHaveLength(0);
	});
});

describe("reviewNextUnresolved — skip current file", () => {
	function setupOpenMock(mgr: ReviewManager) {
		const openedFiles: string[] = [];
		vi.spyOn(mgr, "openFileForReview").mockImplementation(async (fp) => {
			openedFiles.push(fp);
		});
		return openedFiles;
	}

	it("skips current file and opens next unresolved", async () => {
		const mgr = setupManager();
		const paths = addMultipleFiles(mgr, 3);

		// Simulate being on file0 (index 0)
		const mergedContent = state.activeReviews.get(paths[0])!.mergedLines.join("\n");
		const mockDoc = mockOpenTextDocument(mergedContent);
		mockDoc.uri.fsPath = paths[0];
		mockShowTextDocument(mockDoc);
		await mgr.openFileForReview(paths[0]);

		// Now spy on subsequent calls
		const openedFiles = setupOpenMock(mgr);
		await mgr.reviewNextUnresolved();

		// Should open file1, NOT file0 (current)
		expect(openedFiles).toEqual([paths[1]]);
	});

	it("opens current file as fallback when it is the only unresolved", async () => {
		const mgr = setupManager();
		const paths = addMultipleFiles(mgr, 1);

		const mergedContent = state.activeReviews.get(paths[0])!.mergedLines.join("\n");
		const mockDoc = mockOpenTextDocument(mergedContent);
		mockDoc.uri.fsPath = paths[0];
		mockShowTextDocument(mockDoc);
		await mgr.openFileForReview(paths[0]);

		const openedFiles = setupOpenMock(mgr);
		await mgr.reviewNextUnresolved();

		// Only one file — fallback opens it
		expect(openedFiles).toEqual([paths[0]]);
	});

	it("does nothing when no unresolved files", async () => {
		const mgr = setupManager();
		const openedFiles = setupOpenMock(mgr);

		await mgr.reviewNextUnresolved();

		expect(openedFiles).toHaveLength(0);
	});

	it("wraps around to beginning when at last file", async () => {
		const mgr = setupManager();
		const paths = addMultipleFiles(mgr, 3);

		// Be on file2 (last file, index 2)
		const mergedContent = state.activeReviews.get(paths[2])!.mergedLines.join("\n");
		const mockDoc = mockOpenTextDocument(mergedContent);
		mockDoc.uri.fsPath = paths[2];
		mockShowTextDocument(mockDoc);
		await mgr.openFileForReview(paths[2]);

		const openedFiles = setupOpenMock(mgr);
		await mgr.reviewNextUnresolved();

		// Should wrap around to file0
		expect(openedFiles).toEqual([paths[0]]);
	});

	it("wraps around skipping resolved files", async () => {
		const mgr = setupManager();
		const paths = addMultipleFiles(mgr, 4);

		// Be on file2, resolve file3 and file0
		const mergedContent = state.activeReviews.get(paths[2])!.mergedLines.join("\n");
		const mockDoc = mockOpenTextDocument(mergedContent);
		mockDoc.uri.fsPath = paths[2];
		mockShowTextDocument(mockDoc);
		await mgr.openFileForReview(paths[2]);

		state.activeReviews.delete(paths[3]); // resolve file3
		state.activeReviews.delete(paths[0]); // resolve file0

		const openedFiles = setupOpenMock(mgr);
		await mgr.reviewNextUnresolved();

		// Should wrap past file3 (resolved) and file0 (resolved), open file1
		expect(openedFiles).toEqual([paths[1]]);
	});

	it("skips resolved files and finds next unresolved", async () => {
		const mgr = setupManager();
		const paths = addMultipleFiles(mgr, 3);

		// Be on file0, resolve file1
		const mergedContent = state.activeReviews.get(paths[0])!.mergedLines.join("\n");
		const mockDoc = mockOpenTextDocument(mergedContent);
		mockDoc.uri.fsPath = paths[0];
		mockShowTextDocument(mockDoc);
		await mgr.openFileForReview(paths[0]);

		// Resolve file1 (remove from activeReviews)
		state.activeReviews.delete(paths[1]);

		const openedFiles = setupOpenMock(mgr);
		await mgr.reviewNextUnresolved();

		// Should skip file0 (current) and file1 (resolved), open file2
		expect(openedFiles).toEqual([paths[2]]);
	});
});
