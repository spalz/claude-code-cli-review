import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn(), logCat: vi.fn() }));
vi.mock("../state", () => ({ refreshAll: vi.fn() }));
vi.mock("../claude-settings", () => ({
    isProjectTrusted: vi.fn().mockReturnValue(true),
    trustProject: vi.fn(),
}));
vi.mock("../hooks", () => ({
    isHookInstalled: vi.fn().mockReturnValue(true),
    installHook: vi.fn(),
    checkAndPrompt: vi.fn().mockReturnValue("installed"),
}));
vi.mock("../sessions", () => ({
    listSessions: vi.fn().mockReturnValue({ sessions: [], archivedCount: 0 }),
    getSessionsDir: vi.fn().mockReturnValue("/tmp/sessions"),
    loadSessionNames: vi.fn().mockReturnValue({}),
}));

const mockFs = vi.hoisted(() => ({
    readFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn(),
    watch: vi.fn().mockReturnValue({ close: vi.fn() }),
    existsSync: vi.fn().mockReturnValue(true),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
}));
vi.mock("fs", () => mockFs);

import { SessionManager } from "../main-view/session-manager";
import { listSessions, loadSessionNames } from "../sessions";
import type { PtyManager } from "../pty-manager";
import type { ExtensionToWebviewMessage } from "../../types";

// ─── Helpers ─────────────────────────────────────────────────────────

let ptyIdCounter: number;

function makePtyManager(): PtyManager {
    return {
        createSession: vi.fn().mockImplementation((name: string) => {
            const id = ++ptyIdCounter;
            return { id, name };
        }),
    } as unknown as PtyManager;
}

function makeMemento(data: Record<string, unknown> = {}): {
    get: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
} {
    const store = { ...data };
    return {
        get: vi.fn().mockImplementation((key: string) => store[key]),
        update: vi.fn().mockImplementation((key: string, value: unknown) => {
            (store as Record<string, unknown>)[key] = value;
            return Promise.resolve();
        }),
    };
}

let messages: ExtensionToWebviewMessage[];
let postMessage: (msg: ExtensionToWebviewMessage) => void;

function setup(
    opts: {
        savedSessions?: string[];
        activeSession?: string;
    } = {},
) {
    ptyIdCounter = 0;
    messages = [];
    postMessage = (msg) => messages.push(msg);

    const memento = makeMemento({
        "ccr.openSessions": opts.savedSessions,
        "ccr.activeSession": opts.activeSession,
    });
    const pty = makePtyManager();
    const mgr = new SessionManager("/ws", pty, memento as never, postMessage);
    return { mgr, pty, memento };
}

function findMessages(type: string): ExtensionToWebviewMessage[] {
    return messages.filter((m) => m.type === type);
}

beforeEach(() => {
    vi.clearAllMocks();
});

// ─── Constructor: eager loading of open IDs ─────────────────────────

describe("constructor", () => {
    it("eagerly loads saved open session IDs from persistence", () => {
        const { mgr } = setup({ savedSessions: ["aaa", "bbb"] });
        // refreshClaudeSessions should pass these IDs to listSessions
        mgr.refreshClaudeSessions();
        const call = (listSessions as ReturnType<typeof vi.fn>).mock.calls[0];
        const openIds: Set<string> = call[3];
        expect(openIds.has("aaa")).toBe(true);
        expect(openIds.has("bbb")).toBe(true);
    });

    it("handles missing workspace state gracefully", () => {
        messages = [];
        ptyIdCounter = 0;
        const mgr = new SessionManager("/ws", makePtyManager(), undefined, (msg) =>
            messages.push(msg),
        );
        mgr.sendOpenSessionIds();
        const msg = findMessages("open-sessions-update")[0] as { openClaudeIds: string[] };
        expect(msg.openClaudeIds).toEqual([]);
    });
});

// ─── sendOpenSessionIds ─────────────────────────────────────────────

describe("sendOpenSessionIds", () => {
    it("includes both real PTY sessions and lazy placeholders", () => {
        const { mgr } = setup({ savedSessions: ["aaa", "bbb"] });
        // "aaa" has a PTY (via startNewClaudeSession), "bbb" is lazy (only in _allOpenClaudeIds from constructor)
        mgr.startNewClaudeSession("aaa", true);
        messages = []; // clear

        mgr.sendOpenSessionIds();
        const msg = findMessages("open-sessions-update")[0] as { openClaudeIds: string[] };
        expect(msg.openClaudeIds).toContain("aaa");
        expect(msg.openClaudeIds).toContain("bbb");
    });
});

// ─── restoreSessions ────────────────────────────────────────────────

describe("restoreSessions", () => {
    it("creates PTY only for active session, sends lazy placeholders for rest", () => {
        const { mgr, pty } = setup({
            savedSessions: ["active-id", "lazy-id-1", "lazy-id-2"],
            activeSession: "active-id",
        });
        mgr.restoreSessions();

        // Only 1 PTY created (for active)
        expect(pty.createSession).toHaveBeenCalledTimes(1);

        // 2 lazy placeholders sent
        const lazyMsgs = findMessages("terminal-session-created").filter(
            (m) => (m as Record<string, unknown>).lazy === true,
        );
        expect(lazyMsgs).toHaveLength(2);
    });

    it("defaults to first session when activeSession not in saved list", () => {
        const { mgr, pty } = setup({
            savedSessions: ["first", "second"],
            activeSession: "deleted-session",
        });
        mgr.restoreSessions();

        // PTY created for "first" (the fallback)
        const createCall = (pty.createSession as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(createCall[1]).toContain("first");
    });

    it("is idempotent — second call is a no-op", () => {
        const { mgr, pty } = setup({ savedSessions: ["aaa"] });
        mgr.restoreSessions();
        mgr.restoreSessions();
        expect(pty.createSession).toHaveBeenCalledTimes(1);
    });

    it("skips sessions already opened via resume before restore", () => {
        const { mgr, pty } = setup({
            savedSessions: ["already-open", "lazy-one"],
            activeSession: "already-open",
        });
        // User clicked resume before restore ran
        mgr.startNewClaudeSession("already-open", false);
        expect(pty.createSession).toHaveBeenCalledTimes(1);

        // Now restore runs — should NOT create duplicate PTY for already-open
        mgr.restoreSessions();
        // Only 1 PTY total (the one from startNewClaudeSession, not duplicated)
        expect(pty.createSession).toHaveBeenCalledTimes(1);

        // lazy-one should still get a placeholder
        const lazyMsgs = findMessages("terminal-session-created").filter(
            (m) => (m as Record<string, unknown>).lazy === true,
        );
        expect(lazyMsgs).toHaveLength(1);
    });

    it("persists all IDs (real + lazy) after restore", () => {
        const { mgr, memento } = setup({
            savedSessions: ["active", "lazy1", "lazy2"],
            activeSession: "active",
        });
        mgr.restoreSessions();

        // Find the persist call after restore
        const persistCalls = memento.update.mock.calls.filter(
            (c: unknown[]) => c[0] === "ccr.openSessions",
        );
        const lastPersist = persistCalls[persistCalls.length - 1];
        const persisted = lastPersist[1] as string[];
        expect(persisted).toContain("active");
        expect(persisted).toContain("lazy1");
        expect(persisted).toContain("lazy2");
    });

    it("sends all IDs in open-sessions-update after restore", () => {
        const { mgr } = setup({
            savedSessions: ["active", "lazy1"],
            activeSession: "active",
        });
        mgr.restoreSessions();

        const updates = findMessages("open-sessions-update") as Array<{ openClaudeIds: string[] }>;
        const lastUpdate = updates[updates.length - 1];
        expect(lastUpdate.openClaudeIds).toContain("active");
        expect(lastUpdate.openClaudeIds).toContain("lazy1");
    });
});

// ─── lazyResume ─────────────────────────────────────────────────────

describe("lazyResume", () => {
    it("spawns PTY and sends lazy-session-ready", () => {
        const { mgr, pty } = setup({ savedSessions: ["lazy-id"] });
        mgr.lazyResume("lazy-id", -1);

        expect(pty.createSession).toHaveBeenCalledTimes(1);
        const readyMsg = findMessages("lazy-session-ready")[0] as Record<string, unknown>;
        expect(readyMsg.placeholderPtyId).toBe(-1);
        expect(readyMsg.realPtyId).toBe(1); // first PTY ID
        expect(readyMsg.claudeId).toBe("lazy-id");
    });

    it("skips if claudeId already has a PTY", () => {
        const { mgr, pty } = setup({ savedSessions: ["existing"] });
        mgr.startNewClaudeSession("existing", true);
        (pty.createSession as ReturnType<typeof vi.fn>).mockClear();
        messages = [];

        mgr.lazyResume("existing", -1);

        expect(pty.createSession).not.toHaveBeenCalled();
        expect(findMessages("activate-terminal")).toHaveLength(1);
    });

    it("keeps claudeId in _allOpenClaudeIds after lazy resume", () => {
        const { mgr } = setup({ savedSessions: ["lazy-id"] });
        mgr.lazyResume("lazy-id", -1);

        messages = [];
        mgr.sendOpenSessionIds();
        const msg = findMessages("open-sessions-update")[0] as { openClaudeIds: string[] };
        expect(msg.openClaudeIds).toContain("lazy-id");
    });
});

// ─── removeOpenSession ──────────────────────────────────────────────

describe("removeOpenSession", () => {
    it("removes from both PTY map and allOpenClaudeIds", () => {
        const { mgr } = setup({ savedSessions: ["sess-a", "sess-b"] });
        mgr.startNewClaudeSession("sess-a", true);
        const ptyId = 1; // first PTY

        mgr.removeOpenSession(ptyId);

        messages = [];
        mgr.sendOpenSessionIds();
        const msg = findMessages("open-sessions-update")[0] as { openClaudeIds: string[] };
        expect(msg.openClaudeIds).not.toContain("sess-a");
        // sess-b should still be there (loaded eagerly from constructor)
        expect(msg.openClaudeIds).toContain("sess-b");
    });

    it("persists after removal", () => {
        const { mgr, memento } = setup({ savedSessions: ["sess-a"] });
        mgr.startNewClaudeSession("sess-a", true);
        memento.update.mockClear();

        mgr.removeOpenSession(1);

        expect(memento.update).toHaveBeenCalledWith("ccr.openSessions", []);
    });
});

// ─── removeOpenSessionByClaudeId ─────────────────────────────────────

describe("removeOpenSessionByClaudeId", () => {
    it("removes lazy session (no PTY) from allOpenClaudeIds", () => {
        const { mgr } = setup({ savedSessions: ["real", "lazy"] });
        mgr.startNewClaudeSession("real", true);

        mgr.removeOpenSessionByClaudeId("lazy");

        messages = [];
        mgr.sendOpenSessionIds();
        const msg = findMessages("open-sessions-update")[0] as { openClaudeIds: string[] };
        expect(msg.openClaudeIds).toContain("real");
        expect(msg.openClaudeIds).not.toContain("lazy");
    });

    it("removes real PTY session and cleans up PTY mapping", () => {
        const { mgr } = setup({ savedSessions: ["sess"] });
        mgr.startNewClaudeSession("sess", true);

        mgr.removeOpenSessionByClaudeId("sess");

        expect(mgr.findPtyByClaudeId("sess")).toBeNull();
        messages = [];
        mgr.sendOpenSessionIds();
        const msg = findMessages("open-sessions-update")[0] as { openClaudeIds: string[] };
        expect(msg.openClaudeIds).not.toContain("sess");
    });

    it("persists after removal", () => {
        const { mgr, memento } = setup({ savedSessions: ["a", "b"] });
        memento.update.mockClear();

        mgr.removeOpenSessionByClaudeId("a");

        const persistCalls = memento.update.mock.calls.filter(
            (c: unknown[]) => c[0] === "ccr.openSessions",
        );
        expect(persistCalls).toHaveLength(1);
        expect(persistCalls[0][1]).toEqual(["b"]);
    });
});

// ─── startNewClaudeSession ──────────────────────────────────────────

describe("startNewClaudeSession", () => {
    it("adds resumeId to allOpenClaudeIds", () => {
        const { mgr } = setup();
        mgr.startNewClaudeSession("new-session", false);

        messages = [];
        mgr.sendOpenSessionIds();
        const msg = findMessages("open-sessions-update")[0] as { openClaudeIds: string[] };
        expect(msg.openClaudeIds).toContain("new-session");
    });

    it("does not add to allOpenClaudeIds when no resumeId (new session)", () => {
        const { mgr } = setup();
        mgr.startNewClaudeSession(undefined, false);

        messages = [];
        mgr.sendOpenSessionIds();
        const msg = findMessages("open-sessions-update")[0] as { openClaudeIds: string[] };
        expect(msg.openClaudeIds).toEqual([]);
    });
});

// ─── refreshClaudeSessions ──────────────────────────────────────────

describe("refreshClaudeSessions", () => {
    it("passes _allOpenClaudeIds (not just PTY sessions) to listSessions", () => {
        const { mgr } = setup({ savedSessions: ["real-pty", "lazy-only"] });
        mgr.startNewClaudeSession("real-pty", true);

        mgr.refreshClaudeSessions();

        const call = (listSessions as ReturnType<typeof vi.fn>).mock.calls[0];
        const openIds: Set<string> = call[3];
        expect(openIds.has("real-pty")).toBe(true);
        expect(openIds.has("lazy-only")).toBe(true);
    });
});

// ─── isLazyPlaceholder ──────────────────────────────────────────────

describe("isLazyPlaceholder", () => {
    it("returns false before restoreSessions (no placeholders in webview yet)", () => {
        const { mgr } = setup({ savedSessions: ["lazy-only"] });
        // _restored is false, so even though it's in _allOpenClaudeIds, no placeholder exists
        expect(mgr.isLazyPlaceholder("lazy-only")).toBe(false);
    });

    it("returns true for lazy session after restore", () => {
        const { mgr } = setup({
            savedSessions: ["active", "lazy"],
            activeSession: "active",
        });
        mgr.restoreSessions();
        // "lazy" has no PTY but is in _allOpenClaudeIds and restore has run
        expect(mgr.isLazyPlaceholder("lazy")).toBe(true);
    });

    it("returns false for session with real PTY", () => {
        const { mgr } = setup({ savedSessions: ["sess"] });
        mgr.restoreSessions();
        // "sess" is the active session and has a PTY
        expect(mgr.isLazyPlaceholder("sess")).toBe(false);
    });

    it("returns false for unknown sessions", () => {
        const { mgr } = setup({ savedSessions: ["known"] });
        mgr.restoreSessions();
        expect(mgr.isLazyPlaceholder("unknown")).toBe(false);
    });

    it("returns false after lazy session gets a PTY via lazyResume", () => {
        const { mgr } = setup({
            savedSessions: ["active", "lazy"],
            activeSession: "active",
        });
        mgr.restoreSessions();
        expect(mgr.isLazyPlaceholder("lazy")).toBe(true);

        mgr.lazyResume("lazy", -1);
        expect(mgr.isLazyPlaceholder("lazy")).toBe(false);
    });
});

// ─── findPtyByClaudeId ──────────────────────────────────────────────

describe("findPtyByClaudeId", () => {
    it("returns null for lazy sessions (no PTY)", () => {
        const { mgr } = setup({ savedSessions: ["lazy-only"] });
        // "lazy-only" is in _allOpenClaudeIds but NOT in _ptyToClaudeId
        expect(mgr.findPtyByClaudeId("lazy-only")).toBeNull();
    });

    it("returns pty ID for sessions with real PTY", () => {
        const { mgr } = setup();
        mgr.startNewClaudeSession("with-pty", false);
        expect(mgr.findPtyByClaudeId("with-pty")).toBe(1);
    });

    it("returns null after removeOpenSessionByClaudeId", () => {
        const { mgr } = setup();
        mgr.startNewClaudeSession("sess", false);
        mgr.removeOpenSessionByClaudeId("sess");
        expect(mgr.findPtyByClaudeId("sess")).toBeNull();
    });
});

// ─── full lifecycle scenarios ────────────────────────────────────────

describe("full lifecycle", () => {
    it("resume from sessions list → restore skips → no duplicate", () => {
        // Simulates: user on sessions list, clicks resume, which triggers
        // startNewClaudeSession + view switch → request-restore-sessions
        const { mgr, pty } = setup({
            savedSessions: ["sess-a", "sess-b"],
            activeSession: "sess-a",
        });

        // Step 1: user clicks resume on sess-a from sessions list
        mgr.startNewClaudeSession("sess-a", false);
        expect(pty.createSession).toHaveBeenCalledTimes(1);

        // Step 2: view switches to terminals → restore fires
        mgr.restoreSessions();

        // sess-a already has PTY → skipped, sess-b → lazy placeholder
        expect(pty.createSession).toHaveBeenCalledTimes(1); // no duplicate
        const lazyMsgs = findMessages("terminal-session-created").filter(
            (m) => (m as Record<string, unknown>).lazy === true,
        );
        expect(lazyMsgs).toHaveLength(1);
        expect((lazyMsgs[0] as Record<string, unknown>).claudeId).toBe("sess-b");
    });

    it("lazy resume then close removes from persistence", () => {
        const { mgr, memento } = setup({ savedSessions: ["a", "b"] });

        // Lazy resume "b"
        mgr.lazyResume("b", -1);
        const ptyId = 1; // first PTY created

        // Close "b" by claude ID
        mgr.removeOpenSessionByClaudeId("b");

        messages = [];
        mgr.sendOpenSessionIds();
        const msg = findMessages("open-sessions-update")[0] as { openClaudeIds: string[] };
        expect(msg.openClaudeIds).toEqual(["a"]);

        // Verify persistence
        const persistCalls = memento.update.mock.calls.filter(
            (c: unknown[]) => c[0] === "ccr.openSessions",
        );
        const lastPersist = persistCalls[persistCalls.length - 1][1] as string[];
        expect(lastPersist).toEqual(["a"]);
    });

    it("multiple reload cycles preserve lazy sessions", () => {
        // Cycle 1: open 3 sessions, only active gets PTY
        const memento1 = makeMemento({
            "ccr.openSessions": ["x", "y", "z"],
            "ccr.activeSession": "x",
        });
        const pty1 = makePtyManager();
        ptyIdCounter = 0;
        const msgs1: ExtensionToWebviewMessage[] = [];
        const mgr1 = new SessionManager("/ws", pty1, memento1 as never, (m) => msgs1.push(m));
        mgr1.restoreSessions();

        // Verify persistence saved all 3
        const saved1 = memento1.update.mock.calls
            .filter((c: unknown[]) => c[0] === "ccr.openSessions")
            .pop()![1] as string[];
        expect(saved1.sort()).toEqual(["x", "y", "z"]);

        // Cycle 2: reload — should still have all 3
        const memento2 = makeMemento({
            "ccr.openSessions": saved1,
            "ccr.activeSession": "x",
        });
        const pty2 = makePtyManager();
        ptyIdCounter = 0;
        const msgs2: ExtensionToWebviewMessage[] = [];
        const mgr2 = new SessionManager("/ws", pty2, memento2 as never, (m) => msgs2.push(m));
        mgr2.restoreSessions();

        const saved2 = memento2.update.mock.calls
            .filter((c: unknown[]) => c[0] === "ccr.openSessions")
            .pop()![1] as string[];
        expect(saved2.sort()).toEqual(["x", "y", "z"]);
    });

    it("removing lazy session without PTY works correctly", () => {
        const { mgr } = setup({ savedSessions: ["real", "lazy"] });
        mgr.startNewClaudeSession("real", true);

        // "lazy" has no PTY — removeOpenSession with sentinel -1 should not crash
        // but removeOpenSessionByClaudeId is the proper way
        mgr.removeOpenSessionByClaudeId("lazy");

        messages = [];
        mgr.sendOpenSessionIds();
        const msg = findMessages("open-sessions-update")[0] as { openClaudeIds: string[] };
        expect(msg.openClaudeIds).toEqual(["real"]);
    });
});

// ─── _persistOpenSessions (via public methods) ──────────────────────

describe("persistence", () => {
    it("persists all open IDs including lazy ones", () => {
        const { mgr, memento } = setup({ savedSessions: ["a", "b", "c"] });
        // Only start PTY for "a"
        mgr.startNewClaudeSession("a", true);

        const persistCalls = memento.update.mock.calls.filter(
            (c: unknown[]) => c[0] === "ccr.openSessions",
        );
        const lastPersist = persistCalls[persistCalls.length - 1];
        const ids = lastPersist[1] as string[];
        expect(ids).toContain("a");
        expect(ids).toContain("b");
        expect(ids).toContain("c");
    });
});
