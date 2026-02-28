// Claude Code with Review v9.0 — hook-based review + activitybar + Claude CLI sessions
import * as vscode from "vscode";
import * as state from "./lib/state";
import { ReviewCodeLensProvider } from "./lib/codelens";
import { MainViewProvider } from "./lib/main-view";
import { PtyManager } from "./lib/pty-manager";
import { applyDecorations, clearDecorations, initDecorations } from "./lib/decorations";
import * as fs from "fs";
import * as path from "path";
import { startServer, stopServer, setAddFileHandler, setWorkspacePath, setGetActiveReviewHandler, setGetActiveSessionHandler, setPostWebviewMessageHandler } from "./lib/server";
import { checkAndPrompt, doInstall } from "./lib/hooks";
import { ReviewManager } from "./lib/review-manager";
import { registerDocumentListener } from "./lib/document-listener";
import { clearAllHistories, isApplyingEdit, hasUndoState, hasRedoState } from "./lib/undo-history";
import * as actions from "./lib/actions";
import * as log from "./lib/log";
import { fileLog } from "./lib/file-logger";
import { clearReviewState } from "./lib/persistence";
import type { HookStatus, ExtensionToWebviewMessage } from "./types";

let reviewManager: ReviewManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
	log.init();
	log.log("activating...");
	initDecorations(context.extensionPath);

	const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspacePath) {
		log.log("no workspace folder, skipping activation");
		return;
	}
	log.initFileLog(workspacePath);

	fileLog.init(workspacePath);

	try {
		// --- ReviewManager ---
		reviewManager = new ReviewManager(workspacePath);

		// Wire ReviewManager into action modules
		actions.setReviewActionsManager(reviewManager);
		actions.setNavigationManager(reviewManager);
		actions.setFileReviewManager(reviewManager);

		// --- PTY manager ---
		const ptyManager = new PtyManager(workspacePath);
		log.log("PtyManager created");

		// --- Providers ---
		const codeLens = new ReviewCodeLensProvider();
		const mainView = new MainViewProvider(
			workspacePath,
			context.extensionUri,
			ptyManager,
			context.workspaceState,
		);

		state.setCodeLensProvider(codeLens);
		state.setMainView(mainView);
		mainView.setReviewManager(reviewManager);
		reviewManager.setProviders(codeLens, mainView);

		// Wire pty output to webview
		ptyManager.setHandlers(
			(sessionId, data) => mainView.sendTerminalOutput(sessionId, data),
			(sessionId, code, ageMs) => {
				mainView.sendTerminalExit(sessionId, code);
				mainView.removeOpenSession(sessionId);
				state.refreshAll();
				// Quick exit (< 5s) likely means the session is already completed or unavailable
				if (ageMs !== undefined && ageMs < 5000 && code === 0) {
					log.log(`PTY quick exit: session=${sessionId}, age=${ageMs}ms — session likely completed`);
					vscode.window.showWarningMessage(
						"Claude session exited immediately — it may already be completed. Start a new session instead.",
					);
				}
			},
		);

		// --- Register providers ---
		context.subscriptions.push(
			vscode.window.registerWebviewViewProvider("ccr.main", mainView, {
				webviewOptions: { retainContextWhenHidden: true },
			}),
			vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLens),
		);


		// --- Move to secondary sidebar on first install ---
		const movedKey = "ccr.movedToSecondarySidebar";
		if (!context.globalState.get<boolean>(movedKey)) {
			context.globalState.update(movedKey, true);
			setTimeout(async () => {
				try {
					await vscode.commands.executeCommand(
						"vscode.moveViews",
						{ viewIds: ["ccr.main"], destinationId: "workbench.panel.auxiliarybar" },
					);
					// Only focus panel if no terminal is active — avoid stealing focus from CLI
					if (!vscode.window.activeTerminal) {
						await vscode.commands.executeCommand("ccr.main.focus");
					}
				} catch {
					// Command may not exist in older VS Code / Cursor
				}
			}, 1000);
		}

		// --- setContext for keybindings ---
		reviewManager.onReviewStateChange((hasActive) => {
			vscode.commands.executeCommand("setContext", "ccr.reviewActive", hasActive);
		});

		// --- Main status bar button ---
		const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		statusBar.text = "✻ Claude Code Review";
		statusBar.tooltip = "Toggle Claude Code Review panel (Option+Ctrl+B)";
		statusBar.command = "ccr.togglePanel";
		statusBar.show();
		context.subscriptions.push(statusBar);

		// --- Commands ---
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const cmds: Array<[string, (...args: any[]) => any]> = [
			["ccr.togglePanel", () => vscode.commands.executeCommand("ccr.main.focus")],
			["ccr.openReview", () => actions.startReviewSession(workspacePath)],
			[
				"ccr.openFileDiff",
				(item: { filePath?: string } | undefined) =>
					item?.filePath && actions.openFileForReview(item.filePath),
			],
			[
				"ccr.acceptHunk",
				(fp?: string, id?: number) => {
					if (typeof fp === "string" && typeof id === "number") {
						return actions.resolveHunk(fp, id, true);
					}
					// Keyboard shortcut — resolve current hunk
					return resolveCurrentHunk(true);
				},
			],
			[
				"ccr.rejectHunk",
				(fp?: string, id?: number) => {
					if (typeof fp === "string" && typeof id === "number") {
						return actions.resolveHunk(fp, id, false);
					}
					return resolveCurrentHunk(false);
				},
			],
			[
				"ccr.acceptFile",
				(item: { filePath?: string } | undefined) =>
					item?.filePath && actions.resolveAllHunks(item.filePath, true),
			],
			[
				"ccr.rejectFile",
				(item: { filePath?: string } | undefined) =>
					item?.filePath && actions.resolveAllHunks(item.filePath, false),
			],
			[
				"ccr.acceptAll",
				async () => {
					for (const f of [...state.getReviewFiles()]) {
						if (state.activeReviews.has(f)) await actions.resolveAllHunks(f, true);
					}
				},
			],
			[
				"ccr.rejectAll",
				async () => {
					for (const f of [...state.getReviewFiles()]) {
						if (state.activeReviews.has(f)) await actions.resolveAllHunks(f, false);
					}
				},
			],
			[
				"ccr.dismissAll",
				() => {
					if (!reviewManager) return;
					log.log(`dismissAll: clearing ${state.activeReviews.size} reviews`);
					for (const [fp, review] of state.activeReviews) {
						try {
							fs.writeFileSync(fp, review.modifiedContent, "utf8");
						} catch {}
					}
					state.activeReviews.clear();
					reviewManager.reviewFiles = [];
					reviewManager.currentFileIndex = 0;
					clearReviewState(workspacePath);
					clearAllHistories();
					reviewManager.syncState();
					reviewManager.refreshUI();
					reviewManager._onReviewStateChange.fire(false);
					state.refreshAll();
				},
			],
		["ccr.undo", () => {
			const fp = vscode.window.activeTextEditor?.document.uri.fsPath;
			log.logCat("resolve", `ccr.undo COMMAND FIRED — activeFile=${fp?.split("/").pop()}, hasUndo=${fp ? hasUndoState(fp) : "no-editor"}, hasRedo=${fp ? hasRedoState(fp) : "no-editor"}`);
			reviewManager?.undoResolve();
		}],
		["ccr.redo", () => {
			const fp = vscode.window.activeTextEditor?.document.uri.fsPath;
			log.logCat("resolve", `ccr.redo COMMAND FIRED — activeFile=${fp?.split("/").pop()}, hasUndo=${fp ? hasUndoState(fp) : "no-editor"}, hasRedo=${fp ? hasRedoState(fp) : "no-editor"}`);
			reviewManager?.redoResolve();
		}],
		["ccr.prevFile", () => actions.navigateFile(-1)],
			["ccr.nextFile", () => actions.navigateFile(1)],
			["ccr.prevHunk", () => actions.navigateHunk(-1)],
			["ccr.nextHunk", () => actions.navigateHunk(1)],
			["ccr.keepCurrentFile", () => actions.keepCurrentFile()],
			["ccr.undoCurrentFile", () => actions.undoCurrentFile()],
			["ccr.reviewNextUnresolved", () => actions.reviewNextUnresolved()],
			[
				"ccr.sendFileToSession",
				async (uri: vscode.Uri | undefined, uris: vscode.Uri[] | undefined) => {
					const selected = uris && uris.length > 0 ? uris : uri ? [uri] : [];
					if (selected.length === 0) return;
					const paths = selected.map((u) => vscode.workspace.asRelativePath(u));
					const text = " " + paths.join(" ") + " ";
					log.log(`sendFileToSession:${text}`);
					mainView.sendSelectionToTerminal(text);
					await vscode.commands.executeCommand("ccr.main.focus");
				},
			],
			["ccr.newSession", () => mainView.startNewClaudeSession()],
			["ccr.refreshSessions", () => mainView.refreshClaudeSessions()],
			[
				"ccr.sendSelection",
				async () => {
					const editor = vscode.window.activeTextEditor;
					if (!editor) return;
					const sel = editor.selection;
					if (sel.isEmpty) return;
					const relPath = vscode.workspace.asRelativePath(editor.document.uri);
					const startLine = sel.start.line + 1;
					const endLine = sel.end.line + 1;
					const ref =
						startLine === endLine
							? `${relPath}:${startLine}`
							: `${relPath}:${startLine}-${endLine}`;
					log.log(`sendSelection: ${ref}`);
					mainView.sendSelectionToTerminal(" " + ref + " ");
					await vscode.commands.executeCommand("ccr.main.focus");
				},
			],
		];

		for (const [id, handler] of cmds) {
			context.subscriptions.push(vscode.commands.registerCommand(id, handler));
		}

		// --- Re-apply decorations on tab switch + refresh toolbar state ---
		context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				// During managed transitions (resolve, undo, redo, navigate) — defer instead of suppress.
				// The transition will handle its own decorations, but if the user manually
				// switches tabs during a transition, we need to catch up afterward.
				if (reviewManager?.isTransitioning) {
					const fname = editor?.document.uri.fsPath.split("/").pop() ?? "(none)";
					log.log(`onTabSwitch: DEFERRED (transitioning) ${fname}`);
					setTimeout(() => {
						if (reviewManager?.isTransitioning) return;
						const currentEditor = vscode.window.activeTextEditor;
						if (!currentEditor) return;
						const fp = currentEditor.document.uri.fsPath;
						const rev = state.activeReviews.get(fp);
						// Update context key (was missing — caused undo keybinding to fail)
						const deferredHasHistory = hasUndoState(fp) || hasRedoState(fp);
						vscode.commands.executeCommand("setContext", "ccr.activeFileInReview", !!rev || deferredHasHistory);
						log.logCat("focus", `onTabSwitch DEFERRED: ${fp.split("/").pop()} — review=${!!rev}, hasUndo=${hasUndoState(fp)}, hasRedo=${hasRedoState(fp)}, setting ccr.activeFileInReview=${!!rev || deferredHasHistory}`);
						if (rev) {
							const merged = rev.mergedLines.join("\n");
							if (currentEditor.document.getText() === merged) {
								applyDecorations(currentEditor, rev);
							} else {
								log.log(`onTabSwitch deferred: content mismatch for ${fp}, self-healing`);
								clearDecorations(currentEditor);
								void reviewManager!.ensureMergedContent(fp);
							}
						}
					}, 200);
					return;
				}
				const tTab = performance.now();
				const fname = editor?.document.uri.fsPath.split("/").pop() ?? "(none)";
				if (editor) {
					const filePath = editor.document.uri.fsPath;
					const review = state.activeReviews.get(filePath);
					const undoAvail = hasUndoState(filePath);
					const redoAvail = hasRedoState(filePath);
					const fileHasHistory = undoAvail || redoAvail;
					const ctxValue = !!review || fileHasHistory;
					log.logCat("focus", `onTabSwitch: ${fname} — review=${!!review}, hasUndo=${undoAvail}, hasRedo=${redoAvail}, setting ccr.activeFileInReview=${ctxValue}`);
					vscode.commands.executeCommand("setContext", "ccr.activeFileInReview", ctxValue);
					if (review) {
						const mergedContent = review.mergedLines.join("\n");
						if (editor.document.getText() === mergedContent) {
							applyDecorations(editor, review);
						} else {
							// Content doesn't match — self-heal by reapplying merged content
							log.log(`onTabSwitch: content mismatch for ${fname}, self-healing`);
							clearDecorations(editor);
							void reviewManager!.ensureMergedContent(filePath);
						}
					}
				} else {
					vscode.commands.executeCommand("setContext", "ccr.activeFileInReview", false);
				}
				// Always refresh — including when editor is undefined (all tabs closed)
				// so the toolbar switches from full navigation to "Review next file"
				state.refreshAll();
				log.log(`onTabSwitch: ${fname}, ${(performance.now() - tTab).toFixed(1)}ms`);
			}),
		);

		// --- HTTP server + hook bridge ---
		setAddFileHandler((filePath, sessionId) => {
			void reviewManager!.addFile(filePath, sessionId);
		});
		setWorkspacePath(workspacePath);
		setGetActiveReviewHandler((filePath) => state.activeReviews.get(filePath));
		setGetActiveSessionHandler(() => context.workspaceState.get<string>("ccr.activeSession"));
		setPostWebviewMessageHandler((msg) => mainView.postMessageDirect(msg as ExtensionToWebviewMessage));

		const portFilePath = path.join(workspacePath, ".claude", "ccr-port");
		startServer().then((port) => {
			try {
				const dir = path.dirname(portFilePath);
				if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(portFilePath, String(port));
				log.log(`port file written: ${portFilePath} → ${port}`);
			} catch (err) {
				log.log(`failed to write port file: ${(err as Error).message}`);
			}
		});

		context.subscriptions.push({
			dispose: () => {
				stopServer();
				try { fs.unlinkSync(portFilePath); } catch {}
				ptyManager.dispose();
			},
		});

		// --- Document listener for cleanup ---
		context.subscriptions.push(registerDocumentListener(context));

		// --- Document change listener for decoration recovery ---
		// When a file under review changes externally (formatOnSave, other extensions),
		// re-verify buffer and re-apply decorations. Debounced to avoid rapid fire.
		{
			let decoDebounce: NodeJS.Timeout | null = null;
			context.subscriptions.push(
				vscode.workspace.onDidChangeTextDocument((e) => {
					const fp = e.document.uri.fsPath;
					// Skip our own edits (resolve, undo, redo apply content via editor.edit)
					if (isApplyingEdit(fp)) return;
					const review = state.activeReviews.get(fp);
					if (!review) return;
					if (decoDebounce) clearTimeout(decoDebounce);
					decoDebounce = setTimeout(() => {
						decoDebounce = null;
						const editor = vscode.window.visibleTextEditors.find(
							(ed) => ed.document.uri.fsPath === fp,
						);
						if (!editor) return;
						const mergedContent = review.mergedLines.join("\n");
						if (editor.document.getText() === mergedContent) {
							applyDecorations(editor, review);
						} else {
							log.log(`onDocChange: content diverged for ${fp}, self-healing`);
							void reviewManager!.ensureMergedContent(fp);
						}
					}, 300);
				}),
			);
		}

		// --- Restore persisted review state ---
		// Restore state immediately, but defer UI refresh until after webview is ready
		reviewManager.restore().then(async (restored) => {
			if (restored) {
				log.log("Review state restored from persistence");
				vscode.commands.executeCommand("setContext", "ccr.reviewActive", true);

				// Apply merged content to any currently visible review files.
				// After reload, editors have disk content (modifiedContent) while review
				// expects inline diff content (removed+added lines). Apply to restore
				// decorations, CodeLens, and proper review display.
				for (const editor of vscode.window.visibleTextEditors) {
					const fp = editor.document.uri.fsPath;
					if (state.activeReviews.has(fp)) {
						log.log(`restore: applying merged content to ${fp.split("/").pop()}`);
						await reviewManager!.ensureMergedContent(fp);
					}
				}

				// Update context key for the active editor
				const activeEditor = vscode.window.activeTextEditor;
				if (activeEditor) {
					const fp = activeEditor.document.uri.fsPath;
					const hasReview = state.activeReviews.has(fp);
					vscode.commands.executeCommand("setContext", "ccr.activeFileInReview", hasReview);
				}

				state.refreshAll();
			}
		});

		// --- Hook manager: check & prompt for hooks ---
		const hookStatusHandler = (hookStatus: HookStatus) => {
			mainView.sendHookStatus(hookStatus);
		};
		checkAndPrompt(workspacePath, hookStatusHandler);

		context.subscriptions.push(
			vscode.commands.registerCommand("ccr.installHook", () =>
				doInstall(workspacePath, hookStatusHandler),
			),
		);

		// Register ReviewManager for disposal
		context.subscriptions.push(reviewManager);

		// --- First-run tip ---
		const SHOWN_KEY = "ccr.sidebarTipShown";
		if (!context.globalState.get(SHOWN_KEY)) {
			context.globalState.update(SHOWN_KEY, true);
			vscode.window
				.showInformationMessage(
					"Tip: Drag the Claude Code Review icon from the left sidebar to the right secondary sidebar for the best experience.",
					"Got it",
				)
				.then(() => {});
		}

		log.log("v9.0 activated successfully");
	} catch (err) {
		log.log("activation error:", (err as Error).message, (err as Error).stack);
		throw err;
	}
}

/**
 * Resolve the hunk nearest to the cursor position.
 */
async function resolveCurrentHunk(accept: boolean): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || !reviewManager) return;

	const filePath = editor.document.uri.fsPath;
	const review = state.activeReviews.get(filePath);
	if (!review) return;

	const cursorLine = editor.selection.active.line;

	// Find the closest unresolved hunk to cursor
	let bestHunkId: number | null = null;
	let bestDist = Infinity;

	for (const range of review.hunkRanges) {
		const hunk = review.hunks.find((h) => h.id === range.hunkId);
		if (!hunk || hunk.resolved) continue;

		const start = range.addedStart;
		const end = range.addedEnd;

		let dist: number;
		if (cursorLine >= start && cursorLine < end) {
			dist = 0; // cursor is inside this hunk
		} else {
			dist = Math.min(Math.abs(cursorLine - start), Math.abs(cursorLine - end));
		}

		if (dist < bestDist) {
			bestDist = dist;
			bestHunkId = hunk.id;
		}
	}

	if (bestHunkId !== null) {
		await reviewManager.resolveHunk(filePath, bestHunkId, accept);
	}
}

export function deactivate(): void {
	// dispose() handles save + file restoration + port file cleanup via context.subscriptions
	clearAllHistories();
	stopServer();
	fileLog.dispose();
	log.disposeFileLog();
}
