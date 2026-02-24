// PTY session manager — spawns and manages pty processes via node-pty
import * as vscode from "vscode";
import * as path from "path";
import * as log from "./log";
import { fileLog } from "./file-logger";
import type {
	INodePty,
	IPtyProcess,
	PtySessionInfo,
	PtyDataHandler,
	PtyExitHandler,
} from "../types";

let nodePty: INodePty | null = null;

function loadNodePty(): INodePty {
	if (nodePty) return nodePty;

	const appRoot = vscode.env.appRoot;
	const candidates = [
		path.join(appRoot, "node_modules.asar", "node-pty"),
		path.join(appRoot, "node_modules", "node-pty"),
	];

	for (const p of candidates) {
		try {
			nodePty = require(p) as INodePty;
			console.log("[ccr] node-pty loaded from:", p);
			return nodePty;
		} catch {}
	}
	throw new Error("node-pty not found in VS Code / Cursor internals");
}

class PtySession {
	readonly id: number;
	readonly name: string;
	readonly process: IPtyProcess;
	readonly createdAt: number = Date.now();

	constructor(
		id: number,
		name: string,
		workspacePath: string,
		onData: PtyDataHandler,
		onExit: PtyExitHandler,
		command?: string,
	) {
		this.id = id;
		this.name = name;

		const pty = loadNodePty();
		const config = vscode.workspace.getConfiguration("claudeCodeReview");
		const extraVars = config.get<Record<string, string>>("extraEnvVars", {});

		const isWin = process.platform === "win32";
		const shell = isWin ? "powershell.exe" : "/bin/bash";
		const cmd = command || "claude";
		fileLog.log("terminal", `spawning #${id}`, { shell, cmd, cwd: workspacePath });

		const env: Record<string, string | undefined> = { ...process.env };

		// Critical for embedded xterm.js context
		env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = "false";
		env.DISABLE_AUTOUPDATER = "1";
		env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
		env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = "1";
		env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
		env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL = "1";
		env.SHELL = shell;

		// Apply user extra env vars last (highest priority)
		Object.assign(env, extraVars);

		log.log(`PTY #${id} created`);
		fileLog.log("terminal", `create #${id}`, { cmd, cwd: workspacePath, shell });

		const args: string[] = isWin
			? ["-Command", cmd]
			: ["-l", "-c", `exec ${cmd}`];

		this.process = pty.spawn(shell, args, {
			name: "xterm-256color",
			cols: 80,
			rows: 24,
			cwd: workspacePath,
			env,
		});

		let firstData = true;
		this.process.onData((data) => {
			if (firstData) {
				fileLog.log("terminal", `first-data #${id}`, { bytes: data.length });
				firstData = false;
			}
			// Log screen-switching and full-redraw sequences
			if (data.includes("\x1b[?1049h") || data.includes("\x1b[?1049l") || data.includes("\x1b[2J")) {
				fileLog.log("terminal", `screen-seq #${id}`, {
					len: data.length,
					altEnter: data.includes("\x1b[?1049h"),
					altExit: data.includes("\x1b[?1049l"),
					clearScreen: data.includes("\x1b[2J"),
				});
			}
			onData(this.id, data);
		});
		this.process.onExit(({ exitCode }) => {
			log.log(`PTY #${id} exited: code=${exitCode}`);
			fileLog.log("terminal", `exit #${id}`, { exitCode });
			onExit(this.id, exitCode);
		});
	}

	write(data: string): void {
		this.process.write(data);
	}

	resize(cols: number, rows: number): void {
		try {
			this.process.resize(cols, rows);
		} catch (err) {
			fileLog.log("terminal", `resize error #${this.id}`, { error: (err as Error).message });
		}
	}

	kill(): void {
		try {
			this.process.kill();
		} catch (err) {
			fileLog.log("terminal", `kill error #${this.id}`, { error: (err as Error).message });
		}
	}
}

export class PtyManager {
	private readonly _wp: string;
	private readonly _sessions = new Map<number, PtySession>();
	private _counter = 0;
	private _onData: PtyDataHandler | null = null;
	private _onExit: PtyExitHandler | null = null;

	constructor(workspacePath: string) {
		this._wp = workspacePath;
	}

	setHandlers(onData: PtyDataHandler, onExit: PtyExitHandler): void {
		this._onData = onData;
		this._onExit = onExit;
	}

	createSession(name?: string, command?: string): PtySessionInfo {
		const id = ++this._counter;
		const label = name || `Session ${id}`;
		log.log(`Creating session #${id}: name=${label}, command=${command || "claude"}`);

		const session = new PtySession(
			id,
			label,
			this._wp,
			(sid, data) => {
				this._onData?.(sid, data);
			},
			(sid, code) => {
				const age = this.getSessionAge(sid);
				this._sessions.delete(sid);
				this._onExit?.(sid, code, age);
			},
			command,
		);

		this._sessions.set(id, session);
		return { id, name: label };
	}

	writeToSession(id: number, data: string): void {
		if (data.includes("\r") || data.includes("\x1b") || data.includes("\n")) {
			const hex = [...data].map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
			fileLog.log("terminal", `write #${id} ENTER`, { hex, len: data.length });
		}
		this._sessions.get(id)?.write(data);
	}

	resizeSession(id: number, cols: number, rows: number): void {
		if (!cols || !rows || cols < 1 || rows < 1) return;
		fileLog.log("terminal", `resize #${id}`, { cols, rows });
		this._sessions.get(id)?.resize(cols, rows);
	}

	closeSession(id: number): void {
		log.log(`Closing session #${id}`);
		const s = this._sessions.get(id);
		if (s) {
			s.kill();
			this._sessions.delete(id);
		}
	}

	getSessions(): PtySessionInfo[] {
		return [...this._sessions.values()].map((s) => ({
			id: s.id,
			name: s.name,
		}));
	}

	/** Get session age in ms (from creation). Returns 0 if session not found. */
	getSessionAge(id: number): number {
		const s = this._sessions.get(id);
		return s ? Date.now() - s.createdAt : 0;
	}

	dispose(): void {
		for (const s of this._sessions.values()) s.kill();
		this._sessions.clear();
	}
}
