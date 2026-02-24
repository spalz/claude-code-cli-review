import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as log from "../log";
import * as state from "../state";
import { isProjectTrusted } from "../claude-settings";
import { isHookInstalled } from "../hooks";
import { listSessions, getSessionsDir, loadSessionNames } from "../sessions";
import type { PtyManager } from "../pty-manager";
import type { ExtensionToWebviewMessage } from "../../types";

export class SessionManager {
	private readonly _ptyToClaudeId = new Map<number, string>();
	/** All open claude IDs (real PTY + lazy placeholders). Source of truth for persistence & UI. */
	private readonly _allOpenClaudeIds = new Set<string>();
	private _restored = false;
	private _namesWatcher: fs.FSWatcher | null = null;
	private _namesDebounce: ReturnType<typeof setTimeout> | null = null;
	private _cachedNames: Record<string, string> = {};
	private _jsonlDebounce: ReturnType<typeof setTimeout> | null = null;
	private _pendingSession: { resumeId?: string; restoring?: boolean } | null = null;

	constructor(
		private readonly _wp: string,
		private readonly _ptyManager: PtyManager,
		private readonly _workspaceState: vscode.Memento | undefined,
		private readonly _postMessage: (msg: ExtensionToWebviewMessage) => void,
	) {
		// Eagerly load saved open session IDs so refreshClaudeSessions() shows
		// correct "open" indicators before terminals are lazily restored.
		const saved = this._workspaceState?.get<string[]>("ccr.openSessions") || [];
		for (const id of saved) this._allOpenClaudeIds.add(id);
	}

	refreshClaudeSessions(): void {
		const openIds = this._allOpenClaudeIds;
		const { sessions, archivedCount } = listSessions(this._wp, 30, 0, openIds);
		log.log(`refreshClaudeSessions: found ${sessions.length} sessions, ${archivedCount} archived`);
		this._postMessage({ type: "sessions-list", sessions, archivedCount });
		this.sendOpenSessionIds();
	}

	resumePendingSession(): void {
		if (!this._pendingSession) return;
		const { resumeId, restoring } = this._pendingSession;
		this._pendingSession = null;
		log.log(`resumePendingSession: resumeId=${resumeId || "none"}`);
		this.startNewClaudeSession(resumeId, restoring);
	}

	startNewClaudeSession(resumeId?: string, restoring?: boolean): void {
		// Trust gate — show onboarding if project not yet trusted
		if (!restoring && !isProjectTrusted(this._wp)) {
			log.log("startNewClaudeSession: project not trusted, showing onboarding");
			this._pendingSession = { resumeId, restoring };
			this._postMessage({
				type: "show-onboarding",
				folderName: path.basename(this._wp),
				workspacePath: this._wp,
				hooksInstalled: isHookInstalled(this._wp),
				mcpServers: this._detectMcpServers(),
			});
			return;
		}

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
			this._allOpenClaudeIds.add(resumeId);
		}

		this._persistOpenSessions();
		this._postMessage({
			type: "terminal-session-created",
			sessionId: info.id,
			name: info.name,
			claudeId: resumeId || null,
			...(restoring ? { restoring: true } : {}),
		} as ExtensionToWebviewMessage);
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

	/** Check if a claude session has a lazy placeholder in the webview (restored but no PTY) */
	isLazyPlaceholder(claudeId: string): boolean {
		return this._restored && this._allOpenClaudeIds.has(claudeId) && this.findPtyByClaudeId(claudeId) === null;
	}

	sendOpenSessionIds(): void {
		const openClaudeIds = [...this._allOpenClaudeIds];
		const ptyIds = new Set(this._ptyToClaudeId.values());
		const lazyClaudeIds = openClaudeIds.filter((id) => !ptyIds.has(id));
		log.log(`sendOpenSessionIds: [${openClaudeIds.map((id) => id.slice(0, 8)).join(", ")}], lazy=[${lazyClaudeIds.map((id) => id.slice(0, 8)).join(", ")}]`);
		this._postMessage({ type: "open-sessions-update", openClaudeIds, lazyClaudeIds });
	}

	removeOpenSession(ptySessionId: number): void {
		log.log(
			`removeOpenSession: pty=${ptySessionId}, claude=${this._ptyToClaudeId.get(ptySessionId) || "?"}`,
		);
		const claudeId = this._ptyToClaudeId.get(ptySessionId);
		this._ptyToClaudeId.delete(ptySessionId);
		if (claudeId) this._allOpenClaudeIds.delete(claudeId);
		this._persistOpenSessions();
	}

	/** Remove an open session by claude ID (works for lazy placeholders without PTY) */
	removeOpenSessionByClaudeId(claudeId: string): void {
		log.log(`removeOpenSessionByClaudeId: ${claudeId.slice(0, 8)}`);
		this._allOpenClaudeIds.delete(claudeId);
		// Also clean up PTY mapping if one exists
		for (const [ptyId, cId] of this._ptyToClaudeId) {
			if (cId === claudeId) {
				this._ptyToClaudeId.delete(ptyId);
				break;
			}
		}
		this._persistOpenSessions();
	}

	persistActiveSession(claudeId: string | null): void {
		log.log(`persistActiveSession: ${claudeId || "none"}`);
		this._workspaceState?.update("ccr.activeSession", claudeId || null);
	}

	restoreSessions(): void {
		if (this._restored) {
			log.log("restoreSessions: already restored, skipping");
			return;
		}
		this._restored = true;
		const t0 = Date.now();
		const ids = [...new Set(this._workspaceState?.get<string[]>("ccr.openSessions") || [])];
		const activeClaudeId = this._workspaceState?.get<string>("ccr.activeSession") || null;
		log.log(
			`restoreSessions: ${ids.length} sessions to restore: [${ids.join(", ")}], active=${activeClaudeId || "none"}`,
		);

		// Only start PTY for the active session; others get placeholder tabs
		const activeId = activeClaudeId && ids.includes(activeClaudeId) ? activeClaudeId : ids[0];

		// Register all IDs as open before starting any PTYs
		for (const claudeId of ids) {
			this._allOpenClaudeIds.add(claudeId);
		}

		for (const claudeId of ids) {
			// Skip if already opened (e.g., user clicked resume before restore ran)
			if (this.findPtyByClaudeId(claudeId) !== null) {
				log.log(`restoreSessions: ${claudeId.slice(0, 8)} already has PTY, skipping`);
				continue;
			}
			if (claudeId === activeId) {
				this.startNewClaudeSession(claudeId, true);
			} else {
				// Send placeholder tab without spawning PTY
				log.log(`restoreSessions: lazy placeholder for ${claudeId.slice(0, 8)}`);
				this._postMessage({
					type: "terminal-session-created",
					sessionId: -1, // sentinel — no real PTY yet
					name: `resume:${claudeId.slice(0, 8)}`,
					claudeId,
					restoring: true,
					lazy: true,
				} as ExtensionToWebviewMessage);
			}
		}

		this._persistOpenSessions();
		this.sendOpenSessionIds();
		log.log(`restoreSessions: ${ids.length} restored (1 active, ${ids.length - 1} lazy) in ${Date.now() - t0}ms`);

		// Activate the real session
		const activePtyId = this.findPtyByClaudeId(activeId);
		if (activePtyId !== null) {
			log.log(`restoreSessions: activating active session pty #${activePtyId}`);
			this._postMessage({
				type: "activate-terminal",
				sessionId: activePtyId,
			});
		}
	}

	/** Spawn a real PTY for a lazy placeholder tab */
	lazyResume(claudeId: string, placeholderPtyId: number): void {
		// Check not already loaded
		if (this.findPtyByClaudeId(claudeId) !== null) {
			log.log(`lazyResume: ${claudeId.slice(0, 8)} already has a PTY, activating`);
			const ptyId = this.findPtyByClaudeId(claudeId)!;
			this._postMessage({ type: "activate-terminal", sessionId: ptyId });
			return;
		}

		const cli = vscode.workspace
			.getConfiguration("claudeCodeReview")
			.get<string>("cliCommand", "claude");
		const cmd = `${cli} --resume ${claudeId}`;
		log.log(`lazyResume: spawning ${claudeId.slice(0, 8)}, cmd=${cmd}`);

		const info = this._ptyManager.createSession(
			`resume:${claudeId.slice(0, 8)}`,
			cmd,
		);
		this._ptyToClaudeId.set(info.id, claudeId);
		this._allOpenClaudeIds.add(claudeId);
		this._persistOpenSessions();

		// Tell webview to replace placeholder with real session
		this._postMessage({
			type: "lazy-session-ready",
			placeholderPtyId,
			realPtyId: info.id,
			claudeId,
		} as ExtensionToWebviewMessage);

		this.sendOpenSessionIds();
		state.refreshAll();
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

		const tryDetect = (): boolean => {
			if (this._ptyToClaudeId.has(ptyId)) return true;
			try {
				const files = fs
					.readdirSync(sessionsDir)
					.filter((f) => f.endsWith(".jsonl"));

				for (const file of files) {
					const sessionId = file.replace(".jsonl", "");
					if (existingFiles.has(sessionId)) continue;

					// Only consider files created/modified after our PTY started
					const stat = fs.statSync(`${sessionsDir}/${file}`);
					if (stat.mtimeMs < createdAt - 2000) continue;

					log.log(`detected new claude session: ${sessionId.slice(0, 8)} for pty #${ptyId}`);
					this._ptyToClaudeId.set(ptyId, sessionId);
					this._allOpenClaudeIds.add(sessionId);
					this._persistOpenSessions();
					this._postMessage({
						type: "update-terminal-claude-id",
						sessionId: ptyId,
						claudeId: sessionId,
					});
					this.refreshClaudeSessions();
					return true;
				}
			} catch {}
			return false;
		};

		// Poll every 2s for up to 60 seconds
		let attempts = 0;
		const interval = setInterval(() => {
			attempts++;
			if (attempts > 30 || tryDetect()) {
				clearInterval(interval);
				if (attempts > 30) {
					log.log(`_detectNewSessionId: timed out for pty #${ptyId} after 60s`);
				}
			}
		}, 2000);

		// Also use fs.watch for faster detection
		try {
			if (fs.existsSync(sessionsDir)) {
				const watcher = fs.watch(sessionsDir, (event, filename) => {
					if (filename?.endsWith(".jsonl") && tryDetect()) {
						watcher.close();
						clearInterval(interval);
					}
				});
				// Clean up watcher after timeout
				setTimeout(() => { try { watcher.close(); } catch {} }, 62000);
			}
		} catch {}
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
					if (this._allOpenClaudeIds.has(sessionId)) {
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
		if (this._namesDebounce) clearTimeout(this._namesDebounce);
		if (this._jsonlDebounce) clearTimeout(this._jsonlDebounce);
		this._namesDebounce = null;
		this._jsonlDebounce = null;
		this._namesWatcher?.close();
		this._namesWatcher = null;
	}

	private _syncTabNames(): void {
		const names = loadSessionNames(this._wp);
		for (const claudeId of this._allOpenClaudeIds) {
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
		const ids = [...this._allOpenClaudeIds];
		log.log(`persistOpenSessions: ${ids.length} sessions saved`);
		this._workspaceState?.update("ccr.openSessions", ids);
	}

	private _detectMcpServers(): string[] {
		try {
			const mcpPath = path.join(this._wp, ".mcp.json");
			if (!fs.existsSync(mcpPath)) return [];
			const content = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
			const servers = content?.mcpServers || {};
			return Object.keys(servers);
		} catch {
			return [];
		}
	}
}
