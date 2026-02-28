import * as vscode from "vscode";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import * as log from "../log";
import { fileLog } from "../file-logger";
import * as state from "../state";
import { readClaudeSettings, readClaudeSettingsScoped, writeClaudeSetting, writeClaudeRuntimeState, trustProject } from "../claude-settings";
import type { SettingsScope } from "../claude-settings";
import {
	deleteSession,
	archiveSession,
	unarchiveSession,
	listArchivedSessions,
	saveSessionName,
} from "../sessions";
import type { PtyManager } from "../pty-manager";
import type { SessionManager } from "./session-manager";
import type { KeybindingInfo, HookStatus, ExtensionToWebviewMessage } from "../../types";
import type { ImageTracker } from "./image-tracker";

export { ImageTracker } from "./image-tracker";

export interface MessageContext {
	sessionMgr: SessionManager;
	ptyManager: PtyManager;
	wp: string;
	postMessage: (msg: ExtensionToWebviewMessage) => void;
	getKeybindings: () => KeybindingInfo[];
	webviewReady: boolean;
	pendingHookStatus: HookStatus | null;
	workspaceState?: vscode.Memento;
	imageTracker: ImageTracker;
}

export interface MessageResult {
	webviewReady: boolean;
	pendingHookStatus: HookStatus | null;
}

/**
 * Resolve clipboard contents for terminal paste, mimicking native terminal behavior (iTerm2).
 *
 * On macOS, when a file is copied in Finder, NSPasteboard contains:
 *   - «class furl» — full POSIX path (e.g., /Users/x/file.txt)
 *   - text/plain   — just the filename (file.txt)
 *   - image types  — file icon rendered by Finder (NOT the file content)
 *
 * When a screenshot is taken (Cmd+Shift+4), NSPasteboard contains:
 *   - «class PNGf» — PNG image data
 *   - NO furl, NO text
 *
 * Returns: { type: "text", text } for file paths and regular text,
 *          { type: "image", tmpPath } for screenshots saved to a temp file.
 */
export async function resolveClipboard(): Promise<{ type: "text"; text: string } | { type: "image"; tmpPath: string } | null> {
	if (process.platform === "darwin") {
		// 1. Try file URL — full path from Finder copy
		// Validate: real file paths start with /, contain no newlines, and exist on disk.
		// Rich text from editors can produce spurious furl results.
		try {
			const filePath = cp.execSync(
				`osascript -e 'try' -e 'set theFiles to POSIX path of (the clipboard as «class furl»)' -e 'return theFiles' -e 'end try'`,
				{ encoding: "utf8", timeout: 2000 },
			).trim();
			if (filePath && filePath.startsWith("/") && !filePath.includes("\n") && fs.existsSync(filePath)) {
				log.log(`clipboard: file path via osascript: "${filePath}"`);
				return { type: "text", text: filePath };
			}
			if (filePath) {
				log.log(`clipboard: furl rejected (not a valid file path): "${filePath.slice(0, 80)}"`);
			}
		} catch {
			// No file URL — continue
		}

		// 2. Try plain text
		const text = await vscode.env.clipboard.readText();
		if (text) {
			return { type: "text", text };
		}

		// 3. No text — try image (screenshot)
		try {
			const tmpFile = path.join(os.tmpdir(), `ccr-paste-${Date.now()}.png`);
			cp.execSync(
				`osascript -e 'try' -e 'set imgData to the clipboard as «class PNGf»' -e 'set fp to open for access POSIX file "${tmpFile}" with write permission' -e 'write imgData to fp' -e 'close access fp' -e 'return "ok"' -e 'on error' -e 'return ""' -e 'end try'`,
				{ encoding: "utf8", timeout: 3000 },
			);
			if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 0) {
				log.log(`clipboard: screenshot saved to ${tmpFile}`);
				return { type: "image", tmpPath: tmpFile };
			}
		} catch {
			// No image in clipboard
		}

		return null;
	}

	// Non-macOS: just read text
	const text = await vscode.env.clipboard.readText();
	return text ? { type: "text", text } : null;
}

export function handleWebviewMessage(
	msg: Record<string, unknown>,
	ctx: MessageContext,
): MessageResult {
	if (msg.type !== "terminal-input" && msg.type !== "terminal-resize" && msg.type !== "diag-log") {
		log.log(`webview msg: ${msg.type as string}`);
	}

	let webviewReady = ctx.webviewReady;
	let pendingHookStatus = ctx.pendingHookStatus;

	switch (msg.type) {
		case "webview-ready":
			log.log("webview ready, sending sessions list");
			webviewReady = true;
			ctx.sessionMgr.refreshClaudeSessions();
			// Refresh review state in case restore() completed before webview was ready
			state.refreshAll();
			const termConfig = vscode.workspace.getConfiguration("claudeCodeReview");
			ctx.postMessage({
				type: "settings-init",
				cliCommand: termConfig.get<string>("cliCommand", "claude"),
				keybindings: ctx.getKeybindings(),
				claudeSettings: readClaudeSettings(ctx.wp),
				terminalSettings: {
					notificationMode: termConfig.get<string>("notificationMode", "notifications_sound"),
				},
			});
			if (pendingHookStatus) {
				log.log(`sending pending hook status: ${pendingHookStatus}`);
				ctx.postMessage({
					type: "hook-status",
					status: pendingHookStatus,
				});
				pendingHookStatus = null;
			}
			// Restore saved view mode (sessions list vs terminals)
			{
				const savedViewMode = ctx.workspaceState?.get<string>("ccr.viewMode") || "sessions";
				log.log(`webview-ready: restoring viewMode=${savedViewMode}`);
				ctx.postMessage({ type: "restore-view-mode", mode: savedViewMode });
			}
			break;

		case "set-view-mode":
			log.log(`set-view-mode: ${msg.mode as string}`);
			ctx.workspaceState?.update("ccr.viewMode", msg.mode as string);
			break;

		case "request-restore-sessions":
			log.log("request-restore-sessions: lazy restoring sessions");
			ctx.sessionMgr.restoreSessions();
			break;

		case "lazy-resume": {
			const lazyClaudeId = msg.claudeId as string;
			const placeholderPtyId = msg.placeholderPtyId as number;
			fileLog.log("session", `lazy-resume msg`, { claudeId: lazyClaudeId, placeholderPtyId });
			ctx.sessionMgr.lazyResume(lazyClaudeId, placeholderPtyId);
			break;
		}

		case "new-claude-session":
			ctx.sessionMgr.startNewClaudeSession();
			break;

		case "onboarding-complete": {
			log.log(`onboarding-complete: installHooks=${msg.installHooks}`);
			trustProject(ctx.wp);
			if (msg.installHooks) {
				const { doInstall } = require("../hooks") as typeof import("../hooks");
				doInstall(ctx.wp, (status) => ctx.postMessage({ type: "hook-status", status }));
			}
			ctx.sessionMgr.resumePendingSession();
			break;
		}


		case "resume-claude-session": {
			const claudeSessionId = msg.claudeSessionId as string;
			const existingPtyId = ctx.sessionMgr.findPtyByClaudeId(claudeSessionId);
			if (existingPtyId !== null) {
				// Already has a real PTY — just activate
				log.log(
					`resume: session ${claudeSessionId.slice(0, 8)} already open as pty #${existingPtyId}, activating`,
				);
				ctx.postMessage({
					type: "activate-terminal",
					sessionId: existingPtyId,
				});
			} else if (ctx.sessionMgr.isLazyPlaceholder(claudeSessionId)) {
				// Lazy placeholder exists in webview — trigger activation
				log.log(`resume: session ${claudeSessionId.slice(0, 8)} is lazy, activating placeholder`);
				ctx.postMessage({
					type: "activate-lazy-session",
					claudeId: claudeSessionId,
				});
			} else {
				log.log(`resume: opening session ${claudeSessionId.slice(0, 8)}`);
				ctx.sessionMgr.startNewClaudeSession(claudeSessionId);
			}
			break;
		}

		case "refresh-sessions":
			ctx.sessionMgr.refreshClaudeSessions();
			break;

		case "rename-session": {
			const claudeId = msg.sessionId as string;
			const newName = msg.newName as string;
			log.log(`rename: ${claudeId.slice(0, 8)} -> "${newName}"`);
			try {
				saveSessionName(ctx.wp, claudeId, newName);
				log.log(`rename: ${claudeId.slice(0, 8)} saved to session-names.json`);
				ctx.postMessage({ type: "rename-result", claudeId, newName, success: true });
				ctx.sessionMgr.refreshClaudeSessions();
			} catch (err) {
				log.log(`rename: ${claudeId.slice(0, 8)} failed — ${(err as Error).message}`);
				ctx.postMessage({ type: "rename-result", claudeId, newName, success: false });
			}
			break;
		}

		case "delete-session": {
			const sessionId = msg.sessionId as string;
			log.log(`delete: ${sessionId.slice(0, 8)}`);
			// Close PTY if session is open (works for lazy sessions too)
			const ptyId = ctx.sessionMgr.findPtyByClaudeId(sessionId);
			if (ptyId !== null) {
				ctx.ptyManager.closeSession(ptyId);
				ctx.postMessage({ type: "terminal-session-closed", sessionId: ptyId });
			}
			ctx.sessionMgr.removeOpenSessionByClaudeId(sessionId);
			ctx.sessionMgr.sendOpenSessionIds();
			deleteSession(ctx.wp, sessionId);
			ctx.sessionMgr.refreshClaudeSessions();
			break;
		}

		case "archive-session": {
			const sessionId = msg.sessionId as string;
			log.log(`archive: ${sessionId.slice(0, 8)}`);
			archiveSession(ctx.wp, sessionId);
			ctx.sessionMgr.refreshClaudeSessions();
			break;
		}

		case "unarchive-session": {
			const sessionId = msg.sessionId as string;
			log.log(`unarchive: ${sessionId.slice(0, 8)}`);
			unarchiveSession(ctx.wp, sessionId);
			ctx.sessionMgr.refreshClaudeSessions();
			break;
		}

		case "load-archived-sessions": {
			const sessions = listArchivedSessions(ctx.wp);
			ctx.postMessage({ type: "archived-sessions-list", sessions });
			break;
		}

		case "blocked-slash-command":
			vscode.window.showWarningMessage(
				`${msg.command as string} is disabled in embedded sessions. Use UI controls instead.`,
			);
			break;

		case "terminal-input":
			ctx.ptyManager.writeToSession(msg.sessionId as number, msg.data as string);
			break;

		case "read-clipboard": {
			const clipSessionId = msg.sessionId as number;
			resolveClipboard().then((result) => {
				if (!result) {
					log.log(`read-clipboard: session #${clipSessionId}, clipboard empty`);
					return;
				}
				if (result.type === "text") {
					log.log(`read-clipboard: session #${clipSessionId}, text len=${result.text.length}, "${result.text.slice(0, 80)}"`);
					ctx.ptyManager.writeToSession(clipSessionId, `\x1b[200~${result.text}\x1b[201~`);
					// If pasted text is a path to an image file, register it for preview
					const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"];
					const textLower = result.text.trim().toLowerCase();
					if (imageExts.some(ext => textLower.endsWith(ext))) {
						try {
							const imgPath = result.text.trim();
							if (fs.existsSync(imgPath)) {
								const base64 = fs.readFileSync(imgPath).toString("base64");
								const mimeType = textLower.endsWith(".png") ? "image/png" : "image/jpeg";
								ctx.imageTracker.enqueue(clipSessionId, imgPath, base64, mimeType);
								ctx.postMessage({ type: "image-pending", base64, mimeType, filePath: imgPath, ptyId: clipSessionId });
								log.log(`read-clipboard: enqueued image from text path`);
							}
						} catch (err) {
							log.log(`read-clipboard: image register from text failed: ${(err as Error).message}`);
						}
					}
				} else {
					// Image (screenshot) — send temp file path so Claude CLI reads it
					log.log(`read-clipboard: session #${clipSessionId}, image at ${result.tmpPath}`);
					ctx.ptyManager.writeToSession(clipSessionId, `\x1b[200~${result.tmpPath}\x1b[201~`);
					// Enqueue image for binding when CLI outputs [Image #N]
					try {
						const base64 = fs.readFileSync(result.tmpPath).toString("base64");
						const mimeType = result.tmpPath.endsWith(".png") ? "image/png" : "image/jpeg";
						ctx.imageTracker.enqueue(clipSessionId, result.tmpPath, base64, mimeType);
						ctx.postMessage({ type: "image-pending", base64, mimeType, filePath: result.tmpPath, ptyId: clipSessionId });
					} catch (err) {
						log.log(`read-clipboard: image enqueue failed: ${(err as Error).message}`);
					}
				}
			});
			break;
		}

		case "terminal-resize":
			ctx.ptyManager.resizeSession(
				msg.sessionId as number,
				msg.cols as number,
				msg.rows as number,
			);
			break;

		case "close-terminal": {
			const ptyId = msg.sessionId as number;
			const claudeIdForClose = msg.claudeId as string | undefined;
			fileLog.log("terminal", `close: pty #${ptyId}`, { claudeId: claudeIdForClose || null });
			ctx.ptyManager.closeSession(ptyId);
			if (claudeIdForClose) {
				ctx.sessionMgr.removeOpenSessionByClaudeId(claudeIdForClose);
			} else {
				ctx.sessionMgr.removeOpenSession(ptyId);
			}
			ctx.postMessage({
				type: "terminal-session-closed",
				sessionId: ptyId,
			});
			ctx.sessionMgr.sendOpenSessionIds();
			state.refreshAll();
			break;
		}

		case "close-session-by-claude-id": {
			const claudeSessionId = msg.claudeSessionId as string;
			const ptyId = ctx.sessionMgr.findPtyByClaudeId(claudeSessionId);
			if (ptyId !== null) {
				ctx.ptyManager.closeSession(ptyId);
			}
			// Remove from both PTY map and allOpenClaudeIds (works for lazy sessions too)
			ctx.sessionMgr.removeOpenSessionByClaudeId(claudeSessionId);
			ctx.postMessage({
				type: "terminal-session-closed",
				sessionId: ptyId ?? -1,
			});
			ctx.sessionMgr.sendOpenSessionIds();
			state.refreshAll();
			break;
		}

		case "start-review":
			vscode.commands.executeCommand("ccr.openReview");
			break;

		case "accept-file": {
			const actions = require("../actions") as typeof import("../actions");
			actions.resolveAllHunks(msg.filePath as string, true);
			break;
		}

		case "reject-file": {
			const actions = require("../actions") as typeof import("../actions");
			actions.resolveAllHunks(msg.filePath as string, false);
			break;
		}

		case "go-to-file": {
			const actions = require("../actions") as typeof import("../actions");
			actions.openFileForReview(msg.filePath as string);
			break;
		}

		case "prev-file": {
			const actions = require("../actions") as typeof import("../actions");
			actions.navigateFile(-1);
			break;
		}

		case "next-file": {
			const actions = require("../actions") as typeof import("../actions");
			actions.navigateFile(1);
			break;
		}

		case "accept-all":
			vscode.commands.executeCommand("ccr.acceptAll");
			break;

		case "reject-all":
			vscode.commands.executeCommand("ccr.rejectAll");
			break;

		case "open-terminal":
			vscode.commands.executeCommand("workbench.action.terminal.toggleTerminal");
			break;

		case "git-status":
			vscode.commands.executeCommand("workbench.action.terminal.new").then(() => {
				setTimeout(() => {
					const t = vscode.window.activeTerminal;
					if (t) t.sendText("git status");
				}, 200);
			});
			break;

		case "paste-image": {
			const mimeType = msg.mimeType as string;
			const ext =
				mimeType === "image/png" ? ".png" : mimeType === "image/jpeg" ? ".jpg" : ".png";
			const tmpFile = path.join(os.tmpdir(), `ccr-paste-${Date.now()}${ext}`);
			try {
				fs.writeFileSync(tmpFile, Buffer.from(msg.data as string, "base64"));
				log.log(`paste-image: saved to ${tmpFile}`);
				ctx.ptyManager.writeToSession(msg.sessionId as number, tmpFile);
				// Enqueue image for binding when CLI outputs [Image #N]
				const pasteSessionId = msg.sessionId as number;
				ctx.imageTracker.enqueue(pasteSessionId, tmpFile, msg.data as string, mimeType);
				ctx.postMessage({ type: "image-pending", base64: msg.data as string, mimeType, filePath: tmpFile, ptyId: pasteSessionId });
			} catch (err) {
				log.log(`paste-image error: ${(err as Error).message}`);
			}
			break;
		}

		case "install-hook":
			vscode.commands.executeCommand("ccr.installHook");
			break;

		case "check-hook-status": {
			const { checkAndPrompt } = require("../hooks") as typeof import("../hooks");
			const hookStatus = checkAndPrompt(ctx.wp);
			ctx.postMessage({ type: "hook-status", status: hookStatus });
			break;
		}

		case "open-keybindings":
			log.log("open-keybindings: opening VS Code keyboard shortcuts");
			vscode.commands.executeCommand(
				"workbench.action.openGlobalKeybindings",
				"Claude Code Review",
			);
			break;

		case "set-active-session": {
			const claudeId = (msg.claudeId as string | null) || null;
			ctx.sessionMgr.persistActiveSession(claudeId);
			break;
		}

		case "set-claude-setting": {
			const scope = (msg.scope as SettingsScope) || "global";
			log.log(`set-claude-setting [${scope}]: ${msg.key as string} = ${JSON.stringify(msg.value)}`);
			writeClaudeSetting(msg.key as string, msg.value, scope, ctx.wp);
			// Send back updated settings so UI shows effective values
			ctx.postMessage({
				type: "claude-settings-update",
				claudeSettings: readClaudeSettings(ctx.wp),
			});
			break;
		}

		case "set-claude-runtime": {
			log.log(`set-claude-runtime: ${msg.key as string} = ${JSON.stringify(msg.value)}`);
			writeClaudeRuntimeState(msg.key as string, msg.value);
			ctx.postMessage({
				type: "claude-settings-update",
				claudeSettings: readClaudeSettings(ctx.wp),
			});
			break;
		}

		case "get-claude-settings-scoped": {
			const reqScope = (msg.scope as SettingsScope) || "global";
			ctx.postMessage({
				type: "claude-settings-scoped",
				scope: reqScope,
				settings: readClaudeSettingsScoped(reqScope, ctx.wp),
			});
			break;
		}

		case "set-terminal-setting":
			log.log(`set-terminal-setting: ${msg.key as string} = ${JSON.stringify(msg.value)}`);
			vscode.workspace
				.getConfiguration("claudeCodeReview")
				.update(msg.key as string, msg.value, true);
			break;

		case "set-cli-command":
			log.log(`set-cli-command: ${msg.value as string}`);
			vscode.workspace
				.getConfiguration("claudeCodeReview")
				.update("cliCommand", msg.value as string, true);
			break;

		// --- New message handlers for toolbar ---

		case "undo-review":
			vscode.commands.executeCommand("ccr.undo");
			break;

		case "redo-review":
			vscode.commands.executeCommand("ccr.redo");
			break;

		case "keep-current-file":
			vscode.commands.executeCommand("ccr.keepCurrentFile");
			break;

		case "undo-current-file":
			vscode.commands.executeCommand("ccr.undoCurrentFile");
			break;

		case "navigate-hunk": {
			const actions = require("../actions") as typeof import("../actions");
			actions.navigateHunk(msg.direction as -1 | 1);
			break;
		}

		case "review-next-file": {
			const actions = require("../actions") as typeof import("../actions");
			actions.reviewNextUnresolved();
			break;
		}

		case "accept-all-confirm":
			vscode.commands.executeCommand("ccr.acceptAll");
			break;

		case "reject-all-confirm":
			vscode.commands.executeCommand("ccr.rejectAll");
			break;

		case "dismiss-all-confirm":
			vscode.commands.executeCommand("ccr.dismissAll");
			break;

		case "open-external-url":
			vscode.env.openExternal(vscode.Uri.parse(msg.url as string));
			break;

		case "open-image": {
			const imgPath = ctx.imageTracker.getImagePath(msg.index as number);
			if (imgPath) {
				vscode.commands.executeCommand("vscode.open", vscode.Uri.file(imgPath));
			}
			break;
		}

		case "bind-image": {
			const cliIdx = msg.cliIndex as number;
			const bindPtyId = msg.ptyId as number;
			const pending = ctx.imageTracker.shiftPending(bindPtyId);
			if (pending) {
				ctx.imageTracker.bind(cliIdx, pending.filePath);
				log.log(`bind-image: pty#${bindPtyId} CLI #${cliIdx} → ${pending.filePath}`);
			} else {
				log.log(`bind-image: pty#${bindPtyId} CLI #${cliIdx} — no pending image`);
			}
			break;
		}

		case "open-file-link": {
			let filePath = msg.path as string;
			// Expand ~ to home directory
			if (filePath.startsWith("~/")) {
				filePath = path.join(os.homedir(), filePath.slice(2));
			}
			log.log(`open-file-link: path="${filePath}", line=${msg.line}, col=${msg.column}`);
			const candidates: string[] = [];

			if (path.isAbsolute(filePath)) {
				candidates.push(filePath);
			} else {
				candidates.push(path.join(ctx.wp, filePath));
				for (const folder of vscode.workspace.workspaceFolders || []) {
					const candidate = path.join(folder.uri.fsPath, filePath);
					if (!candidates.includes(candidate)) candidates.push(candidate);
				}
			}

			log.log(`open-file-link: candidates=${JSON.stringify(candidates)}`);
			(async () => {
				for (const absPath of candidates) {
					try {
						const uri = vscode.Uri.file(absPath);
						await vscode.workspace.fs.stat(uri);
						log.log(`open-file-link: found ${absPath}`);
						const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp", ".ico"];
						const ext = path.extname(absPath).toLowerCase();
						if (imageExts.includes(ext)) {
							await vscode.commands.executeCommand("vscode.open", uri);
							return;
						}
						const doc = await vscode.workspace.openTextDocument(absPath);
						const editor = await vscode.window.showTextDocument(doc);
						if (msg.line) {
							const pos = new vscode.Position(
								(msg.line as number) - 1,
								((msg.column as number) || 1) - 1,
							);
							editor.selection = new vscode.Selection(pos, pos);
							editor.revealRange(
								new vscode.Range(pos, pos),
								vscode.TextEditorRevealType.InCenter,
							);
						}
						return;
					} catch (err) {
						log.log(`open-file-link: miss ${absPath}: ${(err as Error).message}`);
					}
				}
				log.log(`open-file-link: no candidates matched for "${filePath}"`);
				vscode.window.showWarningMessage(`File not found: ${filePath}`);
			})();
			break;
		}

		case "diag-log": {
			const diagCat = msg.category as string;
			const diagMsg = msg.message as string;
			const diagData = msg.data as Record<string, unknown>;
			fileLog.log("webview", `[${diagCat}] ${diagMsg}`, diagData);
			break;
		}
	}

	return { webviewReady, pendingHookStatus };
}
