import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn() }));
vi.mock("../file-logger", () => ({ fileLog: { log: vi.fn() } }));

const mockExecSync = vi.fn();
vi.mock("child_process", () => ({ execSync: (...args: unknown[]) => mockExecSync(...args) }));

const mockExistsSync = vi.fn();
const mockStatSync = vi.fn();
vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs");
	return {
		...actual,
		existsSync: (...args: unknown[]) => mockExistsSync(...args),
		statSync: (...args: unknown[]) => mockStatSync(...args),
	};
});

const mockSessions = vi.hoisted(() => ({
	deleteSession: vi.fn(),
	archiveSession: vi.fn(),
	unarchiveSession: vi.fn(),
	saveSessionName: vi.fn(),
	listSessions: vi.fn().mockReturnValue({ sessions: [], hasMore: false, archivedCount: 0 }),
	listArchivedSessions: vi.fn().mockReturnValue([]),
}));
vi.mock("../sessions", () => mockSessions);
vi.mock("../state", () => ({ refreshAll: vi.fn() }));
vi.mock("../actions", () => ({
	resolveAllHunks: vi.fn(),
	openFileForReview: vi.fn(),
	navigateFile: vi.fn(),
	navigateHunk: vi.fn(),
	reviewNextUnresolved: vi.fn(),
}));
vi.mock("../claude-settings", () => ({
	readClaudeSettings: vi.fn().mockReturnValue({ effective: {}, global: {}, project: {}, runtime: {} }),
	readClaudeSettingsScoped: vi.fn().mockReturnValue({}),
	writeClaudeSetting: vi.fn(),
	writeClaudeRuntimeState: vi.fn(),
	trustProject: vi.fn(),
}));

import { resolveClipboard, handleWebviewMessage } from "../main-view/message-handler";
import type { MessageContext } from "../main-view/message-handler";
import { env as mockVscodeEnv } from "./mocks/vscode";

// Helper to set process.platform for tests
const originalPlatform = process.platform;
function setPlatform(p: string) {
	Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function createMockContext(overrides?: Partial<MessageContext>): MessageContext {
	return {
		sessionMgr: {
			refreshClaudeSessions: vi.fn(),
			restoreSessions: vi.fn(),
			startNewClaudeSession: vi.fn(),
			findPtyByClaudeId: vi.fn().mockReturnValue(null),
			getPtyToClaudeId: vi.fn().mockReturnValue(new Map()),
			removeOpenSession: vi.fn(),
			removeOpenSessionByClaudeId: vi.fn(),
			isLazyPlaceholder: vi.fn().mockReturnValue(false),
			sendOpenSessionIds: vi.fn(),
			persistActiveSession: vi.fn(),
		} as unknown as MessageContext["sessionMgr"],
		ptyManager: {
			closeSession: vi.fn(),
			writeToSession: vi.fn(),
			resizeSession: vi.fn(),
		} as unknown as MessageContext["ptyManager"],
		wp: "/ws",
		postMessage: vi.fn(),
		getKeybindings: vi.fn().mockReturnValue([]),
		webviewReady: true,
		pendingHookStatus: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockExecSync.mockReset();
	mockExistsSync.mockReset();
	mockStatSync.mockReset();
	(mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue("");
	setPlatform("darwin");
});

afterEach(() => {
	setPlatform(originalPlatform);
});

// ─── resolveClipboard ───────────────────────────────────────────────

describe("resolveClipboard", () => {
	describe("macOS (darwin)", () => {
		it("returns file path from osascript «class furl» when file is copied in Finder", async () => {
			mockExecSync.mockReturnValueOnce("/Users/test/Documents/file.pdf\n");
			const result = await resolveClipboard();
			expect(result).toEqual({ type: "text", text: "/Users/test/Documents/file.pdf" });
			expect(mockExecSync).toHaveBeenCalledWith(
				expect.stringContaining("class furl"),
				expect.objectContaining({ encoding: "utf8", timeout: 2000 }),
			);
		});

		it("falls back to clipboard text when no furl in clipboard", async () => {
			mockExecSync.mockReturnValueOnce(""); // osascript returns empty
			(mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce("hello world");
			const result = await resolveClipboard();
			expect(result).toEqual({ type: "text", text: "hello world" });
		});

		it("falls back to clipboard text when osascript throws", async () => {
			mockExecSync.mockImplementationOnce(() => { throw new Error("osascript error"); });
			(mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce("pasted text");
			const result = await resolveClipboard();
			expect(result).toEqual({ type: "text", text: "pasted text" });
		});

		it("saves screenshot as PNG when clipboard has image but no text", async () => {
			// Step 1: osascript furl fails
			mockExecSync.mockImplementationOnce(() => { throw new Error("no furl"); });
			// Step 2: clipboard text is empty
			(mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce("");
			// Step 3: osascript PNGf succeeds
			mockExecSync.mockReturnValueOnce("ok");
			mockExistsSync.mockReturnValueOnce(true);
			mockStatSync.mockReturnValueOnce({ size: 12345 });

			const result = await resolveClipboard();
			expect(result).not.toBeNull();
			expect(result!.type).toBe("image");
			expect((result as { type: "image"; tmpPath: string }).tmpPath).toMatch(/ccr-paste-\d+\.png/);
		});

		it("returns null when clipboard is completely empty", async () => {
			mockExecSync.mockImplementationOnce(() => { throw new Error("no furl"); });
			(mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce("");
			mockExecSync.mockImplementationOnce(() => { throw new Error("no image"); });

			const result = await resolveClipboard();
			expect(result).toBeNull();
		});

		it("returns null when screenshot file is empty (0 bytes)", async () => {
			mockExecSync.mockImplementationOnce(() => { throw new Error("no furl"); });
			(mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce("");
			mockExecSync.mockReturnValueOnce("ok");
			mockExistsSync.mockReturnValueOnce(true);
			mockStatSync.mockReturnValueOnce({ size: 0 });

			const result = await resolveClipboard();
			expect(result).toBeNull();
		});

		it("prefers furl path over clipboard text (file copied in Finder)", async () => {
			// osascript furl returns full path
			mockExecSync.mockReturnValueOnce("/Users/test/file.apk\n");
			// clipboard text would return just filename
			(mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce("file.apk");

			const result = await resolveClipboard();
			expect(result).toEqual({ type: "text", text: "/Users/test/file.apk" });
			// clipboard.readText should NOT be called — furl was found first
			expect(mockVscodeEnv.clipboard.readText).not.toHaveBeenCalled();
		});
	});

	describe("non-macOS", () => {
		beforeEach(() => setPlatform("linux"));

		it("reads text from vscode clipboard API", async () => {
			(mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce("linux text");
			const result = await resolveClipboard();
			expect(result).toEqual({ type: "text", text: "linux text" });
			// osascript should never be called
			expect(mockExecSync).not.toHaveBeenCalled();
		});

		it("returns null for empty clipboard", async () => {
			(mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce("");
			const result = await resolveClipboard();
			expect(result).toBeNull();
		});
	});
});

// ─── read-clipboard message handler ─────────────────────────────────

describe("read-clipboard handler", () => {
	it("writes bracket-pasted text to PTY session", async () => {
		mockExecSync.mockImplementationOnce(() => { throw new Error("no furl"); });
		(mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce("some text");

		const ctx = createMockContext();
		handleWebviewMessage({ type: "read-clipboard", sessionId: 5 }, ctx);

		// Wait for async resolveClipboard
		await new Promise(r => setTimeout(r, 20));

		expect(ctx.ptyManager.writeToSession).toHaveBeenCalledWith(
			5,
			"\x1b[200~some text\x1b[201~",
		);
	});

	it("writes full file path when furl is available", async () => {
		mockExecSync.mockReturnValueOnce("/Users/test/doc.pdf\n");

		const ctx = createMockContext();
		handleWebviewMessage({ type: "read-clipboard", sessionId: 3 }, ctx);

		await new Promise(r => setTimeout(r, 20));

		expect(ctx.ptyManager.writeToSession).toHaveBeenCalledWith(
			3,
			"\x1b[200~/Users/test/doc.pdf\x1b[201~",
		);
	});

	it("writes screenshot tmp path when clipboard has image only", async () => {
		mockExecSync.mockImplementationOnce(() => { throw new Error("no furl"); });
		(mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce("");
		mockExecSync.mockReturnValueOnce("ok");
		mockExistsSync.mockReturnValueOnce(true);
		mockStatSync.mockReturnValueOnce({ size: 5000 });

		const ctx = createMockContext();
		handleWebviewMessage({ type: "read-clipboard", sessionId: 7 }, ctx);

		await new Promise(r => setTimeout(r, 20));

		expect(ctx.ptyManager.writeToSession).toHaveBeenCalledWith(
			7,
			expect.stringMatching(/\x1b\[200~.*ccr-paste-\d+\.png\x1b\[201~/),
		);
	});

	it("does not write to PTY when clipboard is empty", async () => {
		mockExecSync.mockImplementationOnce(() => { throw new Error("no furl"); });
		(mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce("");
		mockExecSync.mockImplementationOnce(() => { throw new Error("no image"); });

		const ctx = createMockContext();
		handleWebviewMessage({ type: "read-clipboard", sessionId: 1 }, ctx);

		await new Promise(r => setTimeout(r, 20));

		expect(ctx.ptyManager.writeToSession).not.toHaveBeenCalled();
	});
});

// ─── terminal-input ─────────────────────────────────────────────────

describe("terminal-input handler", () => {
	it("forwards data to PTY session", () => {
		const ctx = createMockContext();
		handleWebviewMessage({ type: "terminal-input", sessionId: 5, data: "hello" }, ctx);
		expect(ctx.ptyManager.writeToSession).toHaveBeenCalledWith(5, "hello");
	});

	it("forwards bracket paste data as-is", () => {
		const ctx = createMockContext();
		const bracketPaste = "\x1b[200~some paste\x1b[201~";
		handleWebviewMessage({ type: "terminal-input", sessionId: 5, data: bracketPaste }, ctx);
		expect(ctx.ptyManager.writeToSession).toHaveBeenCalledWith(5, bracketPaste);
	});
});

// ─── paste-image handler ────────────────────────────────────────────

describe("paste-image handler", () => {
	it("saves base64 image to tmp file and writes path to PTY", () => {
		const ctx = createMockContext();
		// Use a small valid base64 string
		const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==";

		handleWebviewMessage(
			{ type: "paste-image", sessionId: 2, data: base64, mimeType: "image/png" },
			ctx,
		);

		expect(ctx.ptyManager.writeToSession).toHaveBeenCalledWith(
			2,
			expect.stringContaining("/ccr-paste-"),
		);
	});

	it("uses .jpg extension for JPEG images", () => {
		const ctx = createMockContext();
		handleWebviewMessage(
			{ type: "paste-image", sessionId: 2, data: "base64data", mimeType: "image/jpeg" },
			ctx,
		);

		const writtenPath = (ctx.ptyManager.writeToSession as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
		expect(writtenPath).toMatch(/\.jpg$/);
	});
});
