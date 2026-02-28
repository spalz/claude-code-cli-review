import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFs = vi.hoisted(() => ({
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
	renameSync: vi.fn(),
	readFileSync: vi.fn(),
	unlinkSync: vi.fn(),
}));

vi.mock("fs", () => mockFs);
vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn(), logCat: vi.fn() }));

import { saveReviewState, loadReviewState, clearReviewState } from "../persistence";
import type { IFileReview } from "../../types";
import { makeHunk } from "./helpers";

function fakeReview(filePath: string): IFileReview {
	return {
		filePath,
		originalContent: "orig",
		modifiedContent: "mod",
		changeType: "edit",
		hunks: [makeHunk()],
		mergedLines: [],
		hunkRanges: [],
		get unresolvedCount() {
			return this.hunks.filter((h) => !h.resolved).length;
		},
		get isFullyResolved() {
			return this.hunks.every((h) => h.resolved);
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("saveReviewState", () => {
	it("writes JSON with version=1 via atomic rename", () => {
		const reviews = new Map<string, IFileReview>([["f.ts", fakeReview("f.ts")]]);
		saveReviewState("/ws", reviews, 0);

		expect(mockFs.mkdirSync).toHaveBeenCalled();
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			expect.stringContaining(".tmp"),
			expect.stringContaining('"version":1'),
			"utf8",
		);
		expect(mockFs.renameSync).toHaveBeenCalled();
	});

	it("saves empty files array for empty Map", () => {
		saveReviewState("/ws", new Map(), 0);
		const written = mockFs.writeFileSync.mock.calls[0][1] as string;
		const data = JSON.parse(written);
		expect(data.files).toEqual([]);
	});

	it("cleans up .tmp file on write error", () => {
		mockFs.writeFileSync.mockImplementation(() => {
			throw new Error("disk full");
		});
		saveReviewState("/ws", new Map([["f", fakeReview("f")]]), 0);
		expect(mockFs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining(".tmp"));
	});

	it("serializes hunks, changeType, originalContent, modifiedContent", () => {
		const reviews = new Map<string, IFileReview>([["f.ts", fakeReview("f.ts")]]);
		saveReviewState("/ws", reviews, 0);
		const written = mockFs.writeFileSync.mock.calls[0][1] as string;
		const data = JSON.parse(written);
		expect(data.files[0]).toHaveProperty("hunks");
		expect(data.files[0]).toHaveProperty("changeType", "edit");
		expect(data.files[0]).toHaveProperty("originalContent", "orig");
		expect(data.files[0]).toHaveProperty("modifiedContent", "mod");
	});
});

describe("loadReviewState", () => {
	it("loads valid JSON", () => {
		const state = { version: 1, timestamp: 1, files: [], currentFileIndex: 0 };
		mockFs.readFileSync.mockReturnValue(JSON.stringify(state));
		expect(loadReviewState("/ws")).toEqual(state);
	});

	it("returns null for missing file", () => {
		mockFs.readFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		expect(loadReviewState("/ws")).toBeNull();
	});

	it("returns null for invalid JSON", () => {
		mockFs.readFileSync.mockReturnValue("not json");
		expect(loadReviewState("/ws")).toBeNull();
	});

	it("returns null for version != 1", () => {
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ version: 2, files: [] }));
		expect(loadReviewState("/ws")).toBeNull();
	});

	it("returns null when files array is missing", () => {
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ version: 1 }));
		expect(loadReviewState("/ws")).toBeNull();
	});
});

describe("clearReviewState", () => {
	it("deletes the state file", () => {
		clearReviewState("/ws");
		expect(mockFs.unlinkSync).toHaveBeenCalledWith(
			expect.stringContaining("review-state.json"),
		);
	});

	it("does not throw if file does not exist", () => {
		mockFs.unlinkSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		expect(() => clearReviewState("/ws")).not.toThrow();
	});
});
