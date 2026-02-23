// Shared state — reviews + session tracking
import type { IFileReview } from "../types";

interface ICodeLensProvider {
	refresh(): void;
}

interface IMainView {
	update(): void;
}

export const activeReviews = new Map<string, IFileReview>();
let reviewFiles: string[] = [];
let currentFileIndex = 0;
let currentHunkIndex = 0;

let codeLensProvider: ICodeLensProvider | null = null;
let mainView: IMainView | null = null;

export function setCodeLensProvider(p: ICodeLensProvider): void {
	codeLensProvider = p;
}
export function setMainView(p: IMainView): void {
	mainView = p;
}

export function getReviewFiles(): string[] {
	return reviewFiles;
}
export function setReviewFiles(files: string[]): void {
	reviewFiles = files;
}
export function getCurrentFileIndex(): number {
	return currentFileIndex;
}
export function setCurrentFileIndex(idx: number): void {
	currentFileIndex = idx;
}

export function getCurrentHunkIndex(): number {
	return currentHunkIndex;
}
export function setCurrentHunkIndex(idx: number): void {
	currentHunkIndex = idx;
}

function baseRefresh(): void {
	codeLensProvider?.refresh();
	mainView?.update();
}

let _refreshAll: () => void = baseRefresh;
let _refreshReview: () => void = baseRefresh;

export function refreshAll(): void {
	_refreshAll();
}

export function refreshReview(): void {
	_refreshReview();
}

export function setRefreshAll(fn: (base: () => void) => void): void {
	_refreshAll = () => fn(baseRefresh);
}

export function setRefreshReview(fn: (base: () => void) => void): void {
	_refreshReview = () => fn(baseRefresh);
}

export function getCodeLensProvider(): ICodeLensProvider | null {
	return codeLensProvider;
}
