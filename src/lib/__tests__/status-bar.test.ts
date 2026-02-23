import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
	const statusBarItem = {
		text: "",
		tooltip: "",
		command: "",
		backgroundColor: undefined as unknown,
		show: vi.fn(),
		hide: vi.fn(),
		dispose: vi.fn(),
	};
	const editorDisposable = { dispose: vi.fn() };
	const createStatusBarItemFn = vi.fn(() => statusBarItem);
	const onDidChangeActiveTextEditorFn = vi.fn(() => editorDisposable);
	return {
		statusBarItem,
		editorDisposable,
		createStatusBarItemFn,
		onDidChangeActiveTextEditorFn,
	};
});

vi.mock("vscode", () => ({
	StatusBarAlignment: { Left: 1, Right: 2 },
	ThemeColor: class ThemeColor {
		id: string;
		constructor(id: string) {
			this.id = id;
		}
	},
	window: {
		createStatusBarItem: mocks.createStatusBarItemFn,
		onDidChangeActiveTextEditor: mocks.onDidChangeActiveTextEditorFn,
	},
}));

vi.mock("../log", () => ({ log: vi.fn() }));

import * as state from "../state";
import { createReviewStatusBar, updateReviewStatusBar, dispose } from "../status-bar";
import type { IFileReview } from "../../types";

function makeContext(): { subscriptions: { dispose(): void }[] } {
	return { subscriptions: [] };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.statusBarItem.text = "";
	mocks.statusBarItem.tooltip = "";
	mocks.statusBarItem.command = "";
	mocks.statusBarItem.backgroundColor = undefined;
	state.setReviewFiles([]);
	state.activeReviews.clear();
});

describe("createReviewStatusBar", () => {
	it("creates a status bar item and pushes to subscriptions", () => {
		const ctx = makeContext();
		createReviewStatusBar(ctx as any, "/workspace");

		expect(mocks.createStatusBarItemFn).toHaveBeenCalledWith(1, 5);
		expect(mocks.statusBarItem.command).toBe("ccr.reviewNextUnresolved");
		expect(ctx.subscriptions.length).toBe(2);
	});

	it("registers an onDidChangeActiveTextEditor listener", () => {
		const ctx = makeContext();
		createReviewStatusBar(ctx as any, "/workspace");

		expect(mocks.onDidChangeActiveTextEditorFn).toHaveBeenCalled();
	});
});

describe("updateReviewStatusBar", () => {
	beforeEach(() => {
		const ctx = makeContext();
		createReviewStatusBar(ctx as any, "/workspace");
		vi.clearAllMocks();
	});

	it("hides when no review files are active", () => {
		state.setReviewFiles([]);
		state.activeReviews.clear();

		updateReviewStatusBar();

		expect(mocks.statusBarItem.hide).toHaveBeenCalled();
		expect(mocks.statusBarItem.show).not.toHaveBeenCalled();
	});

	it("hides when review files exist but none are in activeReviews", () => {
		state.setReviewFiles(["a.ts", "b.ts"]);
		state.activeReviews.clear();

		updateReviewStatusBar();

		expect(mocks.statusBarItem.hide).toHaveBeenCalled();
	});

	it("shows with correct text for 1 remaining file", () => {
		state.setReviewFiles(["a.ts"]);
		state.activeReviews.set("a.ts", { filePath: "a.ts" } as IFileReview);

		updateReviewStatusBar();

		expect(mocks.statusBarItem.text).toBe("$(play) Review next file (1 remaining)");
		expect(mocks.statusBarItem.tooltip).toBe("Open the next file with unresolved changes");
		expect(mocks.statusBarItem.show).toHaveBeenCalled();
	});

	it("shows correct count for multiple remaining files", () => {
		state.setReviewFiles(["a.ts", "b.ts", "c.ts"]);
		state.activeReviews.set("a.ts", { filePath: "a.ts" } as IFileReview);
		state.activeReviews.set("c.ts", { filePath: "c.ts" } as IFileReview);

		updateReviewStatusBar();

		expect(mocks.statusBarItem.text).toBe("$(play) Review next file (2 remaining)");
		expect(mocks.statusBarItem.show).toHaveBeenCalled();
	});

	it("only counts files that are both in reviewFiles and activeReviews", () => {
		state.setReviewFiles(["a.ts", "b.ts"]);
		state.activeReviews.set("a.ts", { filePath: "a.ts" } as IFileReview);
		state.activeReviews.set("c.ts", { filePath: "c.ts" } as IFileReview);

		updateReviewStatusBar();

		expect(mocks.statusBarItem.text).toBe("$(play) Review next file (1 remaining)");
	});

	it("sets warning background color", () => {
		state.setReviewFiles(["a.ts"]);
		state.activeReviews.set("a.ts", { filePath: "a.ts" } as IFileReview);

		updateReviewStatusBar();

		expect(mocks.statusBarItem.backgroundColor).toEqual(
			expect.objectContaining({ id: "statusBarItem.warningBackground" }),
		);
	});
});

describe("dispose", () => {
	it("disposes the editor listener", () => {
		const ctx = makeContext();
		createReviewStatusBar(ctx as any, "/workspace");
		vi.clearAllMocks();

		dispose();

		expect(mocks.editorDisposable.dispose).toHaveBeenCalled();
	});
});
