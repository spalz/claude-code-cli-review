import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let requestHandler: (req: any, res: any) => void;

vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn() }));
vi.mock("child_process", () => ({ execSync: vi.fn(() => "") }));
vi.mock("fs", () => ({ readFileSync: vi.fn(() => "file-content") }));
vi.mock("http", () => ({
	createServer: vi.fn((handler: unknown) => {
		requestHandler = handler as typeof requestHandler;
		return {
			listen: vi.fn((_port: number, _host: string, cb?: () => void) => cb?.()),
			close: vi.fn(),
			on: vi.fn(),
		};
	}),
}));
vi.mock("../state", () => ({
	activeReviews: new Map(),
	getReviewFiles: vi.fn(() => []),
}));
vi.mock("../bash-file-parser", () => ({
	parseBashCommand: vi.fn(() => ({ modified: [], deleted: [], created: [] })),
}));

import {
	getSnapshot,
	clearSnapshot,
	setAddFileHandler,
	setWorkspacePath,
	startServer,
} from "../server";
import * as state from "../state";
import { parseBashCommand } from "../bash-file-parser";
import * as fs from "fs";

function createMockReq(method: string, url: string, body?: string) {
	const req = new EventEmitter() as EventEmitter & { method: string; url: string };
	req.method = method;
	req.url = url;
	if (body !== undefined) {
		setTimeout(() => {
			req.emit("data", Buffer.from(body));
			req.emit("end");
		}, 0);
	} else {
		setTimeout(() => req.emit("end"), 0);
	}
	return req;
}

function createMockRes() {
	return {
		setHeader: vi.fn(),
		writeHead: vi.fn(),
		end: vi.fn(),
	};
}

async function sendRequest(method: string, url: string, body?: unknown) {
	const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
	const req = createMockReq(method, url, bodyStr);
	const res = createMockRes();
	requestHandler(req, res);
	await new Promise((r) => setTimeout(r, 10));
	return res;
}

beforeEach(() => {
	startServer();
});

describe("GET /status", () => {
	it("returns 200 with status JSON when no active reviews", async () => {
		const res = await sendRequest("GET", "/status");
		expect(res.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
		const body = JSON.parse(res.end.mock.calls[0][0]);
		expect(body.ok).toBe(true);
		expect(body.reviewActive).toBe(false);
		expect(body.filesRemaining).toBe(0);
	});

	it("returns reviewActive true when reviews exist", async () => {
		(state.activeReviews as Map<string, unknown>).set("/a.ts", {});
		(state.getReviewFiles as ReturnType<typeof vi.fn>).mockReturnValue(["/a.ts"]);
		const res = await sendRequest("GET", "/status");
		const body = JSON.parse(res.end.mock.calls[0][0]);
		expect(body.reviewActive).toBe(true);
		expect(body.filesRemaining).toBe(1);
		(state.activeReviews as Map<string, unknown>).clear();
	});
});

describe("POST /snapshot", () => {
	it("stores snapshot with file and base64 content", async () => {
		const content = Buffer.from("hello world").toString("base64");
		await sendRequest("POST", "/snapshot", { file: "/test.ts", content });
		expect(getSnapshot("/test.ts")).toBe("hello world");
	});

	it("stores empty string when content is missing", async () => {
		await sendRequest("POST", "/snapshot", { file: "/empty.ts" });
		expect(getSnapshot("/empty.ts")).toBe("");
	});

	it("handles Bash tool via parseBashCommand", async () => {
		(parseBashCommand as ReturnType<typeof vi.fn>).mockReturnValueOnce({
			modified: ["/mod.ts"],
			deleted: [],
			created: [],
		});
		(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce("mod-content");
		await sendRequest("POST", "/snapshot", { tool: "Bash", command: "sed -i s/a/b/ mod.ts" });
		expect(parseBashCommand).toHaveBeenCalled();
		expect(getSnapshot("/mod.ts")).toBe("mod-content");
	});

	it("skips files that do not exist (Bash ENOENT)", async () => {
		(parseBashCommand as ReturnType<typeof vi.fn>).mockReturnValueOnce({
			modified: ["/missing.ts"],
			deleted: [],
			created: [],
		});
		(fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
			throw new Error("ENOENT");
		});
		await sendRequest("POST", "/snapshot", { tool: "Bash", command: "rm missing.ts" });
		expect(getSnapshot("/missing.ts")).toBeUndefined();
	});

	it("returns ok on malformed JSON", async () => {
		const req = createMockReq("POST", "/snapshot", "not-json");
		const res = createMockRes();
		requestHandler(req, res);
		await new Promise((r) => setTimeout(r, 10));
		const body = JSON.parse(res.end.mock.calls[0][0]);
		expect(body.ok).toBe(true);
	});
});

describe("POST /changed", () => {
	it("calls addFileToReview handler with file path", async () => {
		const handler = vi.fn();
		setAddFileHandler(handler);
		await sendRequest("POST", "/changed", { file: "/changed.ts", tool: "Edit" });
		expect(handler).toHaveBeenCalledWith("/changed.ts");
	});

	it("handles Bash tool with parseBashCommand", async () => {
		const handler = vi.fn();
		setAddFileHandler(handler);
		(parseBashCommand as ReturnType<typeof vi.fn>).mockReturnValueOnce({
			modified: ["/a.ts"],
			deleted: ["/b.ts"],
			created: [],
		});
		await sendRequest("POST", "/changed", { tool: "Bash", command: "sed -i file" });
		expect(handler).toHaveBeenCalledWith("/a.ts");
		expect(handler).toHaveBeenCalledWith("/b.ts");
	});

	it("does not call handler when file is missing and tool is not Bash", async () => {
		const handler = vi.fn();
		setAddFileHandler(handler);
		await sendRequest("POST", "/changed", { tool: "Edit" });
		expect(handler).not.toHaveBeenCalled();
	});

	it("returns ok on malformed JSON", async () => {
		const req = createMockReq("POST", "/changed", "bad-json");
		const res = createMockRes();
		requestHandler(req, res);
		await new Promise((r) => setTimeout(r, 10));
		const body = JSON.parse(res.end.mock.calls[0][0]);
		expect(body.ok).toBe(true);
	});
});

describe("POST /review (legacy)", () => {
	it("executes ccr.openReview command", async () => {
		const vscode = await import("./mocks/vscode");
		await sendRequest("POST", "/review");
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("ccr.openReview");
	});
});

describe("OPTIONS (CORS preflight)", () => {
	it("returns 204 with CORS headers", async () => {
		const res = await sendRequest("OPTIONS", "/anything");
		expect(res.writeHead).toHaveBeenCalledWith(204);
		expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "*");
		expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
		expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Headers", "Content-Type");
	});
});

describe("CORS headers on all responses", () => {
	it("sets CORS headers on normal GET requests", async () => {
		const res = await sendRequest("GET", "/status");
		expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "*");
	});
});

describe("invalid routes", () => {
	it("returns 404 for unknown GET path", async () => {
		const res = await sendRequest("GET", "/nope");
		expect(res.writeHead).toHaveBeenCalledWith(404);
	});

	it("returns 404 for unknown POST path", async () => {
		const res = await sendRequest("POST", "/nope", {});
		expect(res.writeHead).toHaveBeenCalledWith(404);
	});

	it("returns 404 for POST on GET-only route /status", async () => {
		const res = await sendRequest("POST", "/status", {});
		expect(res.writeHead).toHaveBeenCalledWith(404);
	});

	it("returns 404 for GET on POST-only route /changed", async () => {
		const res = await sendRequest("GET", "/changed");
		expect(res.writeHead).toHaveBeenCalledWith(404);
	});

	it("returns 404 for GET on POST-only route /snapshot", async () => {
		const res = await sendRequest("GET", "/snapshot");
		expect(res.writeHead).toHaveBeenCalledWith(404);
	});
});

describe("snapshot management (unit)", () => {
	it("getSnapshot returns undefined for unknown path", () => {
		expect(getSnapshot("/unknown-path")).toBeUndefined();
	});

	it("clearSnapshot is safe on missing key", () => {
		expect(() => clearSnapshot("/nope")).not.toThrow();
	});
});

describe("setWorkspacePath", () => {
	it("sets workspace path without error", () => {
		expect(() => setWorkspacePath("/my/workspace")).not.toThrow();
	});

	it("passes workspace path to parseBashCommand on /snapshot", async () => {
		setWorkspacePath("/my/workspace");
		(parseBashCommand as ReturnType<typeof vi.fn>).mockReturnValueOnce({
			modified: [],
			deleted: [],
			created: [],
		});
		await sendRequest("POST", "/snapshot", { tool: "Bash", command: "echo hi" });
		expect(parseBashCommand).toHaveBeenCalledWith("echo hi", "/my/workspace");
	});
});
