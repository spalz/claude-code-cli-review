// Hook commands — VS Code-dependent check & install logic
import * as vscode from "vscode";
import * as fs from "fs";
import * as log from "../log";
import type { HookStatus, HookStatusCallback } from "../../types";
import { getHookPath } from "./paths";
import { isHookInstalled } from "./validation";
import { installHook } from "./installation";

export function checkAndPrompt(
	workspacePath: string,
	onStatusChange?: HookStatusCallback,
): HookStatus {
	if (isHookInstalled(workspacePath)) {
		log.log("checkAndPrompt: hooks are up to date");
		onStatusChange?.("installed");
		return "installed";
	}

	const exists = fs.existsSync(getHookPath(workspacePath));
	const status: HookStatus = exists ? "outdated" : "missing";
	log.log(`checkAndPrompt: hooks ${status}, auto-installing...`);

	// Auto-install hooks on first activation or when outdated
	try {
		installHook(workspacePath);
		log.log("checkAndPrompt: auto-install succeeded");
		onStatusChange?.("installed");
		return "installed";
	} catch (err) {
		log.log(`checkAndPrompt: auto-install failed — ${(err as Error).message}`);
		onStatusChange?.(status);
		return status;
	}
}

export function doInstall(workspacePath: string, onStatusChange?: HookStatusCallback): void {
	try {
		installHook(workspacePath);
		onStatusChange?.("installed");
		vscode.window.showInformationMessage(
			"Claude Code Review integration configured: change tracking and OS notifications.",
		);
	} catch (err) {
		log.log(`doInstall error: ${(err as Error).message}`);
		vscode.window.showErrorMessage(`Failed to install hooks: ${(err as Error).message}`);
	}
}
