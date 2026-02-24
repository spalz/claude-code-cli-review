import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn() }));
vi.mock("../decorations", () => ({
	applyDecorations: vi.fn(),
	clearDecorations: vi.fn(),
}));
vi.mock("../undo-history", () => ({
	initHistory: vi.fn(),
	pushUndoState: vi.fn(),
	popUndoState: vi.fn(),
	pushRedoState: vi.fn(),
	popRedoState: vi.fn(),
	hasUndoState: vi.fn().mockReturnValue(false),
	hasRedoState: vi.fn().mockReturnValue(false),
	setApplyingEdit: vi.fn(),
	isApplyingEdit: vi.fn().mockReturnValue(false),
	clearHistory: vi.fn(),
	clearAllHistories: vi.fn(),
}));

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

import * as state from "../state";
import { ReviewManager } from "../review-manager";

function setupManager(): ReviewManager {
	const mgr = new ReviewManager("/ws");
	mgr.setProviders({ refresh: vi.fn() }, { update: vi.fn() });
	return mgr;
}

function setupTrackedFile(original: string, modified: string) {
	mockFs.readFileSync.mockReturnValue(modified);
	mockExecSync.mockImplementation((cmd: string) => {
		if (cmd.includes("git ls-files")) return "";
		if (cmd.includes("git show HEAD")) return original;
		if (cmd.includes("git diff --no-index")) {
			const err = new Error("diff") as Error & { stdout: string };
			err.stdout = `@@ -1,1 +1,1 @@\n-${original}\n+${modified}`;
			throw err;
		}
		if (cmd.includes("git diff HEAD"))
			return `@@ -1,1 +1,1 @@\n-${original}\n+${modified}`;
		return "";
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	state.activeReviews.clear();
	state.setReviewFiles([]);
	// Reset mockReturnValue (clearAllMocks doesn't reset return values)
	mockServer.getSnapshot.mockReturnValue(undefined);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("full review cycle", () => {
	it("addFile → accept all → file gets modified content", async () => {
		setupTrackedFile("old line", "new line");
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		await mgr.resolveAllHunks("/ws/file.ts", true);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			"/ws/file.ts",
			expect.stringContaining("new line"),
			"utf8",
		);
	});

	it("addFile → reject all → file gets original content", async () => {
		setupTrackedFile("old line", "new line");
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		await mgr.resolveAllHunks("/ws/file.ts", false);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			"/ws/file.ts",
			expect.stringContaining("old line"),
			"utf8",
		);
	});
});

describe("create + reject = delete", () => {
	it("new file rejected → file deleted", async () => {
		mockServer.getSnapshot.mockReturnValue("");
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("git ls-files")) throw new Error("untracked");
			if (cmd.includes("git show HEAD")) throw new Error("not found");
			return "";
		});
		mockFs.readFileSync.mockReturnValue("new content");

		const mgr = setupManager();
		mgr.addFile("/ws/new.ts");
		await mgr.resolveAllHunks("/ws/new.ts", false);
		expect(mockFs.unlinkSync).toHaveBeenCalledWith("/ws/new.ts");
	});
});

describe("re-edit same file", () => {
	it("re-adding file preserves review with new content", () => {
		setupTrackedFile("original", "first-edit");
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		expect(state.activeReviews.has("/ws/file.ts")).toBe(true);

		// Re-edit same file with new content
		mockFs.readFileSync.mockReturnValue("second-edit");
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("git ls-files")) return "";
			if (cmd.includes("git show HEAD")) return "original";
			if (cmd.includes("git diff --no-index")) {
				const err = new Error("diff") as Error & { stdout: string };
				err.stdout = "@@ -1,1 +1,1 @@\n-original\n+second-edit";
				throw err;
			}
			if (cmd.includes("git diff HEAD"))
				return "@@ -1,1 +1,1 @@\n-original\n+second-edit";
			return "";
		});
		mgr.addFile("/ws/file.ts");

		const review = state.activeReviews.get("/ws/file.ts")!;
		expect(review.modifiedContent).toBe("second-edit");
	});
});

describe("persistence round-trip", () => {
	it("save → clear → restore recovers edit reviews", async () => {
		setupTrackedFile("orig", "mod");
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		mgr.saveNow();

		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: Date.now(),
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/file.ts",
					originalContent: "orig",
					modifiedContent: "mod",
					hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["orig"], added: ["mod"], resolved: false, accepted: false }],
					changeType: "edit" as const,
				},
			],
		});

		state.activeReviews.clear();
		const result = await mgr.restore();
		expect(result).toBe(true);
		const review = state.activeReviews.get("/ws/file.ts");
		expect(review).toBeDefined();
		expect(review?.changeType).toBe("edit");
		expect(review?.originalContent).toBe("orig");
		expect(review?.modifiedContent).toBe("mod");
		expect(review?.hunks).toHaveLength(1);
		expect(review?.hunks[0].resolved).toBe(false);
	});

	it("save → restore recovers delete reviews with correct mergedLines", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: Date.now(),
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/deleted.ts",
					originalContent: "line1\nline2\nline3",
					modifiedContent: "",
					hunks: [{ id: 0, origStart: 1, origCount: 3, modStart: 1, modCount: 0, removed: ["line1", "line2", "line3"], added: [], resolved: false, accepted: false }],
					changeType: "delete" as const,
				},
			],
		});
		mockFs.existsSync.mockReturnValue(false);

		state.activeReviews.clear();
		const result = await mgr.restore();
		expect(result).toBe(true);
		const review = state.activeReviews.get("/ws/deleted.ts");
		expect(review?.changeType).toBe("delete");
		// New behavior: removed lines ARE in buffer for unresolved pure-delete hunks
		expect(review?.mergedLines).toEqual(["line1", "line2", "line3"]);
		expect(review?.hunkRanges).toHaveLength(1);
		// removedEnd > removedStart since removed lines are now in buffer
		expect(review?.hunkRanges[0].removedStart).toBe(0);
		expect(review?.hunkRanges[0].removedEnd).toBe(3);
		expect(review?.hunkRanges[0].addedStart).toBe(3);
		expect(review?.hunkRanges[0].addedEnd).toBe(3);
	});

	it("save → restore → accept edit → correct file content", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: Date.now(),
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/edit.ts",
					originalContent: "old",
					modifiedContent: "new",
					hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["old"], added: ["new"], resolved: false, accepted: false }],
					changeType: "edit" as const,
				},
			],
		});
		mockFs.existsSync.mockReturnValue(true);
		state.activeReviews.clear();
		await mgr.restore();

		await mgr.resolveAllHunks("/ws/edit.ts", true);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith("/ws/edit.ts", "new", "utf8");
	});

	it("save → restore → reject edit → original content restored", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: Date.now(),
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/edit.ts",
					originalContent: "old",
					modifiedContent: "new",
					hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["old"], added: ["new"], resolved: false, accepted: false }],
					changeType: "edit" as const,
				},
			],
		});
		mockFs.existsSync.mockReturnValue(true);
		state.activeReviews.clear();
		await mgr.restore();

		await mgr.resolveAllHunks("/ws/edit.ts", false);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith("/ws/edit.ts", "old", "utf8");
	});

	it("save → restore → reject delete → file restored", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: Date.now(),
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/deleted.ts",
					originalContent: "content to restore",
					modifiedContent: "",
					hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 0, removed: ["content to restore"], added: [], resolved: false, accepted: false }],
					changeType: "delete" as const,
				},
			],
		});
		mockFs.existsSync.mockReturnValue(false);
		state.activeReviews.clear();
		await mgr.restore();

		await mgr.resolveAllHunks("/ws/deleted.ts", false);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith("/ws/deleted.ts", "content to restore", "utf8");
	});

	it("save → restore → accept delete → file removed", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: Date.now(),
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/deleted.ts",
					originalContent: "will be gone",
					modifiedContent: "",
					hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 0, removed: ["will be gone"], added: [], resolved: false, accepted: false }],
					changeType: "delete" as const,
				},
			],
		});
		mockFs.existsSync.mockReturnValue(false);
		state.activeReviews.clear();
		await mgr.restore();

		await mgr.resolveAllHunks("/ws/deleted.ts", true);
		expect(mockFs.unlinkSync).toHaveBeenCalledWith("/ws/deleted.ts");
	});

	it("save → restore preserves multiple files with different types", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: Date.now(),
			currentFileIndex: 1,
			files: [
				{
					filePath: "/ws/edit.ts",
					originalContent: "old",
					modifiedContent: "new",
					hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["old"], added: ["new"], resolved: false, accepted: false }],
					changeType: "edit" as const,
				},
				{
					filePath: "/ws/created.ts",
					originalContent: "",
					modifiedContent: "new file",
					hunks: [{ id: 0, origStart: 1, origCount: 0, modStart: 1, modCount: 1, removed: [], added: ["new file"], resolved: false, accepted: false }],
					changeType: "create" as const,
				},
				{
					filePath: "/ws/deleted.ts",
					originalContent: "gone",
					modifiedContent: "",
					hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 0, removed: ["gone"], added: [], resolved: false, accepted: false }],
					changeType: "delete" as const,
				},
			],
		});
		mockFs.existsSync.mockImplementation((p: string) => {
			return !String(p).includes("deleted.ts"); // deleted file doesn't exist
		});
		state.activeReviews.clear();
		await mgr.restore();

		expect(state.activeReviews.size).toBe(3);
		expect(state.activeReviews.get("/ws/edit.ts")?.changeType).toBe("edit");
		expect(state.activeReviews.get("/ws/created.ts")?.changeType).toBe("create");
		expect(state.activeReviews.get("/ws/deleted.ts")?.changeType).toBe("delete");
		expect(mgr.getCurrentFileIndex()).toBe(1);
	});
});

describe("Bash file operations", () => {
	it("Bash rm → delete review → reject → file restored", async () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue("original content");
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });

		mgr.addFile("/ws/removed.ts");
		const review = state.activeReviews.get("/ws/removed.ts");
		expect(review?.changeType).toBe("delete");

		mockFs.readFileSync.mockReturnValue("");
		await mgr.resolveAllHunks("/ws/removed.ts", false);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith("/ws/removed.ts", "original content", "utf8");
	});

	it("Bash mv → deleted source can be tracked separately", () => {
		const mgr = setupManager();

		// Source file is "deleted" — snapshot exists, file doesn't
		mockServer.getSnapshot.mockReturnValue("source content");
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		mgr.addFile("/ws/source.ts");
		expect(state.activeReviews.get("/ws/source.ts")?.changeType).toBe("delete");

		// Dest file is "modified" — file exists with content
		mockServer.getSnapshot.mockReturnValue(undefined);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("git show HEAD")) throw new Error("not found");
			if (cmd.includes("git diff HEAD")) return "@@ -0,0 +1,1 @@\n+source content";
			return "";
		});
		mockFs.readFileSync.mockReturnValue("source content");
		mgr.addFile("/ws/dest.ts");
		expect(state.activeReviews.get("/ws/dest.ts")?.changeType).toBe("create");
	});

	it("Bash cp → modified dest tracked", () => {
		const mgr = setupManager();
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("git show HEAD")) throw new Error("not found");
			if (cmd.includes("git diff HEAD")) return "@@ -0,0 +1,1 @@\n+copied content";
			return "";
		});
		mockServer.getSnapshot.mockReturnValue("");
		mockFs.readFileSync.mockReturnValue("copied content");
		mgr.addFile("/ws/copy-dest.ts");
		expect(state.activeReviews.has("/ws/copy-dest.ts")).toBe(true);
		expect(state.activeReviews.get("/ws/copy-dest.ts")?.changeType).toBe("create");
	});
});

describe("undo/redo via restoreFromSnapshot", () => {
	it("resolve → restoreFromSnapshot → review state restored", async () => {
		setupTrackedFile("old line", "new line");
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");

		const review = state.activeReviews.get("/ws/file.ts")!;
		const preSnapshot = {
			filePath: review.filePath,
			originalContent: review.originalContent,
			modifiedContent: review.modifiedContent,
			changeType: review.changeType,
			hunks: JSON.parse(JSON.stringify(review.hunks)),
			mergedLines: [...review.mergedLines],
			hunkRanges: review.hunkRanges.map(r => ({ ...r })),
		};

		await mgr.resolveAllHunks("/ws/file.ts", true);
		expect(state.activeReviews.has("/ws/file.ts")).toBe(false);

		// Simulate undo — restore pre-resolve state
		mgr.restoreFromSnapshot("/ws/file.ts", preSnapshot);
		expect(state.activeReviews.has("/ws/file.ts")).toBe(true);
		const restored = state.activeReviews.get("/ws/file.ts")!;
		expect(restored.hunks[0].resolved).toBe(false);
		expect(restored.mergedLines).toEqual(preSnapshot.mergedLines);
	});

	it("full cycle: resolve → undo → re-resolve works correctly", async () => {
		setupTrackedFile("old", "new");
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");

		const review = state.activeReviews.get("/ws/file.ts")!;
		const snapshot = {
			filePath: review.filePath,
			originalContent: review.originalContent,
			modifiedContent: review.modifiedContent,
			changeType: review.changeType,
			hunks: JSON.parse(JSON.stringify(review.hunks)),
			mergedLines: [...review.mergedLines],
			hunkRanges: review.hunkRanges.map(r => ({ ...r })),
		};

		// Accept
		await mgr.resolveAllHunks("/ws/file.ts", true);
		expect(state.activeReviews.has("/ws/file.ts")).toBe(false);

		// Undo
		mgr.restoreFromSnapshot("/ws/file.ts", snapshot);
		expect(state.activeReviews.has("/ws/file.ts")).toBe(true);

		// Reject this time
		await mgr.resolveAllHunks("/ws/file.ts", false);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith("/ws/file.ts", expect.stringContaining("old"), "utf8");
	});
});

describe("multiple files navigation", () => {
	it("getUnresolvedFiles tracks all added files", () => {
		const mgr = setupManager();

		setupTrackedFile("a", "a-new");
		mgr.addFile("/ws/a.ts");

		setupTrackedFile("b", "b-new");
		mgr.addFile("/ws/b.ts");

		setupTrackedFile("c", "c-new");
		mgr.addFile("/ws/c.ts");

		expect(mgr.getUnresolvedFiles()).toHaveLength(3);
	});
});
