import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn(), logCat: vi.fn() }));
vi.mock("../file-logger", () => ({ fileLog: { log: vi.fn() } }));

const mockExecSync = vi.fn();
vi.mock("child_process", () => ({ execSync: (...args: unknown[]) => mockExecSync(...args) }));

const mockExistsSync = vi.fn();
const mockStatSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
vi.mock("fs", async () => {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    return {
        ...actual,
        existsSync: (...args: unknown[]) => mockExistsSync(...args),
        statSync: (...args: unknown[]) => mockStatSync(...args),
        readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
        writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
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
    readClaudeSettings: vi
        .fn()
        .mockReturnValue({ effective: {}, global: {}, project: {}, runtime: {} }),
    readClaudeSettingsScoped: vi.fn().mockReturnValue({}),
    writeClaudeSetting: vi.fn(),
    writeClaudeRuntimeState: vi.fn(),
    trustProject: vi.fn(),
}));

import { resolveClipboard, handleWebviewMessage, ImageTracker } from "../main-view/message-handler";
import type { MessageContext } from "../main-view/message-handler";
import { env as mockVscodeEnv, commands as mockVscodeCommands } from "./mocks/vscode";

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
        imageTracker: new ImageTracker(),
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReset();
    mockExistsSync.mockReset();
    mockStatSync.mockReset();
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    (mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>)
        .mockReset()
        .mockResolvedValue("");
    setPlatform("darwin");
});

afterEach(() => {
    setPlatform(originalPlatform);
});

// ─── ImageTracker unit tests ────────────────────────────────────────

describe("ImageTracker", () => {
    it("enqueue and shiftPending work as FIFO per session", () => {
        const t = new ImageTracker();
        t.enqueue(1, "/a.png", "b64a", "image/png");
        t.enqueue(1, "/b.jpg", "b64b", "image/jpeg");

        const first = t.shiftPending(1);
        expect(first).toEqual({ filePath: "/a.png", base64: "b64a", mimeType: "image/png" });

        const second = t.shiftPending(1);
        expect(second).toEqual({ filePath: "/b.jpg", base64: "b64b", mimeType: "image/jpeg" });

        expect(t.shiftPending(1)).toBeUndefined();
    });

    it("per-session isolation — different ptyIds don't mix", () => {
        const t = new ImageTracker();
        t.enqueue(1, "/session1.png", "b64-1", "image/png");
        t.enqueue(2, "/session2.jpg", "b64-2", "image/jpeg");

        // Session 2 should only get its own pending
        const s2 = t.shiftPending(2);
        expect(s2?.filePath).toBe("/session2.jpg");
        expect(t.shiftPending(2)).toBeUndefined();

        // Session 1 still has its pending
        const s1 = t.shiftPending(1);
        expect(s1?.filePath).toBe("/session1.png");
    });

    it("bind and getImagePath store CLI index → filePath", () => {
        const t = new ImageTracker();
        t.bind(5, "/img5.png");
        t.bind(12, "/img12.jpg");

        expect(t.getImagePath(5)).toBe("/img5.png");
        expect(t.getImagePath(12)).toBe("/img12.jpg");
        expect(t.getImagePath(99)).toBeUndefined();
    });

    it("clear resets all state", () => {
        const t = new ImageTracker();
        t.enqueue(1, "/a.png", "b64", "image/png");
        t.bind(1, "/a.png");

        t.clear();

        expect(t.shiftPending(1)).toBeUndefined();
        expect(t.getImagePath(1)).toBeUndefined();
    });

    it("shiftPending returns undefined for unknown ptyId", () => {
        const t = new ImageTracker();
        expect(t.shiftPending(999)).toBeUndefined();
    });

    it("clearSession removes pending queue for specific ptyId", () => {
        const t = new ImageTracker();
        t.enqueue(1, "/a.png", "b64a", "image/png");
        t.enqueue(2, "/b.png", "b64b", "image/png");

        t.clearSession(1);

        expect(t.shiftPending(1)).toBeUndefined();
        // Session 2 unaffected
        expect(t.shiftPending(2)?.filePath).toBe("/b.png");
    });

    it("evicts oldest bound entry when exceeding MAX_BOUND (200)", () => {
        const t = new ImageTracker();
        // Fill up to MAX_BOUND
        for (let i = 0; i < 200; i++) {
            t.bind(i, `/img${i}.png`);
        }
        expect(t.getImagePath(0)).toBe("/img0.png");

        // Adding one more should evict the oldest (index 0)
        t.bind(200, "/img200.png");
        expect(t.getImagePath(0)).toBeUndefined();
        expect(t.getImagePath(200)).toBe("/img200.png");
        expect(t.getImagePath(1)).toBe("/img1.png");
    });
});

// ─── resolveClipboard ───────────────────────────────────────────────

describe("resolveClipboard", () => {
    describe("macOS (darwin)", () => {
        it("returns file path from osascript «class furl» when file is copied in Finder", async () => {
            mockExecSync.mockReturnValueOnce("/Users/test/Documents/file.pdf\n");
            mockExistsSync.mockReturnValueOnce(true);
            const result = await resolveClipboard();
            expect(result).toEqual({ type: "text", text: "/Users/test/Documents/file.pdf" });
            expect(mockExecSync).toHaveBeenCalledWith(
                expect.stringContaining("class furl"),
                expect.objectContaining({ encoding: "utf8", timeout: 2000 }),
            );
        });

        it("falls back to clipboard text when no furl in clipboard", async () => {
            mockExecSync.mockReturnValueOnce("");
            (mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
                "hello world",
            );
            const result = await resolveClipboard();
            expect(result).toEqual({ type: "text", text: "hello world" });
        });

        it("falls back to clipboard text when osascript throws", async () => {
            mockExecSync.mockImplementationOnce(() => {
                throw new Error("osascript error");
            });
            (mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
                "pasted text",
            );
            const result = await resolveClipboard();
            expect(result).toEqual({ type: "text", text: "pasted text" });
        });

        it("saves screenshot as PNG when clipboard has image but no text", async () => {
            mockExecSync.mockImplementationOnce(() => {
                throw new Error("no furl");
            });
            (mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
                "",
            );
            mockExecSync.mockReturnValueOnce("ok");
            mockExistsSync.mockReturnValueOnce(true);
            mockStatSync.mockReturnValueOnce({ size: 12345 });

            const result = await resolveClipboard();
            expect(result).not.toBeNull();
            expect(result!.type).toBe("image");
            expect((result as { type: "image"; tmpPath: string }).tmpPath).toMatch(
                /ccr-paste-\d+\.png/,
            );
        });

        it("returns null when clipboard is completely empty", async () => {
            mockExecSync.mockImplementationOnce(() => {
                throw new Error("no furl");
            });
            (mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
                "",
            );
            mockExecSync.mockImplementationOnce(() => {
                throw new Error("no image");
            });

            const result = await resolveClipboard();
            expect(result).toBeNull();
        });

        it("returns null when screenshot file is empty (0 bytes)", async () => {
            mockExecSync.mockImplementationOnce(() => {
                throw new Error("no furl");
            });
            (mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
                "",
            );
            mockExecSync.mockReturnValueOnce("ok");
            mockExistsSync.mockReturnValueOnce(true);
            mockStatSync.mockReturnValueOnce({ size: 0 });

            const result = await resolveClipboard();
            expect(result).toBeNull();
        });

        it("prefers furl path over clipboard text (file copied in Finder)", async () => {
            mockExecSync.mockReturnValueOnce("/Users/test/file.apk\n");
            mockExistsSync.mockReturnValueOnce(true);
            (mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
                "file.apk",
            );

            const result = await resolveClipboard();
            expect(result).toEqual({ type: "text", text: "/Users/test/file.apk" });
            expect(mockVscodeEnv.clipboard.readText).not.toHaveBeenCalled();
        });

        // ─── furl validation (rich text / formatted clipboard) ───

        it("rejects furl that does not start with /", async () => {
            mockExecSync.mockReturnValueOnce("alias:some:resource\n");
            (mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
                "fallback text",
            );

            const result = await resolveClipboard();
            expect(result).toEqual({ type: "text", text: "fallback text" });
        });

        it("rejects furl with newlines (multiline rich text)", async () => {
            mockExecSync.mockReturnValueOnce("/line1\n/line2\n");
            (mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
                "plain",
            );

            const result = await resolveClipboard();
            expect(result).toEqual({ type: "text", text: "plain" });
        });

        it("rejects furl when file does not exist on disk", async () => {
            mockExecSync.mockReturnValueOnce("/Users/test/nonexistent.pdf\n");
            mockExistsSync.mockReturnValueOnce(false); // file does not exist

            (mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
                "clipboard text",
            );
            const result = await resolveClipboard();
            expect(result).toEqual({ type: "text", text: "clipboard text" });
        });
    });

    describe("non-macOS", () => {
        beforeEach(() => setPlatform("linux"));

        it("reads text from vscode clipboard API", async () => {
            (mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
                "linux text",
            );
            const result = await resolveClipboard();
            expect(result).toEqual({ type: "text", text: "linux text" });
            expect(mockExecSync).not.toHaveBeenCalled();
        });

        it("returns null for empty clipboard", async () => {
            (mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
                "",
            );
            const result = await resolveClipboard();
            expect(result).toBeNull();
        });
    });
});

// ─── read-clipboard message handler ─────────────────────────────────

describe("read-clipboard handler", () => {
    it("writes bracket-pasted text to PTY session", async () => {
        mockExecSync.mockImplementationOnce(() => {
            throw new Error("no furl");
        });
        (mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
            "some text",
        );

        const ctx = createMockContext();
        handleWebviewMessage({ type: "read-clipboard", sessionId: 5 }, ctx);

        await new Promise((r) => setTimeout(r, 20));

        expect(ctx.ptyManager.writeToSession).toHaveBeenCalledWith(
            5,
            "\x1b[200~some text\x1b[201~",
        );
    });

    it("writes full file path when furl is available", async () => {
        mockExecSync.mockReturnValueOnce("/Users/test/doc.pdf\n");
        mockExistsSync.mockReturnValueOnce(true);

        const ctx = createMockContext();
        handleWebviewMessage({ type: "read-clipboard", sessionId: 3 }, ctx);

        await new Promise((r) => setTimeout(r, 20));

        expect(ctx.ptyManager.writeToSession).toHaveBeenCalledWith(
            3,
            "\x1b[200~/Users/test/doc.pdf\x1b[201~",
        );
    });

    it("writes screenshot tmp path when clipboard has image only", async () => {
        mockExecSync.mockImplementationOnce(() => {
            throw new Error("no furl");
        });
        (mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce("");
        mockExecSync.mockReturnValueOnce("ok");
        mockExistsSync.mockReturnValueOnce(true);
        mockStatSync.mockReturnValueOnce({ size: 5000 });

        const ctx = createMockContext();
        handleWebviewMessage({ type: "read-clipboard", sessionId: 7 }, ctx);

        await new Promise((r) => setTimeout(r, 20));

        expect(ctx.ptyManager.writeToSession).toHaveBeenCalledWith(
            7,
            expect.stringMatching(/\x1b\[200~.*ccr-paste-\d+\.png\x1b\[201~/),
        );
    });

    it("does not write to PTY when clipboard is empty", async () => {
        mockExecSync.mockImplementationOnce(() => {
            throw new Error("no furl");
        });
        (mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce("");
        mockExecSync.mockImplementationOnce(() => {
            throw new Error("no image");
        });

        const ctx = createMockContext();
        handleWebviewMessage({ type: "read-clipboard", sessionId: 1 }, ctx);

        await new Promise((r) => setTimeout(r, 20));

        expect(ctx.ptyManager.writeToSession).not.toHaveBeenCalled();
    });

    it("enqueues image and sends image-pending when pasting an image file path", async () => {
        mockExecSync.mockReturnValueOnce("/Users/test/photo.png\n");
        mockExistsSync.mockReturnValueOnce(true); // furl validation
        mockExistsSync.mockReturnValueOnce(true); // image file exists check
        mockReadFileSync.mockReturnValueOnce(Buffer.from("fake-png-data"));

        const ctx = createMockContext();
        handleWebviewMessage({ type: "read-clipboard", sessionId: 4 }, ctx);

        await new Promise((r) => setTimeout(r, 20));

        // Should write bracket-pasted path to PTY
        expect(ctx.ptyManager.writeToSession).toHaveBeenCalledWith(
            4,
            "\x1b[200~/Users/test/photo.png\x1b[201~",
        );
        // Should send image-pending with ptyId
        expect(ctx.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "image-pending",
                mimeType: "image/png",
                filePath: "/Users/test/photo.png",
                ptyId: 4,
            }),
        );
        // Should enqueue in tracker
        const pending = ctx.imageTracker.shiftPending(4);
        expect(pending).toBeDefined();
        expect(pending!.filePath).toBe("/Users/test/photo.png");
    });

    it("enqueues image for .jpg file path", async () => {
        mockExecSync.mockReturnValueOnce("/Users/test/photo.jpg\n");
        mockExistsSync.mockReturnValueOnce(true); // furl validation
        mockExistsSync.mockReturnValueOnce(true); // image file exists check
        mockReadFileSync.mockReturnValueOnce(Buffer.from("fake-jpg-data"));

        const ctx = createMockContext();
        handleWebviewMessage({ type: "read-clipboard", sessionId: 2 }, ctx);

        await new Promise((r) => setTimeout(r, 20));

        expect(ctx.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "image-pending",
                mimeType: "image/jpeg",
                ptyId: 2,
            }),
        );
    });

    it("does NOT enqueue image for non-image file paths (e.g. .pdf)", async () => {
        mockExecSync.mockReturnValueOnce("/Users/test/doc.pdf\n");
        mockExistsSync.mockReturnValueOnce(true); // furl validation

        const ctx = createMockContext();
        handleWebviewMessage({ type: "read-clipboard", sessionId: 3 }, ctx);

        await new Promise((r) => setTimeout(r, 20));

        // Should write path but NOT send image-pending
        expect(ctx.ptyManager.writeToSession).toHaveBeenCalled();
        expect(ctx.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "image-pending" }),
        );
        expect(ctx.imageTracker.shiftPending(3)).toBeUndefined();
    });

    it("does NOT enqueue when image file does not exist on disk", async () => {
        mockExecSync.mockReturnValueOnce("/Users/test/photo.png\n");
        mockExistsSync.mockReturnValueOnce(true); // furl validation
        mockExistsSync.mockReturnValueOnce(false); // image file does NOT exist

        const ctx = createMockContext();
        handleWebviewMessage({ type: "read-clipboard", sessionId: 5 }, ctx);

        await new Promise((r) => setTimeout(r, 20));

        expect(ctx.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "image-pending" }),
        );
    });

    it("enqueues screenshot image and sends image-pending", async () => {
        mockExecSync.mockImplementationOnce(() => {
            throw new Error("no furl");
        });
        (mockVscodeEnv.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValueOnce("");
        mockExecSync.mockReturnValueOnce("ok");
        mockExistsSync.mockReturnValueOnce(true);
        mockStatSync.mockReturnValueOnce({ size: 5000 });
        mockReadFileSync.mockReturnValueOnce(Buffer.from("screenshot-data"));

        const ctx = createMockContext();
        handleWebviewMessage({ type: "read-clipboard", sessionId: 8 }, ctx);

        await new Promise((r) => setTimeout(r, 20));

        expect(ctx.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "image-pending",
                mimeType: "image/png",
                ptyId: 8,
            }),
        );
        expect(ctx.imageTracker.shiftPending(8)).toBeDefined();
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
        const base64 =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==";

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

        const writtenPath = (ctx.ptyManager.writeToSession as ReturnType<typeof vi.fn>).mock
            .calls[0][1] as string;
        expect(writtenPath).toMatch(/\.jpg$/);
    });

    it("enqueues image in tracker with ptyId and sends image-pending", () => {
        const ctx = createMockContext();
        handleWebviewMessage(
            { type: "paste-image", sessionId: 3, data: "b64png", mimeType: "image/png" },
            ctx,
        );

        // Should enqueue in session 3
        const pending = ctx.imageTracker.shiftPending(3);
        expect(pending).toBeDefined();
        expect(pending!.mimeType).toBe("image/png");
        expect(pending!.base64).toBe("b64png");
        expect(pending!.filePath).toMatch(/ccr-paste-.*\.png$/);

        // Should send image-pending
        expect(ctx.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "image-pending",
                base64: "b64png",
                mimeType: "image/png",
                ptyId: 3,
            }),
        );
    });

    it("does not enqueue in other sessions", () => {
        const ctx = createMockContext();
        handleWebviewMessage(
            { type: "paste-image", sessionId: 5, data: "b64", mimeType: "image/png" },
            ctx,
        );

        // Session 5 has pending
        expect(ctx.imageTracker.shiftPending(5)).toBeDefined();
        // Session 1 does not
        expect(ctx.imageTracker.shiftPending(1)).toBeUndefined();
    });
});

// ─── bind-image handler ─────────────────────────────────────────────

describe("bind-image handler", () => {
    it("binds CLI index to pending image from correct session", () => {
        const ctx = createMockContext();
        // Pre-fill pending queue for session 7
        ctx.imageTracker.enqueue(7, "/path/to/photo.png", "b64data", "image/png");

        handleWebviewMessage({ type: "bind-image", cliIndex: 3, ptyId: 7 }, ctx);

        expect(ctx.imageTracker.getImagePath(3)).toBe("/path/to/photo.png");
    });

    it("binds multiple images in FIFO order per session", () => {
        const ctx = createMockContext();
        ctx.imageTracker.enqueue(1, "/first.png", "b64-1", "image/png");
        ctx.imageTracker.enqueue(1, "/second.jpg", "b64-2", "image/jpeg");

        handleWebviewMessage({ type: "bind-image", cliIndex: 1, ptyId: 1 }, ctx);
        handleWebviewMessage({ type: "bind-image", cliIndex: 2, ptyId: 1 }, ctx);

        expect(ctx.imageTracker.getImagePath(1)).toBe("/first.png");
        expect(ctx.imageTracker.getImagePath(2)).toBe("/second.jpg");
    });

    it("does not crash when no pending image exists", () => {
        const ctx = createMockContext();
        // No enqueue — should handle gracefully
        handleWebviewMessage({ type: "bind-image", cliIndex: 99, ptyId: 1 }, ctx);

        expect(ctx.imageTracker.getImagePath(99)).toBeUndefined();
    });

    it("per-session isolation: does not steal from other session queues", () => {
        const ctx = createMockContext();
        ctx.imageTracker.enqueue(1, "/session1.png", "b64-s1", "image/png");
        ctx.imageTracker.enqueue(2, "/session2.jpg", "b64-s2", "image/jpeg");

        // Bind for session 2 — should get session2.jpg, NOT session1.png
        handleWebviewMessage({ type: "bind-image", cliIndex: 1, ptyId: 2 }, ctx);
        expect(ctx.imageTracker.getImagePath(1)).toBe("/session2.jpg");

        // Session 1 still has its pending
        handleWebviewMessage({ type: "bind-image", cliIndex: 5, ptyId: 1 }, ctx);
        expect(ctx.imageTracker.getImagePath(5)).toBe("/session1.png");
    });
});

// ─── open-image handler ─────────────────────────────────────────────

describe("open-image handler", () => {
    it("opens bound image with vscode.open command", () => {
        const ctx = createMockContext();
        ctx.imageTracker.enqueue(1, "/Users/test/photo.png", "b64", "image/png");
        // Simulate bind
        handleWebviewMessage({ type: "bind-image", cliIndex: 7, ptyId: 1 }, ctx);

        handleWebviewMessage({ type: "open-image", index: 7 }, ctx);

        expect(mockVscodeCommands.executeCommand).toHaveBeenCalledWith(
            "vscode.open",
            expect.objectContaining({ fsPath: "/Users/test/photo.png" }),
        );
    });

    it("does nothing for unknown image index", () => {
        const ctx = createMockContext();

        handleWebviewMessage({ type: "open-image", index: 999 }, ctx);

        expect(mockVscodeCommands.executeCommand).not.toHaveBeenCalled();
    });
});
