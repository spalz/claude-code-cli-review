import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFs = vi.hoisted(() => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
	unlinkSync: vi.fn(),
}));

vi.mock("fs", () => mockFs);
vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn() }));

import {
	getPostHookScript,
	getPreHookScript,
	getNotifyHookScript,
	installHook,
	isHookInstalled,
	checkAndPrompt,
} from "../hooks";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("hook scripts", () => {
	it("getPostHookScript contains HOOK_VERSION 8.0", () => {
		expect(getPostHookScript()).toContain("v8.0");
	});

	it("getPostHookScript contains curl to /changed", () => {
		expect(getPostHookScript()).toContain("27182/changed");
	});

	it("getPreHookScript contains curl to /snapshot", () => {
		expect(getPreHookScript()).toContain("27182/snapshot");
	});

	it("getPreHookScript contains base64 encoding", () => {
		expect(getPreHookScript()).toMatch(/base64 < "\$FILE_PATH"/);
	});

	it("both scripts filter by Edit|Write", () => {
		expect(getPostHookScript()).toContain("Edit");
		expect(getPostHookScript()).toContain("Write");
		expect(getPreHookScript()).toContain("Edit");
		expect(getPreHookScript()).toContain("Write");
	});

	it("postHookScript contains Bash branch", () => {
		expect(getPostHookScript()).toContain('"Bash"');
	});

	it("preHookScript contains Bash branch", () => {
		expect(getPreHookScript()).toContain('"Bash"');
	});

	it("postHookScript Bash branch sends command in JSON", () => {
		const script = getPostHookScript();
		expect(script).toContain("'tool':'Bash'");
		expect(script).toContain("'command':cmd");
	});

	it("preHookScript Bash branch sends to /snapshot", () => {
		const script = getPreHookScript();
		expect(script).toContain("27182/snapshot");
		expect(script).toContain("'tool':'Bash'");
	});

	it("getNotifyHookScript posts to /notify endpoint", () => {
		const script = getNotifyHookScript();
		expect(script).toContain("v8.0");
		expect(script).toContain("127.0.0.1:27182/notify");
		expect(script).toContain("curl");
		expect(script).not.toContain("osascript");
		expect(script).not.toContain("notify-send");
	});
});

describe("installHook", () => {
	it("creates hooks directory and writes all scripts", () => {
		mockFs.existsSync.mockReturnValue(false);
		mockFs.readFileSync.mockReturnValue("{}");
		installHook("/ws");
		expect(mockFs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining("hooks"), { recursive: true });
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			expect.stringContaining("ccr-review-hook.sh"),
			expect.stringContaining("PostToolUse"),
			{ mode: 0o755 },
		);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			expect.stringContaining("ccr-pre-hook.sh"),
			expect.stringContaining("PreToolUse"),
			{ mode: 0o755 },
		);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			expect.stringContaining("ccr-notify-hook.sh"),
			expect.stringContaining("Notification"),
			{ mode: 0o755 },
		);
	});

	it("does not write prompt guard script", () => {
		mockFs.existsSync.mockReturnValue(false);
		mockFs.readFileSync.mockReturnValue("{}");
		installHook("/ws");
		const writeArgs = mockFs.writeFileSync.mock.calls.map((c: unknown[]) => c[0] as string);
		expect(writeArgs.filter((p) => p.includes("ccr-prompt-guard"))).toHaveLength(0);
	});

	it("removes legacy prompt guard file if exists", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue("{}");
		installHook("/ws");
		expect(mockFs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining("ccr-prompt-guard.sh"));
	});

	it("cleans up UserPromptSubmit entries from settings", () => {
		mockFs.existsSync.mockReturnValue(false);
		mockFs.readFileSync.mockReturnValue(JSON.stringify({
			hooks: {
				UserPromptSubmit: [
					{ matcher: "", hooks: [{ type: "command", command: "/ws/.claude/hooks/ccr-prompt-guard.sh" }] },
				],
			},
		}));
		installHook("/ws");
		const settingsCall = mockFs.writeFileSync.mock.calls.find(
			(c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("settings.local.json"),
		);
		expect(settingsCall).toBeDefined();
		const settings = JSON.parse(settingsCall![1] as string);
		expect(settings.hooks.UserPromptSubmit).toBeUndefined();
	});

	it("registers hooks in settings.local.json without UserPromptSubmit", () => {
		mockFs.existsSync.mockReturnValue(false);
		mockFs.readFileSync.mockReturnValue("{}");
		installHook("/ws");
		const settingsCall = mockFs.writeFileSync.mock.calls.find(
			(c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("settings.local.json"),
		);
		expect(settingsCall).toBeDefined();
		const settings = JSON.parse(settingsCall![1] as string);
		expect(settings.hooks.PostToolUse).toHaveLength(1);
		expect(settings.hooks.PreToolUse).toHaveLength(1);
		expect(settings.hooks.Notification).toHaveLength(1);
		expect(settings.hooks.Notification[0].hooks[0].command).toContain("ccr-notify-hook.sh");
		expect(settings.hooks.UserPromptSubmit).toBeUndefined();
	});

	it("uses Edit|Write|Bash matcher in settings", () => {
		mockFs.existsSync.mockReturnValue(false);
		mockFs.readFileSync.mockReturnValue("{}");
		installHook("/ws");
		const settingsCall = mockFs.writeFileSync.mock.calls.find(
			(c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("settings.local.json"),
		);
		const settings = JSON.parse(settingsCall![1] as string);
		expect(settings.hooks.PostToolUse[0].matcher).toBe("Edit|Write|Bash");
		expect(settings.hooks.PreToolUse[0].matcher).toBe("Edit|Write|Bash");
	});
});

describe("isHookInstalled", () => {
	function setupInstalled() {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockImplementation((p: string) => {
			if (p.includes("ccr-review-hook.sh")) return getPostHookScript();
			if (p.includes("ccr-pre-hook.sh")) return getPreHookScript();
			if (p.includes("ccr-notify-hook.sh")) return getNotifyHookScript();
			if (p.includes("settings.local.json"))
				return JSON.stringify({
					hooks: {
						PostToolUse: [{ matcher: "Edit|Write|Bash", hooks: [{ type: "command", command: "ccr-review-hook.sh" }] }],
						PreToolUse: [{ matcher: "Edit|Write|Bash", hooks: [{ type: "command", command: "ccr-pre-hook.sh" }] }],
						Notification: [{ matcher: "", hooks: [{ type: "command", command: "ccr-notify-hook.sh" }] }],
					},
				});
			return "";
		});
	}

	it("returns true when all files and settings correct", () => {
		setupInstalled();
		expect(isHookInstalled("/ws")).toBe(true);
	});

	it("returns false when post hook file missing", () => {
		mockFs.existsSync.mockImplementation((p: string) => !p.includes("ccr-review-hook"));
		expect(isHookInstalled("/ws")).toBe(false);
	});

	it("returns false when pre hook file missing", () => {
		mockFs.existsSync.mockImplementation((p: string) => !p.includes("ccr-pre-hook"));
		expect(isHookInstalled("/ws")).toBe(false);
	});

	it("returns false when notify hook file missing", () => {
		mockFs.existsSync.mockImplementation((p: string) => !p.includes("ccr-notify-hook"));
		expect(isHookInstalled("/ws")).toBe(false);
	});

	it("returns false when content mismatch", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue("wrong content");
		expect(isHookInstalled("/ws")).toBe(false);
	});

	it("returns false when settings missing hook entries", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockImplementation((p: string) => {
			if (p.includes("ccr-review-hook.sh")) return getPostHookScript();
			if (p.includes("ccr-pre-hook.sh")) return getPreHookScript();
			if (p.includes("ccr-notify-hook.sh")) return getNotifyHookScript();
			return JSON.stringify({ hooks: {} });
		});
		expect(isHookInstalled("/ws")).toBe(false);
	});

	it("does not check for prompt guard file or settings", () => {
		setupInstalled();
		// Should pass even without UserPromptSubmit in settings
		expect(isHookInstalled("/ws")).toBe(true);
		// Verify prompt guard file is not checked
		const existsCalls = mockFs.existsSync.mock.calls.map((c: unknown[]) => c[0] as string);
		expect(existsCalls.some((p: string) => p.includes("ccr-prompt-guard"))).toBe(false);
	});
});

describe("checkAndPrompt", () => {
	it("returns 'installed' for correct hooks", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockImplementation((p: string) => {
			if (p.includes("ccr-review-hook.sh")) return getPostHookScript();
			if (p.includes("ccr-pre-hook.sh")) return getPreHookScript();
			if (p.includes("ccr-notify-hook.sh")) return getNotifyHookScript();
			return JSON.stringify({
				hooks: {
					PostToolUse: [{ matcher: "Edit|Write|Bash", hooks: [{ type: "command", command: "ccr-review-hook.sh" }] }],
					PreToolUse: [{ matcher: "Edit|Write|Bash", hooks: [{ type: "command", command: "ccr-pre-hook.sh" }] }],
					Notification: [{ matcher: "", hooks: [{ type: "command", command: "ccr-notify-hook.sh" }] }],
				},
			});
		});
		const cb = vi.fn();
		expect(checkAndPrompt("/ws", cb)).toBe("installed");
		expect(cb).toHaveBeenCalledWith("installed");
	});

	it("auto-installs when hooks don't exist", () => {
		mockFs.existsSync.mockReturnValue(false);
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		const cb = vi.fn();
		expect(checkAndPrompt("/ws", cb)).toBe("installed");
		expect(cb).toHaveBeenCalledWith("installed");
	});

	it("auto-installs when hooks are outdated", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue("old content");
		const cb = vi.fn();
		expect(checkAndPrompt("/ws", cb)).toBe("installed");
		expect(cb).toHaveBeenCalledWith("installed");
	});
});
