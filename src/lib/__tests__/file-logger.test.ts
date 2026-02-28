import { describe, it, expect, vi, beforeEach } from "vitest";

const mockMkdirSync = vi.fn();
const mockStatSync = vi.fn();
const mockRenameSync = vi.fn();
const mockWriteStream = { write: vi.fn(), end: vi.fn() };
const mockCreateWriteStream = vi.fn().mockReturnValue(mockWriteStream);

vi.mock("fs", () => ({
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    statSync: (...args: unknown[]) => mockStatSync(...args),
    renameSync: (...args: unknown[]) => mockRenameSync(...args),
    createWriteStream: (...args: unknown[]) => mockCreateWriteStream(...args),
}));

vi.mock("path", async () => {
    const actual = await vi.importActual<typeof import("path")>("path");
    return actual;
});

import { fileLog } from "../file-logger";

beforeEach(() => {
    vi.clearAllMocks();
    // Reset internal state by re-initializing
    fileLog.dispose();
});

describe("FileLogger", () => {
    it("creates log directory on init", () => {
        fileLog.init("/workspace");
        expect(mockMkdirSync).toHaveBeenCalledWith(expect.stringContaining(".claude/logs"), {
            recursive: true,
        });
    });

    it("writes timestamped log lines", () => {
        fileLog.init("/workspace");
        fileLog.log("test", "hello world");
        expect(mockCreateWriteStream).toHaveBeenCalledWith(expect.stringContaining("test.log"), {
            flags: "a",
        });
        expect(mockWriteStream.write).toHaveBeenCalledWith(
            expect.stringMatching(/^\[\d{4}-\d{2}-\d{2}T.*\] hello world\n$/),
        );
    });

    it("includes data as JSON when provided", () => {
        fileLog.init("/workspace");
        fileLog.log("test", "with data", { key: "value" });
        expect(mockWriteStream.write).toHaveBeenCalledWith(
            expect.stringContaining('{"key":"value"}'),
        );
    });

    it("rotates file when exceeding 1MB", () => {
        // File exists and is over 1MB
        mockStatSync.mockReturnValue({ size: 2 * 1024 * 1024 });

        fileLog.init("/workspace");
        fileLog.log("big", "message");

        expect(mockRenameSync).toHaveBeenCalledWith(
            expect.stringContaining("big.log"),
            expect.stringContaining("big.bak"),
        );
    });

    it("does not rotate when file is under 1MB", () => {
        mockStatSync.mockReturnValue({ size: 500 * 1024 });

        fileLog.init("/workspace");
        fileLog.log("small", "message");

        expect(mockRenameSync).not.toHaveBeenCalled();
    });

    it("handles missing file gracefully during rotation check", () => {
        mockStatSync.mockImplementation(() => {
            throw new Error("ENOENT");
        });

        fileLog.init("/workspace");
        // Should not throw
        expect(() => fileLog.log("new", "first message")).not.toThrow();
    });

    it("dispose closes all open streams", () => {
        fileLog.init("/workspace");
        fileLog.log("cat1", "msg");
        fileLog.log("cat2", "msg");
        mockWriteStream.end.mockClear();
        fileLog.dispose();
        expect(mockWriteStream.end).toHaveBeenCalledTimes(2);
    });
});
