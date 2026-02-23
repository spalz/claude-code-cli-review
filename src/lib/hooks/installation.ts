// Hook installation — writes scripts to disk and registers in Claude settings
import * as fs from "fs";
import * as path from "path";
import * as log from "../log";
import { POST_HOOK_FILENAME, PRE_HOOK_FILENAME, NOTIFY_HOOK_FILENAME, LEGACY_PROMPT_GUARD_FILENAME, LEGACY_PROMPT_BLOCKER_MARKER } from "./constants";
import { getHooksDir, getHookPath, getPreHookPath, getNotifyHookPath, getClaudeSettingsPath } from "./paths";
import { getPostHookScript, getPreHookScript, getNotifyHookScript } from "./scripts";

export function installHook(workspacePath: string): string {
	const hooksDir = getHooksDir(workspacePath);
	const postHookPath = getHookPath(workspacePath);
	const preHookPath = getPreHookPath(workspacePath);
	const notifyHookPath = getNotifyHookPath(workspacePath);

	fs.mkdirSync(hooksDir, { recursive: true });

	fs.writeFileSync(postHookPath, getPostHookScript(), { mode: 0o755 });
	fs.writeFileSync(preHookPath, getPreHookScript(), { mode: 0o755 });
	fs.writeFileSync(notifyHookPath, getNotifyHookScript(), { mode: 0o755 });
	log.log(`Hook scripts written to ${hooksDir}`);

	// Clean up legacy prompt guard file (slash commands are blocked at webview level now)
	const legacyGuardPath = path.join(hooksDir, LEGACY_PROMPT_GUARD_FILENAME);
	try {
		if (fs.existsSync(legacyGuardPath)) {
			fs.unlinkSync(legacyGuardPath);
			log.log(`Removed legacy prompt guard: ${legacyGuardPath}`);
		}
	} catch {}

	registerHooksInSettings(workspacePath, postHookPath, preHookPath, notifyHookPath);
	return postHookPath;
}

function registerHooksInSettings(
	workspacePath: string,
	postHookPath: string,
	preHookPath: string,
	notifyHookPath: string,
): void {
	const settingsPath = getClaudeSettingsPath(workspacePath);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let settings: Record<string, any> = {};
	try {
		settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	} catch {}

	if (!settings.hooks) settings.hooks = {};

	// PostToolUse
	if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];
	settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(entry: any) => {
			if (entry.type === "command" && entry.command?.includes(POST_HOOK_FILENAME))
				return false;
			if (
				entry.hooks?.some((h: { command?: string }) =>
					h.command?.includes(POST_HOOK_FILENAME),
				)
			)
				return false;
			return true;
		},
	);
	settings.hooks.PostToolUse.push({
		matcher: "Edit|Write|Bash",
		hooks: [{ type: "command", command: postHookPath }],
	});

	// PreToolUse
	if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];
	settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(entry: any) => {
			if (entry.type === "command" && entry.command?.includes(PRE_HOOK_FILENAME))
				return false;
			if (
				entry.hooks?.some((h: { command?: string }) =>
					h.command?.includes(PRE_HOOK_FILENAME),
				)
			)
				return false;
			return true;
		},
	);
	settings.hooks.PreToolUse.push({
		matcher: "Edit|Write|Bash",
		hooks: [{ type: "command", command: preHookPath }],
	});

	// Clean up legacy UserPromptSubmit entries (prompt guard moved to webview level)
	if (Array.isArray(settings.hooks.UserPromptSubmit)) {
		settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(entry: any) => {
				if (
					entry.hooks?.some((h: { command?: string }) =>
						h.command?.includes(LEGACY_PROMPT_GUARD_FILENAME),
					)
				)
					return false;
				if (
					entry.hooks?.some((h: { command?: string }) =>
						h.command?.includes(LEGACY_PROMPT_BLOCKER_MARKER),
					)
				)
					return false;
				return true;
			},
		);
		if (settings.hooks.UserPromptSubmit.length === 0) {
			delete settings.hooks.UserPromptSubmit;
		}
	}

	// Notification — OS-level notifications when Claude needs attention
	if (!Array.isArray(settings.hooks.Notification)) settings.hooks.Notification = [];
	settings.hooks.Notification = settings.hooks.Notification.filter(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(entry: any) => {
			if (entry.type === "command" && entry.command?.includes(NOTIFY_HOOK_FILENAME))
				return false;
			if (
				entry.hooks?.some((h: { command?: string }) =>
					h.command?.includes(NOTIFY_HOOK_FILENAME),
				)
			)
				return false;
			return true;
		},
	);
	settings.hooks.Notification.push({
		matcher: "*",
		hooks: [{ type: "command", command: notifyHookPath }],
	});

	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4), "utf8");
	log.log(`Hooks registered in ${settingsPath}`);
}
