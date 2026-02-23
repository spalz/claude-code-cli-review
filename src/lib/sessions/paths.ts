// Session path utilities — resolves Claude CLI session directories and config files
import * as path from "path";
import * as os from "os";

export function getProjectKey(workspacePath: string): string {
	// Claude CLI encodes paths: /Users/spals/projects/foo → -Users-spals-projects-foo
	return workspacePath.replace(/\//g, "-").replace(/^-/, "-");
}

export function getSessionsDir(workspacePath: string): string {
	return path.join(os.homedir(), ".claude", "projects", getProjectKey(workspacePath));
}

export function getNamesFile(workspacePath: string): string {
	return path.join(getSessionsDir(workspacePath), "session-names.json");
}

export function getCcrNamesFile(workspacePath: string): string {
	return path.join(getSessionsDir(workspacePath), "ccr-session-names.json");
}

export function getInvalidSessionsFile(workspacePath: string): string {
	return path.join(getSessionsDir(workspacePath), "invalid-sessions.json");
}

export function getArchivedSessionsFile(workspacePath: string): string {
	return path.join(getSessionsDir(workspacePath), "archived-sessions.json");
}
