import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../undo-history", () => ({ clearHistory: vi.fn() }));

import { registerDocumentListener } from "../document-listener";
import { workspace } from "vscode";
import { clearHistory } from "../undo-history";

describe("registerDocumentListener", () => {
	let context: { subscriptions: { dispose: () => void }[] };

	beforeEach(() => {
		vi.clearAllMocks();
		context = { subscriptions: [] };
	});

	it("returns a Disposable", () => {
		const result = registerDocumentListener(context as any);
		expect(result).toBeDefined();
		expect(typeof result.dispose).toBe("function");
	});

	it("pushes disposable to context.subscriptions", () => {
		registerDocumentListener(context as any);
		expect(context.subscriptions.length).toBe(1);
	});

	it("registers onDidCloseTextDocument listener", () => {
		registerDocumentListener(context as any);
		expect(workspace.onDidCloseTextDocument).toHaveBeenCalledOnce();
	});

	it("calls clearHistory with fsPath when document is closed", () => {
		// Capture the callback passed to onDidCloseTextDocument
		let callback: (doc: any) => void;
		vi.mocked(workspace.onDidCloseTextDocument).mockImplementation((cb: any) => {
			callback = cb;
			return { dispose: vi.fn() };
		});

		registerDocumentListener(context as any);
		callback!({ uri: { fsPath: "/some/file.ts" } });

		expect(clearHistory).toHaveBeenCalledWith("/some/file.ts");
	});

	it("dispose cleans up the listener", () => {
		const disposeFn = vi.fn();
		vi.mocked(workspace.onDidCloseTextDocument).mockReturnValue({ dispose: disposeFn });

		const result = registerDocumentListener(context as any);
		result.dispose();

		expect(disposeFn).toHaveBeenCalled();
	});
});
