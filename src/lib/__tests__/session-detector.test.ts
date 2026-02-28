import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn(), logCat: vi.fn() }));

const mockReaddirSync = vi.fn().mockReturnValue([]);
const mockStatSync = vi.fn().mockReturnValue({ mtimeMs: Date.now() });
const mockExistsSync = vi.fn().mockReturnValue(false);
const mockWatch = vi.fn().mockReturnValue({ close: vi.fn() });

vi.mock("fs", () => ({
    readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
    statSync: (...args: unknown[]) => mockStatSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    watch: (...args: unknown[]) => mockWatch(...args),
}));

vi.mock("../sessions", () => ({
    getSessionsDir: vi.fn(() => "/wp/.claude/projects/hash/sessions"),
}));

import { detectNewSessionId, DetectSessionCallbacks } from "../main-view/session-detector";

beforeEach(() => {
    vi.useFakeTimers();
    mockReaddirSync.mockReturnValue([]);
    mockExistsSync.mockReturnValue(false);
});

afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe("detectNewSessionId", () => {
    it("returns a disposable", () => {
        const callbacks: DetectSessionCallbacks = {
            onDetected: vi.fn(),
            isAlreadyBound: vi.fn().mockReturnValue(false),
        };
        const result = detectNewSessionId("/wp", 1, callbacks);
        expect(result).toHaveProperty("dispose");
        result.dispose();
    });

    it("detects new .jsonl file via polling", () => {
        const onDetected = vi.fn();
        const callbacks: DetectSessionCallbacks = {
            onDetected,
            isAlreadyBound: vi.fn().mockReturnValue(false),
        };

        // Initially no files
        mockReaddirSync.mockReturnValueOnce([]);

        const result = detectNewSessionId("/wp", 1, callbacks);

        // After 2s, a new file appears
        mockReaddirSync.mockReturnValue(["abc123.jsonl"]);
        mockStatSync.mockReturnValue({ mtimeMs: Date.now() + 1000 });

        vi.advanceTimersByTime(2100);

        expect(onDetected).toHaveBeenCalledWith(1, "abc123");
        result.dispose();
    });

    it("skips files that existed before detection started", () => {
        const onDetected = vi.fn();
        const callbacks: DetectSessionCallbacks = {
            onDetected,
            isAlreadyBound: vi.fn().mockReturnValue(false),
        };

        // File already exists when detection starts
        mockReaddirSync.mockReturnValue(["existing.jsonl"]);

        const result = detectNewSessionId("/wp", 1, callbacks);

        // Same file still there after polling
        vi.advanceTimersByTime(2100);

        expect(onDetected).not.toHaveBeenCalled();
        result.dispose();
    });

    it("stops early when isAlreadyBound returns true", () => {
        const onDetected = vi.fn();
        const callbacks: DetectSessionCallbacks = {
            onDetected,
            isAlreadyBound: vi.fn().mockReturnValue(true),
        };

        const result = detectNewSessionId("/wp", 1, callbacks);

        vi.advanceTimersByTime(2100);

        expect(onDetected).not.toHaveBeenCalled();
        result.dispose();
    });

    it("times out after 60 seconds (30 attempts)", () => {
        const onDetected = vi.fn();
        const callbacks: DetectSessionCallbacks = {
            onDetected,
            isAlreadyBound: vi.fn().mockReturnValue(false),
        };

        mockReaddirSync.mockReturnValue([]);

        const result = detectNewSessionId("/wp", 1, callbacks);

        // Advance past 30 attempts (30 * 2000ms = 60s)
        vi.advanceTimersByTime(61000);

        expect(onDetected).not.toHaveBeenCalled();
        result.dispose();
    });

    it("dispose cancels detection", () => {
        const onDetected = vi.fn();
        const callbacks: DetectSessionCallbacks = {
            onDetected,
            isAlreadyBound: vi.fn().mockReturnValue(false),
        };

        const result = detectNewSessionId("/wp", 1, callbacks);
        result.dispose();

        // New file appears after disposal
        mockReaddirSync.mockReturnValue(["new.jsonl"]);
        mockStatSync.mockReturnValue({ mtimeMs: Date.now() + 1000 });

        vi.advanceTimersByTime(5000);

        expect(onDetected).not.toHaveBeenCalled();
    });
});
