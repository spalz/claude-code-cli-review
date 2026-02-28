// Hook paths — resolve file system locations for hook scripts and settings
import * as path from "path";
import { POST_HOOK_FILENAME, PRE_HOOK_FILENAME, NOTIFY_HOOK_FILENAME } from "./constants";

export function getClaudeSettingsPath(workspacePath: string): string {
    return path.join(workspacePath, ".claude", "settings.local.json");
}

export function getHooksDir(workspacePath: string): string {
    return path.join(workspacePath, ".claude", "hooks");
}

export function getHookPath(workspacePath: string): string {
    return path.join(getHooksDir(workspacePath), POST_HOOK_FILENAME);
}

export function getPreHookPath(workspacePath: string): string {
    return path.join(getHooksDir(workspacePath), PRE_HOOK_FILENAME);
}

export function getNotifyHookPath(workspacePath: string): string {
    return path.join(getHooksDir(workspacePath), NOTIFY_HOOK_FILENAME);
}
