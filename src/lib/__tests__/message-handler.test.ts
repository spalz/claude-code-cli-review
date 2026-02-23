import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn() }));

const mockSessions = vi.hoisted(() => ({
	deleteSession: vi.fn(),
	archiveSession: vi.fn(),
	unarchiveSession: vi.fn(),
	saveSessionName: vi.fn(),
	listSessions: vi.fn().mockReturnValue({ sessions: [], hasMore: false, archivedCount: 0 }),
	listArchivedSessions: vi.fn().mockReturnValue([]),
}));
vi.mock("../sessions", () => mockSessions);

const mockState = vi.hoisted(() => ({
	refreshAll: vi.fn(),
}));
vi.mock("../state", () => mockState);

const mockActions = vi.hoisted(() => ({
	resolveAllHunks: vi.fn(),
	openFileForReview: vi.fn(),
	navigateFile: vi.fn(),
	navigateHunk: vi.fn(),
	reviewNextUnresolved: vi.fn(),
}));
vi.mock("../actions", () => mockActions);

import { handleWebviewMessage } from "../main-view/message-handler";
import type { MessageContext } from "../main-view/message-handler";
import type { ExtensionToWebviewMessage, HookStatus } from "../../types";
import { window as mockVscodeWindow } from "./mocks/vscode";

function createMockContext(overrides?: Partial<MessageContext>): MessageContext {
	return {
		sessionMgr: {
			refreshClaudeSessions: vi.fn(),
			restoreSessions: vi.fn(),
			startNewClaudeSession: vi.fn(),
			findPtyByClaudeId: vi.fn().mockReturnValue(null),
			getPtyToClaudeId: vi.fn().mockReturnValue(new Map()),
			removeOpenSession: vi.fn(),
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
		webviewReady: false,
		pendingHookStatus: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ─── rename-session ──────────────────────────────────────────────────

describe("rename-session", () => {
	it("saves name to session-names.json and sends success", () => {
		const ctx = createMockContext();
		handleWebviewMessage(
			{ type: "rename-session", sessionId: "sess-abc", newName: "New Name" },
			ctx,
		);
		expect(mockSessions.saveSessionName).toHaveBeenCalledWith("/ws", "sess-abc", "New Name");
		expect(ctx.postMessage).toHaveBeenCalledWith({
			type: "rename-result",
			claudeId: "sess-abc",
			newName: "New Name",
			success: true,
		});
		expect(ctx.sessionMgr.refreshClaudeSessions).toHaveBeenCalled();
	});

	it("never injects /rename into active PTY", () => {
		const ctx = createMockContext();
		(ctx.sessionMgr.findPtyByClaudeId as ReturnType<typeof vi.fn>).mockReturnValue(5);
		handleWebviewMessage(
			{ type: "rename-session", sessionId: "sess-abc", newName: "New Name" },
			ctx,
		);
		expect(mockSessions.saveSessionName).toHaveBeenCalledWith("/ws", "sess-abc", "New Name");
		expect(ctx.ptyManager.writeToSession).not.toHaveBeenCalled();
	});

	it("sends rename-result with success=false on write error", () => {
		mockSessions.saveSessionName.mockImplementationOnce(() => {
			throw new Error("EACCES");
		});
		const ctx = createMockContext();
		handleWebviewMessage(
			{ type: "rename-session", sessionId: "sess-abc", newName: "New Name" },
			ctx,
		);
		expect(ctx.postMessage).toHaveBeenCalledWith({
			type: "rename-result",
			claudeId: "sess-abc",
			newName: "New Name",
			success: false,
		});
		expect(ctx.sessionMgr.refreshClaudeSessions).not.toHaveBeenCalled();
	});
});

// ─── delete-session ──────────────────────────────────────────────────

describe("delete-session", () => {
	it("calls deleteSession and refreshes", () => {
		const ctx = createMockContext();
		handleWebviewMessage({ type: "delete-session", sessionId: "sess-del" }, ctx);
		expect(mockSessions.deleteSession).toHaveBeenCalledWith("/ws", "sess-del");
		expect(ctx.sessionMgr.refreshClaudeSessions).toHaveBeenCalled();
	});

	it("closes PTY if session is open", () => {
		const ctx = createMockContext();
		(ctx.sessionMgr.findPtyByClaudeId as ReturnType<typeof vi.fn>).mockReturnValue(42);
		const mockPtyMap = new Map<number, string>();
		(ctx.sessionMgr.getPtyToClaudeId as ReturnType<typeof vi.fn>).mockReturnValue(mockPtyMap);

		handleWebviewMessage({ type: "delete-session", sessionId: "sess-del" }, ctx);

		expect(ctx.ptyManager.closeSession).toHaveBeenCalledWith(42);
		expect(ctx.sessionMgr.removeOpenSession).toHaveBeenCalledWith(42);
	});

	it("sends terminal-session-closed when PTY is closed", () => {
		const ctx = createMockContext();
		(ctx.sessionMgr.findPtyByClaudeId as ReturnType<typeof vi.fn>).mockReturnValue(7);
		const mockPtyMap = new Map<number, string>();
		(ctx.sessionMgr.getPtyToClaudeId as ReturnType<typeof vi.fn>).mockReturnValue(mockPtyMap);

		handleWebviewMessage({ type: "delete-session", sessionId: "sess-del" }, ctx);

		expect(ctx.postMessage).toHaveBeenCalledWith({
			type: "terminal-session-closed",
			sessionId: 7,
		});
	});
});

// ─── archive-session ─────────────────────────────────────────────────

describe("archive-session", () => {
	it("calls archiveSession and refreshes", () => {
		const ctx = createMockContext();
		handleWebviewMessage({ type: "archive-session", sessionId: "sess-arch" }, ctx);
		expect(mockSessions.archiveSession).toHaveBeenCalledWith("/ws", "sess-arch");
		expect(ctx.sessionMgr.refreshClaudeSessions).toHaveBeenCalled();
	});

	it("does not close PTY", () => {
		const ctx = createMockContext();
		handleWebviewMessage({ type: "archive-session", sessionId: "sess-arch" }, ctx);
		expect(ctx.ptyManager.closeSession).not.toHaveBeenCalled();
	});
});

// ─── unarchive-session ───────────────────────────────────────────────

describe("unarchive-session", () => {
	it("calls unarchiveSession and refreshes", () => {
		const ctx = createMockContext();
		handleWebviewMessage({ type: "unarchive-session", sessionId: "sess-unarch" }, ctx);
		expect(mockSessions.unarchiveSession).toHaveBeenCalledWith("/ws", "sess-unarch");
		expect(ctx.sessionMgr.refreshClaudeSessions).toHaveBeenCalled();
	});

	it("does not close PTY", () => {
		const ctx = createMockContext();
		handleWebviewMessage({ type: "unarchive-session", sessionId: "sess-unarch" }, ctx);
		expect(ctx.ptyManager.closeSession).not.toHaveBeenCalled();
	});
});

// ─── load-archived-sessions ──────────────────────────────────────────

describe("load-archived-sessions", () => {
	it("calls listArchivedSessions and posts result", () => {
		const mockArchived = [
			{ id: "a1", title: "Archived 1", timestamp: "2024-01-01", size: 100, messageCount: 5, branch: null },
		];
		mockSessions.listArchivedSessions.mockReturnValue(mockArchived);
		const ctx = createMockContext();
		handleWebviewMessage({ type: "load-archived-sessions" }, ctx);
		expect(mockSessions.listArchivedSessions).toHaveBeenCalledWith("/ws");
		expect(ctx.postMessage).toHaveBeenCalledWith({
			type: "archived-sessions-list",
			sessions: mockArchived,
		});
	});

	it("posts empty array when no archived sessions", () => {
		mockSessions.listArchivedSessions.mockReturnValue([]);
		const ctx = createMockContext();
		handleWebviewMessage({ type: "load-archived-sessions" }, ctx);
		expect(ctx.postMessage).toHaveBeenCalledWith({
			type: "archived-sessions-list",
			sessions: [],
		});
	});
});

// ─── webview-ready ───────────────────────────────────────────────────

describe("webview-ready", () => {
	it("sets webviewReady to true", () => {
		const ctx = createMockContext({ webviewReady: false });
		const result = handleWebviewMessage({ type: "webview-ready" }, ctx);
		expect(result.webviewReady).toBe(true);
	});

	it("calls refreshClaudeSessions and restoreSessions", () => {
		const ctx = createMockContext({ webviewReady: false });
		handleWebviewMessage({ type: "webview-ready" }, ctx);
		expect(ctx.sessionMgr.refreshClaudeSessions).toHaveBeenCalled();
		expect(ctx.sessionMgr.restoreSessions).toHaveBeenCalled();
	});

	it("sends pending hook status if present", () => {
		const ctx = createMockContext({
			webviewReady: false,
			pendingHookStatus: "installed" as HookStatus,
		});
		const result = handleWebviewMessage({ type: "webview-ready" }, ctx);
		expect(ctx.postMessage).toHaveBeenCalledWith({
			type: "hook-status",
			status: "installed",
		});
		expect(result.pendingHookStatus).toBeNull();
	});
});

// ─── blocked-slash-command ───────────────────────────────────────────

describe("blocked-slash-command", () => {
	it("shows warning message for /exit", () => {
		const ctx = createMockContext();
		handleWebviewMessage({ type: "blocked-slash-command", command: "/exit" }, ctx);
		expect(mockVscodeWindow.showWarningMessage).toHaveBeenCalledWith(
			"/exit is disabled in embedded sessions. Use UI controls instead.",
		);
	});

	it("shows warning message for /resume", () => {
		const ctx = createMockContext();
		handleWebviewMessage({ type: "blocked-slash-command", command: "/resume" }, ctx);
		expect(mockVscodeWindow.showWarningMessage).toHaveBeenCalledWith(
			"/resume is disabled in embedded sessions. Use UI controls instead.",
		);
	});
});

