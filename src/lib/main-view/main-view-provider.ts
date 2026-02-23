import * as vscode from "vscode";
import * as log from "../log";
import { archiveSession } from "../sessions";
import type { PtyManager } from "../pty-manager";
import type { ReviewManager } from "../review-manager";
import type { HookStatus, ExtensionToWebviewMessage } from "../../types";
import { buildWebviewHtml } from "./html-builder";
import { SessionManager } from "./session-manager";
import { handleWebviewMessage } from "./message-handler";
import { buildStateUpdate, getKeybindings } from "./state-updater";

export class MainViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = "claudeCodeReview.mainView";

	private _view: vscode.WebviewView | null = null;
	private _webviewReady = false;
	private _pendingHookStatus: HookStatus | null = null;
	private readonly _sessionMgr: SessionManager;
	private _reviewManager: ReviewManager | undefined;

	constructor(
		private readonly _wp: string,
		private readonly _extensionUri: vscode.Uri,
		private readonly _ptyManager: PtyManager,
		workspaceState: vscode.Memento | undefined,
	) {
		this._sessionMgr = new SessionManager(_wp, _ptyManager, workspaceState, (msg) =>
			this._postMessage(msg),
		);
		this._sessionMgr.watchSessionNames();
	}

	dispose(): void {
		this._sessionMgr.dispose();
	}

	setReviewManager(rm: ReviewManager): void {
		this._reviewManager = rm;
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		log.log("webview resolved");
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri, vscode.Uri.file(vscode.env.appRoot)],
		};

		webviewView.webview.html = buildWebviewHtml(webviewView.webview, this._extensionUri);

		webviewView.webview.onDidReceiveMessage((msg: Record<string, unknown>) => {
			const result = handleWebviewMessage(msg, {
				sessionMgr: this._sessionMgr,
				ptyManager: this._ptyManager,
				wp: this._wp,
				postMessage: (m) => this._postMessage(m),
				getKeybindings,
				webviewReady: this._webviewReady,
				pendingHookStatus: this._pendingHookStatus,
			});
			this._webviewReady = result.webviewReady;
			this._pendingHookStatus = result.pendingHookStatus;
		});
	}

	refreshClaudeSessions(): void {
		this._sessionMgr.refreshClaudeSessions();
	}

	startNewClaudeSession(resumeId?: string): void {
		this._sessionMgr.startNewClaudeSession(resumeId);
	}

	removeOpenSession(ptySessionId: number): void {
		this._sessionMgr.removeOpenSession(ptySessionId);
	}

	sendHookStatus(status: HookStatus): void {
		log.log(`sendHookStatus: ${status}, webviewReady=${this._webviewReady}`);
		if (this._webviewReady) {
			this._postMessage({ type: "hook-status", status });
		} else {
			this._pendingHookStatus = status;
		}
	}

	sendSelectionToTerminal(text: string): void {
		this._postMessage({ type: "insert-text", text });
	}

	sendTerminalOutput(sessionId: number, data: string): void {
		const plain = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
		if (plain.includes("No conversation found")) {
			log.log(`Terminal error detected: session=${sessionId}, "No conversation found"`);
			const claudeId = this._sessionMgr.getPtyToClaudeId().get(sessionId);
			if (claudeId) {
				archiveSession(this._wp, claudeId);
			}
			this._postMessage({
				type: "terminal-error",
				sessionId,
				error: "session-not-found",
			});
		}
		this._postMessage({ type: "terminal-output", sessionId, data });
	}

	sendTerminalExit(sessionId: number, code: number): void {
		this._postMessage({
			type: "terminal-exit",
			sessionId,
			exitCode: code,
		});
	}

	update(): void {
		this._sendStateUpdate();
	}

	private _sendStateUpdate(): void {
		const payload = buildStateUpdate(this._wp, this._ptyManager, this._reviewManager);
		this._postMessage({
			type: "state-update",
			review: payload.review,
			activeSessions: payload.activeSessions,
		});
	}

	private _postMessage(msg: ExtensionToWebviewMessage): void {
		this._view?.webview?.postMessage(msg);
	}
}
