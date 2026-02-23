import * as vscode from "vscode";
import * as fs from "fs";
import * as log from "../log";
import * as state from "../state";
import { listSessions, getSessionsDir, loadSessionNames } from "../sessions";
import type { PtyManager } from "../pty-manager";
import type { ExtensionToWebviewMessage } from "../../types";

export class SessionManager {
	private readonly _ptyToClaudeId = new Map<number, string>();
	private _namesWatcher: fs.FSWatcher | null = null;
	private _namesDebounce: ReturnType<typeof setTimeout> | null = null;
	private _cachedNames: Record<string, string> = {};
	private _jsonlDebounce: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly _wp: string,
		private readonly _ptyManager: PtyManager,
		private readonly _workspaceState: vscode.Memento | undefined,
		private readonly _postMessage: (msg: ExtensionToWebviewMessage) => void,
	) {}

	refreshClaudeSessions(): void {
		const openIds = new Set(this._ptyToClaudeId.values());
		const { sessions, archivedCount } = listSessions(this._wp, 30, 0, openIds);
		log.log(`refreshClaudeSessions: found ${sessions.length} sessions, ${archivedCount} archived`);
		this._postMessage({ type: "sessions-list", sessions, archivedCount });
		this.sendOpenSessionIds();
	}

	startNewClaudeSession(resumeId?: string): void {
		const t0 = Date.now();
		const cli = vscode.workspace
			.getConfiguration("claudeCodeReview")
			.get<string>("cliCommand", "claude");
		const cmd = resumeId ? `${cli} --resume ${resumeId}` : cli;
		log.log(`startNewClaudeSession: resumeId=${resumeId || "none"}, cmd=${cmd}`);

		const info = this._ptyManager.createSession(
			resumeId ? `resume:${resumeId.slice(0, 8)}` : "new",
			cmd,
		);

		if (resumeId) {
			this._ptyToClaudeId.set(info.id, resumeId);
		}

		this._persistOpenSessions();
		this._postMessage({
			type: "terminal-session-created",
			sessionId: info.id,
			name: info.name,
			claudeId: resumeId || null,
		});
		this.sendOpenSessionIds();
		state.refreshAll();
		log.log(`startNewClaudeSession: resume=${resumeId || "none"}, pty=${info.id}, ${Date.now() - t0}ms`);

		if (!resumeId) {
			this._detectNewSessionId(info.id);
		}
	}

	findPtyByClaudeId(claudeId: string): number | null {
		for (const [ptyId, cId] of this._ptyToClaudeId) {
			if (cId === claudeId) return ptyId;
		}
		return null;
	}

	sendOpenSessionIds(): void {
		const openClaudeIds = [...this._ptyToClaudeId.values()];
		log.log(`sendOpenSessionIds: [${openClaudeIds.map((id) => id.slice(0, 8)).join(", ")}]`);
		this._postMessage({ type: "open-sessions-update", openClaudeIds });
	}

	removeOpenSession(ptySessionId: number): void {
		log.log(
			`removeOpenSession: pty=${ptySessionId}, claude=${this._ptyToClaudeId.get(ptySessionId) || "?"}`,
		);
		this._ptyToClaudeId.delete(ptySessionId);
		this._persistOpenSessions();
	}

	persistActiveSession(claudeId: string | null): void {
		log.log(`persistActiveSession: ${claudeId || "none"}`);
		this._workspaceState?.update("ccr.activeSession", claudeId || null);
	}

	restoreSessions(): void {
		const t0 = Date.now();
		const ids = this._workspaceState?.get<string[]>("ccr.openSessions") || [];
		const activeClaudeId = this._workspaceState?.get<string>("ccr.activeSession") || null;
		log.log(
			`restoreSessions: ${ids.length} sessions to restore: [${ids.join(", ")}], active=${activeClaudeId || "none"}`,
		);

		for (const claudeId of ids) {
			this.startNewClaudeSession(claudeId);
		}
		log.log(`restoreSessions: ${ids.length} restored in ${Date.now() - t0}ms`);

		if (activeClaudeId) {
			const ptyId = this.findPtyByClaudeId(activeClaudeId);
			if (ptyId !== null) {
				log.log(`restoreSessions: activating saved active session pty #${ptyId}`);
				this._postMessage({
					type: "activate-terminal",
					sessionId: ptyId,
				});
			}
		}
	}

	getPtyToClaudeId(): Map<number, string> {
		return this._ptyToClaudeId;
	}

	private _detectNewSessionId(ptyId: number): void {
		const sessionsDir = getSessionsDir(this._wp);

		let existingFiles: Set<string>;
		try {
			existingFiles = new Set(
				fs.readdirSync(sessionsDir)
					.filter((f) => f.endsWith(".jsonl"))
					.map((f) => f.replace(".jsonl", "")),
			);
		} catch {
			existingFiles = new Set();
		}

		const createdAt = Date.now();
		let attempts = 0;
		const interval = setInterval(() => {
			attempts++;
			// Stop after 30 seconds or if already mapped
			if (attempts > 15 || this._ptyToClaudeId.has(ptyId)) {
				clearInterval(interval);
				return;
			}
			try {
				const files = fs
					.readdirSync(sessionsDir)
					.filter((f) => f.endsWith(".jsonl"));

				for (const file of files) {
					const sessionId = file.replace(".jsonl", "");
					if (existingFiles.has(sessionId)) continue;

					// Only consider files created after our PTY started
					const stat = fs.statSync(`${sessionsDir}/${file}`);
					if (stat.mtimeMs < createdAt - 2000) continue;

					log.log(`detected new claude session: ${sessionId.slice(0, 8)} for pty #${ptyId}`);
					this._ptyToClaudeId.set(ptyId, sessionId);
					this._persistOpenSessions();
					this._postMessage({
						type: "update-terminal-claude-id",
						sessionId: ptyId,
						claudeId: sessionId,
					});
					this.refreshClaudeSessions();
					clearInterval(interval);
					return;
				}
			} catch {}
		}, 2000);
	}

	/** Watch session-names.json and open-session .jsonl files for changes */
	watchSessionNames(): void {
		const dir = getSessionsDir(this._wp);
		try {
			this._namesWatcher = fs.watch(dir, (_, filename) => {
				if (filename === "session-names.json") {
					if (this._namesDebounce) clearTimeout(this._namesDebounce);
					this._namesDebounce = setTimeout(() => this._syncTabNames(), 300);
				}
				// Detect changes to open session .jsonl files (e.g., Claude auto-title via summary)
				if (filename?.endsWith(".jsonl")) {
					const sessionId = filename.replace(".jsonl", "");
					if (this._ptyToClaudeId.size > 0 && [...this._ptyToClaudeId.values()].includes(sessionId)) {
						if (this._jsonlDebounce) clearTimeout(this._jsonlDebounce);
						this._jsonlDebounce = setTimeout(() => this.refreshClaudeSessions(), 2000);
					}
				}
			});
		} catch {
			// Directory might not exist yet — watcher will be retried on next session open
		}
	}

	dispose(): void {
		this._namesWatcher?.close();
		this._namesWatcher = null;
	}

	private _syncTabNames(): void {
		const names = loadSessionNames(this._wp);
		for (const [, claudeId] of this._ptyToClaudeId) {
			const newName = names[claudeId];
			if (newName && newName !== this._cachedNames[claudeId]) {
				log.log(`names-sync: ${claudeId.slice(0, 8)} -> "${newName}"`);
				this._postMessage({
					type: "rename-terminal-tab",
					claudeId,
					newName,
				});
			}
		}
		this._cachedNames = names;
	}

	private _persistOpenSessions(): void {
		const ids = [...this._ptyToClaudeId.values()];
		log.log(`persistOpenSessions: ${ids.length} sessions saved`);
		this._workspaceState?.update("ccr.openSessions", ids);
	}
}
