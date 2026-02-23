import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as log from "./log";

export type SettingsScope = "global" | "project";

export function getClaudeUserSettingsPath(): string {
	return path.join(os.homedir(), ".claude", "settings.json");
}

export function getClaudeRuntimeStatePath(): string {
	return path.join(os.homedir(), ".claude.json");
}

export function getClaudeProjectSettingsPath(workspacePath: string): string {
	return path.join(workspacePath, ".claude", "settings.local.json");
}

function readJsonFile(filePath: string): Record<string, unknown> {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return {};
	}
}

/** Read settings for a specific scope (global or project). */
export function readClaudeSettingsScoped(
	scope: SettingsScope,
	workspacePath?: string,
): Record<string, unknown> {
	if (scope === "project" && workspacePath) {
		return readJsonFile(getClaudeProjectSettingsPath(workspacePath));
	}
	return readJsonFile(getClaudeUserSettingsPath());
}

export function readClaudeRuntimeState(): Record<string, unknown> {
	return readJsonFile(getClaudeRuntimeStatePath());
}

export function writeClaudeRuntimeState(key: string, value: unknown): void {
	const statePath = getClaudeRuntimeStatePath();
	const state = readJsonFile(statePath);
	state[key] = value;
	fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
	log.log(`claude-runtime: wrote ${key} = ${JSON.stringify(value)}`);
}

/**
 * Read effective (merged) settings: global as base, project overrides on top.
 * Returns { effective, global, project, runtime } for the UI to distinguish sources.
 */
export function readClaudeSettings(workspacePath?: string): {
	effective: Record<string, unknown>;
	global: Record<string, unknown>;
	project: Record<string, unknown>;
	runtime: Record<string, unknown>;
} {
	const global = readJsonFile(getClaudeUserSettingsPath());
	const project = workspacePath
		? readJsonFile(getClaudeProjectSettingsPath(workspacePath))
		: {};
	const effective = deepMerge(global, project);
	const runtime = readClaudeRuntimeState();
	return { effective, global, project, runtime };
}

/**
 * Write a single setting using dot-notation key (e.g. "preferences.theme").
 */
export function writeClaudeSetting(
	key: string,
	value: unknown,
	scope: SettingsScope,
	workspacePath?: string,
): void {
	const settingsPath =
		scope === "project" && workspacePath
			? getClaudeProjectSettingsPath(workspacePath)
			: getClaudeUserSettingsPath();

	const settings = readJsonFile(settingsPath);
	const parts = key.split(".");
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let obj: any = settings;
	for (let i = 0; i < parts.length - 1; i++) {
		if (typeof obj[parts[i]] !== "object" || obj[parts[i]] === null) {
			obj[parts[i]] = {};
		}
		obj = obj[parts[i]];
	}
	obj[parts[parts.length - 1]] = value;

	const dir = path.dirname(settingsPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
	log.log(`claude-settings [${scope}]: wrote ${key} = ${JSON.stringify(value)}`);
}

function deepMerge(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...base };
	for (const key of Object.keys(override)) {
		if (
			typeof result[key] === "object" &&
			result[key] !== null &&
			!Array.isArray(result[key]) &&
			typeof override[key] === "object" &&
			override[key] !== null &&
			!Array.isArray(override[key])
		) {
			result[key] = deepMerge(
				result[key] as Record<string, unknown>,
				override[key] as Record<string, unknown>,
			);
		} else {
			result[key] = override[key];
		}
	}
	return result;
}
