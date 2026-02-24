// Minimal vscode API mock for unit tests
import { vi } from "vitest";

type Listener<T> = (data: T) => void;

export class EventEmitter<T> {
	private listeners: Listener<T>[] = [];
	event = (listener: Listener<T>) => {
		this.listeners.push(listener);
		return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
	};
	fire(data: T) { for (const l of this.listeners) l(data); }
	dispose() { this.listeners = []; }
}

export class Position {
	constructor(public line: number, public character: number) {}
}

export class Range {
	start: Position;
	end: Position;
	constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
		this.start = new Position(startLine, startChar);
		this.end = new Position(endLine, endChar);
	}
}

export class Selection extends Range {
	get active() { return this.end; }
	get anchor() { return this.start; }
}

export class Uri {
	constructor(public fsPath: string) {}
	static file(p: string) { return new Uri(p); }
	static parse(s: string) { return new Uri(s); }
	static joinPath(base: Uri, ...segments: string[]) { return new Uri([base.fsPath, ...segments].join("/")); }
	toString() { return this.fsPath; }
}

export enum TextEditorRevealType {
	Default = 0,
	InCenter = 1,
	InCenterIfOutsideViewport = 2,
	AtTop = 3,
}

export enum ViewColumn {
	One = 1,
	Two = 2,
}

export const window = {
	activeTextEditor: null as unknown,
	visibleTextEditors: [] as unknown[],
	showInformationMessage: vi.fn(),
	showWarningMessage: vi.fn(),
	showErrorMessage: vi.fn(),
	setStatusBarMessage: vi.fn(),
	showTextDocument: vi.fn().mockResolvedValue({
		revealRange: vi.fn(),
		selection: null,
		document: { uri: { fsPath: "" } },
	}),
	createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn() })),
};

export const commands = {
	executeCommand: vi.fn().mockResolvedValue(undefined),
};

export class Disposable {
	constructor(private callOnDispose: () => void) {}
	dispose() { this.callOnDispose(); }
	static from(...disposables: { dispose: () => void }[]) {
		return new Disposable(() => disposables.forEach(d => d.dispose()));
	}
}

export class CodeLens {
	range: Range;
	command?: { title: string; tooltip?: string; command: string; arguments?: unknown[] };
	constructor(range: Range, command?: CodeLens["command"]) {
		this.range = range;
		this.command = command;
	}
}

export class MarkdownString {
	value = "";
	isTrusted = false;
	supportHtml = false;
	appendMarkdown(value: string) { this.value += value; return this; }
	appendText(value: string) { this.value += value; return this; }
}

export class ThemeColor {
	id: string;
	constructor(id: string) { this.id = id; }
}

export enum OverviewRulerLane {
	Left = 1,
	Center = 2,
	Right = 4,
	Full = 7,
}

export const env = {
	openExternal: vi.fn().mockResolvedValue(true),
};

export const workspace = {
	workspaceFolders: [{ uri: new Uri("/ws") }] as { uri: Uri }[],
	fs: {
		stat: vi.fn().mockResolvedValue({ type: 1, size: 100 }),
	},
	openTextDocument: vi.fn().mockResolvedValue({ uri: { fsPath: "" } }),
	onDidChangeTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	onDidCloseTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	getConfiguration: vi.fn().mockReturnValue({
		get: vi.fn().mockImplementation((_key: string, defaultValue?: unknown) => defaultValue),
		update: vi.fn().mockResolvedValue(undefined),
	}),
};
