// PTY session manager — spawns and manages pty processes via node-pty
import * as vscode from "vscode";
import * as path from "path";
import * as log from "./log";
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
		const shell =
			process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash";

		const cmd = command || "claude";
		log.log(`PTY #${id} spawning: shell=${shell}, cmd=${cmd}, cwd=${workspacePath}`);

		const env: Record<string, string | undefined> = { ...process.env };
		// Critical for embedded xterm.js context
		env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = "false";
		env.DISABLE_AUTOUPDATER = "1";
		env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
		env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = "1";
		env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
		env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL = "1";

		log.log(`PTY #${id} created: cmd=${cmd}, cwd=${workspacePath}`);

		this.process = pty.spawn(shell, ["-l", "-c", `exec ${cmd}`], {
			name: "xterm-256color",
			cols: 80,
			rows: 24,
			cwd: workspacePath,
			env,
		});

		this.process.onData((data) => onData(this.id, data));
		this.process.onExit(({ exitCode }) => {
			log.log(`PTY #${id} exited with code ${exitCode}`);
			onExit(this.id, exitCode);
		});
	}

	write(data: string): void {
		this.process.write(data);
	}

	resize(cols: number, rows: number): void {
		try {
			this.process.resize(cols, rows);
		} catch {}
	}

	kill(): void {
		try {
			this.process.kill();
		} catch {}
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
				this._sessions.delete(sid);
				this._onExit?.(sid, code);
			},
			command,
		);

		this._sessions.set(id, session);
		return { id, name: label };
	}

	writeToSession(id: number, data: string): void {
		this._sessions.get(id)?.write(data);
	}

	resizeSession(id: number, cols: number, rows: number): void {
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

	dispose(): void {
		for (const s of this._sessions.values()) s.kill();
		this._sessions.clear();
	}
}
