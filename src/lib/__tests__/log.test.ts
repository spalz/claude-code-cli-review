import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAppendLine = vi.fn();
vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn(() => ({
			appendLine: mockAppendLine,
			show: vi.fn(),
		})),
	},
}));

import { init, log, logCat, logTimed } from "../log";

beforeEach(() => {
	mockAppendLine.mockClear();
	init();
});

describe("log", () => {
	it("formats message with timestamp", () => {
		log("hello", "world");
		expect(mockAppendLine).toHaveBeenCalledTimes(1);
		const line = mockAppendLine.mock.calls[0][0] as string;
		expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] hello world$/);
	});

	it("serializes objects", () => {
		log({ key: "val" });
		const line = mockAppendLine.mock.calls[0][0] as string;
		expect(line).toContain('{"key":"val"}');
	});
});

describe("logCat", () => {
	it("includes category in brackets", () => {
		logCat("server", "request received");
		const line = mockAppendLine.mock.calls[0][0] as string;
		expect(line).toMatch(/\[server\] request received/);
	});

	it("formats with timestamp and category", () => {
		logCat("decoration", "mismatch detected");
		const line = mockAppendLine.mock.calls[0][0] as string;
		expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[decoration\] mismatch detected$/);
	});

	it("serializes object arguments", () => {
		logCat("navigation", "index", { idx: 5 });
		const line = mockAppendLine.mock.calls[0][0] as string;
		expect(line).toContain("[navigation]");
		expect(line).toContain('{"idx":5}');
	});
});

describe("logTimed", () => {
	it("returns the value from the wrapped function", async () => {
		const result = await logTimed("test-op", async () => 42);
		expect(result).toBe(42);
	});

	it("logs timing information", async () => {
		await logTimed("slow-op", async () => {
			await new Promise((r) => setTimeout(r, 10));
			return "done";
		});
		const line = mockAppendLine.mock.calls[0][0] as string;
		expect(line).toContain("slow-op:");
		expect(line).toMatch(/\d+\.\d+ms/);
	});

	it("logs timing even when function throws", async () => {
		await expect(
			logTimed("fail-op", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		const line = mockAppendLine.mock.calls[0][0] as string;
		expect(line).toContain("fail-op:");
	});
});
