import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as log from "../log";
import * as state from "../state";
import { isProjectTrusted } from "../claude-settings";
import { isHookInstalled } from "../hooks";
import { listSessions } from "../sessions";
import { detectNewSessionId } from "./session-detector";
import { SessionNameWatcher } from "./session-name-watcher";
import type { PtyManager } from "../pty-manager";
import type { ExtensionToWebviewMessage } from "../../types";

export class SessionManager {
	private readonly _ptyToClaudeId = new Map<number, string>();
	/** All open claude IDs (real PTY + lazy placeholders). Source of truth for persistence & UI. */
	private readonly _allOpenClaudeIds = new Set<string>();
	private _restored = false;
	private _pendingSession: { resumeId?: string; restoring?: boolean } | null = null;
	private readonly _nameWatcher: SessionNameWatcher;

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

		this._nameWatcher = new SessionNameWatcher(this._wp, {
			postRename: (claudeId, newName) => {
				this._postMessage({ type: "rename-terminal-tab", claudeId, newName });
			},
			refreshSessions: () => this.refreshClaudeSessions(),
			getOpenIds: () => this._allOpenClaudeIds,
		});
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
			detectNewSessionId(this._wp, info.id, {
				isAlreadyBound: (ptyId) => this._ptyToClaudeId.has(ptyId),
				onDetected: (ptyId, sessionId) => {
					this._ptyToClaudeId.set(ptyId, sessionId);
					this._allOpenClaudeIds.add(sessionId);
					this._persistOpenSessions();
					this._postMessage({
						type: "update-terminal-claude-id",
						sessionId: ptyId,
						claudeId: sessionId,
					});
					this.refreshClaudeSessions();
				},
			});
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

		const activeId = activeClaudeId && ids.includes(activeClaudeId) ? activeClaudeId : ids[0];

		for (const claudeId of ids) {
			this._allOpenClaudeIds.add(claudeId);
		}

		for (const claudeId of ids) {
			if (this.findPtyByClaudeId(claudeId) !== null) {
				log.log(`restoreSessions: ${claudeId.slice(0, 8)} already has PTY, skipping`);
				continue;
			}
			if (claudeId === activeId) {
				this.startNewClaudeSession(claudeId, true);
			} else {
				log.log(`restoreSessions: lazy placeholder for ${claudeId.slice(0, 8)}`);
				this._postMessage({
					type: "terminal-session-created",
					sessionId: -1,
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

		const activePtyId = this.findPtyByClaudeId(activeId);
		if (activePtyId !== null) {
			log.log(`restoreSessions: activating active session pty #${activePtyId}`);
			this._postMessage({ type: "activate-terminal", sessionId: activePtyId });
		}
	}

	/** Spawn a real PTY for a lazy placeholder tab */
	lazyResume(claudeId: string, placeholderPtyId: number): void {
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

	watchSessionNames(): void {
		this._nameWatcher.start();
	}

	dispose(): void {
		this._nameWatcher.dispose();
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
