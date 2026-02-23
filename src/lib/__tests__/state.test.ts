import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => import("./mocks/vscode"));

import * as state from "../state";

beforeEach(() => {
	state.setReviewFiles([]);
	state.setCurrentFileIndex(0);
	state.setCurrentHunkIndex(0);
	state.activeReviews.clear();
});

describe("state getters/setters", () => {
	it("setReviewFiles/getReviewFiles round-trip", () => {
		state.setReviewFiles(["a.ts", "b.ts"]);
		expect(state.getReviewFiles()).toEqual(["a.ts", "b.ts"]);
	});

	it("setCurrentFileIndex/getCurrentFileIndex round-trip", () => {
		state.setCurrentFileIndex(5);
		expect(state.getCurrentFileIndex()).toBe(5);
	});

	it("setCurrentHunkIndex/getCurrentHunkIndex round-trip", () => {
		state.setCurrentHunkIndex(3);
		expect(state.getCurrentHunkIndex()).toBe(3);
	});

	it("activeReviews Map operations", () => {
		const review = { filePath: "f" } as import("../../types").IFileReview;
		state.activeReviews.set("f", review);
		expect(state.activeReviews.has("f")).toBe(true);
		expect(state.activeReviews.get("f")).toBe(review);
		state.activeReviews.delete("f");
		expect(state.activeReviews.has("f")).toBe(false);
	});
});

describe("refresh functions", () => {
	it("refreshAll calls codeLens.refresh and mainView.update", () => {
		const codeLens = { refresh: vi.fn() };
		const mainView = { update: vi.fn() };
		state.setCodeLensProvider(codeLens);
		state.setMainView(mainView);
		state.refreshAll();
		expect(codeLens.refresh).toHaveBeenCalled();
		expect(mainView.update).toHaveBeenCalled();
	});

	it("setRefreshAll replaces refresh behavior", () => {
		const custom = vi.fn();
		state.setRefreshAll((base) => { custom(); base(); });
		state.refreshAll();
		expect(custom).toHaveBeenCalled();
	});

	it("setRefreshReview replaces refreshReview behavior", () => {
		const custom = vi.fn();
		state.setRefreshReview((base) => { custom(); base(); });
		state.refreshReview();
		expect(custom).toHaveBeenCalled();
	});
});
