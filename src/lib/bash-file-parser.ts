// Bash command parser — extracts file paths affected by bash commands
import * as path from "path";

export interface BashFileChanges {
	deleted: string[];
	modified: string[];
}

const DEV_PATHS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/stdin"]);
const SHELL_REDIRECT_PATTERN = /^[0-9]*>|2>&1|>&/;

export function parseBashCommand(command: string, workspacePath?: string): BashFileChanges {
	const deleted: string[] = [];
	const modified: string[] = [];

	if (!command.trim()) return { deleted, modified };

	const subCommands = splitCommands(command);
	for (const sub of subCommands) {
		const tokens = tokenize(sub);
		if (tokens.length === 0) continue;
		parseTokens(tokens, deleted, modified, workspacePath);
	}

	return { deleted, modified };
}

function parseTokens(
	tokens: string[],
	deleted: string[],
	modified: string[],
	workspacePath?: string,
): void {
	// Check for redirections first (> file, >> file)
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === ">" || tokens[i] === ">>") {
			const target = tokens[i + 1];
			if (target) addFile(modified, target, workspacePath);
		} else if (tokens[i].startsWith(">") && tokens[i].length > 1) {
			const target = tokens[i].replace(/^>>?/, "");
			if (target) addFile(modified, target, workspacePath);
		}
	}

	const cmd = tokens[0];

	if (cmd === "rm") {
		const files = filterArgs(tokens.slice(1), ["-r", "-f", "-rf", "-fr", "-v", "-i", "--force", "--recursive"]);
		for (const f of files) addFile(deleted, f, workspacePath);
	} else if (cmd === "mv") {
		const files = filterArgs(tokens.slice(1), ["-f", "-n", "-v", "--force"]);
		if (files.length >= 2) {
			// All but last are sources (deleted), last is dest (modified)
			for (let i = 0; i < files.length - 1; i++) addFile(deleted, files[i], workspacePath);
			addFile(modified, files[files.length - 1], workspacePath);
		}
	} else if (cmd === "cp") {
		const files = filterArgs(tokens.slice(1), ["-r", "-R", "-f", "-a", "-v", "--recursive", "--force"]);
		if (files.length >= 2) {
			addFile(modified, files[files.length - 1], workspacePath);
		}
	} else if (cmd === "sed") {
		const args = tokens.slice(1);
		let hasInPlace = false;
		const files: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if (a === "-i" || a.startsWith("-i")) {
				hasInPlace = true;
				// -i may have a suffix argument like -i.bak — skip if -i is standalone and next looks like suffix
				if (a === "-i" && i + 1 < args.length && !args[i + 1].startsWith("-") && !isLikelySedExpr(args[i + 1])) {
					// Could be suffix or expression — heuristic: skip one arg
				}
			} else if (a.startsWith("-")) {
				// other flags like -e, -E, -n
				if (a === "-e" || a === "-f") i++; // skip next arg (expression/file)
			} else if (!isLikelySedExpr(a) || files.length > 0) {
				files.push(a);
			}
			// first non-flag non-inplace is expression, rest are files
		}
		if (hasInPlace) {
			for (const f of files) addFile(modified, f, workspacePath);
		}
	} else if (cmd === "touch") {
		const files = filterArgs(tokens.slice(1), ["-a", "-m", "-c", "-r", "-t", "-d"]);
		for (const f of files) addFile(modified, f, workspacePath);
	} else if (cmd === "tee") {
		const files = filterArgs(tokens.slice(1), ["-a", "--append"]);
		for (const f of files) addFile(modified, f, workspacePath);
	} else if (cmd === "git") {
		if (tokens[1] === "checkout" && tokens.includes("--")) {
			const dashIdx = tokens.indexOf("--");
			for (let i = dashIdx + 1; i < tokens.length; i++) {
				addFile(modified, tokens[i], workspacePath);
			}
		} else if (tokens[1] === "restore") {
			const files = filterArgs(tokens.slice(2), ["-s", "--source", "-S", "--staged", "-W", "--worktree"]);
			// skip value after -s/--source
			const cleaned: string[] = [];
			for (let i = 0; i < files.length; i++) {
				cleaned.push(files[i]);
			}
			for (const f of cleaned) addFile(modified, f, workspacePath);
		}
	}
}

function isLikelySedExpr(s: string): boolean {
	// Sed expressions typically start with s/, y/, or a number/regex address
	return /^[sy]\//.test(s) || /^\//.test(s) || /^[0-9]/.test(s);
}

function filterArgs(args: string[], flags: string[]): string[] {
	const flagSet = new Set(flags);
	return args.filter((a) => !a.startsWith("-") || (!flagSet.has(a) && !a.startsWith("-")));
}

function addFile(list: string[], file: string, workspacePath?: string): void {
	if (!file || DEV_PATHS.has(file)) return;
	// Skip shell redirects captured as file paths (e.g. "2>/dev/null" split into "2>" and "/dev/null")
	if (SHELL_REDIRECT_PATTERN.test(file)) return;
	// Skip paths containing newlines or null bytes
	if (file.includes("\n") || file.includes("\0")) return;
	// Normalize trailing slash (e.g. "dest/" → "dest" for cp -r)
	const clean = file.endsWith("/") ? file.slice(0, -1) : file;
	if (!clean) return;
	const resolved = path.isAbsolute(clean)
		? clean
		: workspacePath
			? path.resolve(workspacePath, clean)
			: clean;
	if (!list.includes(resolved)) list.push(resolved);
}

/**
 * Split a compound command by &&, ;, || respecting quotes.
 * Pipe segments are kept together (only last matters for redirections).
 */
export function splitCommands(cmd: string): string[] {
	const results: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;

	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];

		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			current += ch;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			current += ch;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			current += ch;
			continue;
		}

		if (!inSingle && !inDouble) {
			if (ch === ";" || (ch === "&" && cmd[i + 1] === "&") || (ch === "|" && cmd[i + 1] === "|")) {
				if (current.trim()) results.push(current.trim());
				current = "";
				if (ch !== ";") i++; // skip second char of && or ||
				continue;
			}
			// Pipe: split into segments, process each independently
			if (ch === "|") {
				if (current.trim()) results.push(current.trim());
				current = "";
				continue;
			}
		}
		current += ch;
	}
	if (current.trim()) results.push(current.trim());
	return results;
}

/**
 * Tokenize a simple command, handling single/double quotes and backslash escapes.
 */
export function tokenize(cmd: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;

	for (const ch of cmd) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && !inSingle) {
			escaped = true;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}
