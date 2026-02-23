// Hook validation — checks whether hooks are correctly installed
import * as fs from "fs";
import * as log from "../log";
import { POST_HOOK_FILENAME, PRE_HOOK_FILENAME, NOTIFY_HOOK_FILENAME } from "./constants";
import { getHookPath, getPreHookPath, getNotifyHookPath, getClaudeSettingsPath } from "./paths";
import { getPostHookScript, getPreHookScript, getNotifyHookScript } from "./scripts";

export function isHookInstalled(workspacePath: string): boolean {
	const postHookPath = getHookPath(workspacePath);
	const preHookPath = getPreHookPath(workspacePath);
	const notifyHookPath = getNotifyHookPath(workspacePath);

	if (
		!fs.existsSync(postHookPath) ||
		!fs.existsSync(preHookPath) ||
		!fs.existsSync(notifyHookPath)
	) {
		log.log("isHookInstalled: script file(s) missing");
		return false;
	}

	if (fs.readFileSync(postHookPath, "utf8") !== getPostHookScript()) {
		log.log("isHookInstalled: post hook content mismatch");
		return false;
	}

	if (fs.readFileSync(preHookPath, "utf8") !== getPreHookScript()) {
		log.log("isHookInstalled: pre hook content mismatch");
		return false;
	}

	if (fs.readFileSync(notifyHookPath, "utf8") !== getNotifyHookScript()) {
		log.log("isHookInstalled: notify hook content mismatch");
		return false;
	}

	const settingsPath = getClaudeSettingsPath(workspacePath);
	try {
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
			hooks?: {
				PostToolUse?: Array<{
					matcher?: string;
					hooks?: Array<{ type?: string; command?: string }>;
				}>;
				PreToolUse?: Array<{
					matcher?: string;
					hooks?: Array<{ type?: string; command?: string }>;
				}>;
				Notification?: Array<{
					matcher?: string;
					hooks?: Array<{ type?: string; command?: string }>;
				}>;
			};
		};

		const hasPost = settings?.hooks?.PostToolUse?.some(
			(e) =>
				e.matcher &&
				e.hooks?.some(
					(h) => h.type === "command" && h.command?.includes(POST_HOOK_FILENAME),
				),
		);
		const hasPre = settings?.hooks?.PreToolUse?.some(
			(e) =>
				e.matcher &&
				e.hooks?.some(
					(h) => h.type === "command" && h.command?.includes(PRE_HOOK_FILENAME),
				),
		);

		const hasNotify = settings?.hooks?.Notification?.some(
			(e) =>
				e.hooks?.some(
					(h) => h.type === "command" && h.command?.includes(NOTIFY_HOOK_FILENAME),
				),
		);

		if (!hasPost || !hasPre || !hasNotify) {
			log.log("isHookInstalled: missing hook entries in settings");
			return false;
		}
	} catch (err) {
		log.log(`isHookInstalled: settings read error: ${(err as Error).message}`);
		return false;
	}

	return true;
}
