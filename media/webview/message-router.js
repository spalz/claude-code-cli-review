// Message router — handles messages from the extension to the webview
(function () {
	"use strict";

	window.addEventListener("message", function (event) {
		var msg = event.data;
		switch (msg.type) {
			case "sessions-list":
				renderSessions(msg.sessions);
				syncTabNamesFromSessions(msg.sessions);
				if (typeof updateArchiveButton === "function") {
					updateArchiveButton(msg.archivedCount || 0);
				}
				break;

			case "archived-sessions-list":
				if (typeof renderArchivedSessions === "function") {
					renderArchivedSessions(msg.sessions);
				}
				break;

			case "open-sessions-update":
				updateOpenClaudeIds(msg.openClaudeIds, msg.lazyClaudeIds);
				renderSessions(null);
				break;

			case "activate-terminal": {
				diagLog("session", "activate-terminal", {
					sid: msg.sessionId, exists: getTerminals().has(msg.sessionId),
					prevActive: getActiveTerminalId()
				});
				var terminals = getTerminals();
				if (terminals.has(msg.sessionId)) {
					activateTerminal(msg.sessionId);
					if (window.viewMode !== "terminals") {
						showTerminalView();
					}
					[100, 300, 800].forEach(function (ms) {
						setTimeout(fitActiveTerminal, ms);
					});
				}
				break;
			}

			case "terminal-session-created": {
				var loader = document.getElementById("sessionLoader");
				diagLog("session", "terminal-session-created", {
					sid: msg.sessionId, name: msg.name, claudeId: msg.claudeId,
					loaderVisible: !!loader
				});
				if (loader) loader.remove();
				addTerminal(msg.sessionId, msg.name, msg.claudeId, msg.restoring, msg.lazy);
				break;
			}

			case "update-terminal-claude-id": {
				var tu = getTerminals().get(msg.sessionId);
				if (tu) {
					tu.claudeId = msg.claudeId;
					// Pull title from cached sessions
					var s = findCachedSession(msg.claudeId);
					if (s && s.title) {
						tu.name = s.title;
						var span = tu.tabEl.querySelector("span:first-child");
						if (span) span.textContent = s.title;
					}
					diagLog("terminal", "claude-id-updated", {
						sid: msg.sessionId, claudeId: msg.claudeId
					});
				}
				break;
			}

			case "rename-terminal-tab":
				renameTerminalTab(msg.claudeId, msg.newName);
				break;

			case "rename-result":
				if (typeof handleRenameResult === "function") {
					handleRenameResult(msg.claudeId, msg.newName, msg.success);
				}
				break;

			case "terminal-session-closed":
				removeTerminal(msg.sessionId);
				break;

			case "terminal-output": {
				var t = getTerminals().get(msg.sessionId);
				if (t) {
					if (t.loadingOverlay) {
						// Check if TUI is starting (alternate screen / cursor ops)
						if (/\x1b\[\??(25|1049|2004)|(\x1b\[H\x1b\[2J)/.test(msg.data)) {
							t.loadingOverlay.remove();
							t.loadingOverlay = null;
							t.term.write(window.annotateFileLinks(msg.data));
						} else {
							// Pre-TUI text — show in skeleton status, don't write to terminal
							var plain = msg.data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/[\x00-\x1f]/g, " ").trim();
							if (plain) {
								var statusEl = t.loadingOverlay.querySelector(".sk-status");
								if (statusEl) statusEl.textContent = plain.slice(0, 80);
							}
						}
						break;
					}
					var before = getTermBufferState(t);
					var buf = t.term.buffer.active;
					var wasAtBottom = buf.viewportY >= buf.baseY;
					t.term.write(window.annotateFileLinks(msg.data));
					if (wasAtBottom) {
						t.term.scrollToBottom();
					}
					var after = getTermBufferState(t);
					diagLogThrottled("output", "write+scrollToBottom", {
						sid: msg.sessionId, len: msg.data.length,
						before: before, after: after
					});
				}
				break;
			}

			case "terminal-exit": {
				var te = getTerminals().get(msg.sessionId);
				diagLog("session", "terminal-exit", {
					sid: msg.sessionId, exitCode: msg.exitCode,
					buf: te ? getTermBufferState(te) : null
				});
				if (te) {
					te.term.write("\r\n[Process exited with code " + msg.exitCode + "]\r\n");
					te.exited = true;
					var bar = document.createElement("div");
					bar.className = "term-reopen-bar";
					if (te.claudeId) {
						var reopenBtn = document.createElement("vscode-button");
						reopenBtn.textContent = "Reopen session";
						reopenBtn.onclick = function () {
							reopenTerminal(msg.sessionId);
						};
						bar.appendChild(reopenBtn);
					}
					var closeBtn = document.createElement("vscode-button");
					closeBtn.setAttribute("secondary", "");
					closeBtn.textContent = "Close";
					closeBtn.onclick = function () {
						send("close-terminal", { sessionId: msg.sessionId, claudeId: te.claudeId || null });
					};
					bar.appendChild(closeBtn);
					te.container.appendChild(bar);
				}
				break;
			}

			case "terminal-error": {
				var ter = getTerminals().get(msg.sessionId);
				if (ter) {
					var overlay = document.createElement("div");
					overlay.className = "term-error-overlay";
					var box = document.createElement("div");
					box.className = "term-error-box";
					box.innerHTML =
						'<div style="font-size:28px;margin-bottom:12px">&#9888;</div>' +
						'<div style="font-size:13px;font-weight:600;margin-bottom:8px">Session not found</div>' +
						'<div style="font-size:11px;opacity:.6;margin-bottom:16px">This conversation was deleted or is no longer available in Claude CLI</div>';
					var errBtn = document.createElement("vscode-button");
					errBtn.textContent = "Back to sessions";
					errBtn.addEventListener("click", function () {
						closeErrorTerminal(msg.sessionId);
					});
					box.appendChild(errBtn);
					overlay.appendChild(box);
					ter.container.appendChild(overlay);
				}
				break;
			}

			case "insert-text": {
				var activeId = getActiveTerminalId();
				if (activeId) {
					var ti = getTerminals().get(activeId);
					if (ti) {
						switchMode("terminals");
						activateTerminal(activeId);
						send("terminal-input", { sessionId: activeId, data: msg.text });
						setTimeout(function () {
							ti.term.focus();
						}, 100);
					}
				}
				break;
			}

			case "hook-status":
				updateHookUI(msg.status);
				break;

			case "settings-init":
				if (msg.cliCommand) {
					document.getElementById("cliSelect").value = msg.cliCommand;
				}
				if (msg.keybindings) {
					updateShortcuts(msg.keybindings);
				}
				if (msg.claudeSettings) {
					updateClaudeSettings(msg.claudeSettings);
				}
				if (msg.terminalSettings) {
					updateTerminalSettings(msg.terminalSettings);
				}
				break;

			case "claude-settings-update":
				if (msg.claudeSettings) {
					onClaudeSettingsUpdate(msg.claudeSettings);
				}
				break;

			case "state-update":
				if (msg.review) {
					var activeFile = null;
					if (msg.review.files) {
						for (var i = 0; i < msg.review.files.length; i++) {
							if (msg.review.files[i].active && !msg.review.files[i].done) {
								activeFile = msg.review.files[i].path;
								break;
							}
						}
					}
					setCurrentFilePath(activeFile);
					renderReviewToolbar(msg.review);
				}
				break;

			case "lazy-session-ready": {
				// Replace placeholder terminal entry with real PTY
				var placeholder = getTerminals().get(msg.placeholderPtyId);
				if (placeholder) {
					var terms = getTerminals();
					terms.delete(msg.placeholderPtyId);
					placeholder.id = msg.realPtyId;
					placeholder.lazy = false;
					placeholder.sessionRef.id = msg.realPtyId;
					terms.set(msg.realPtyId, placeholder);
					placeholder.tabEl.dataset.tid = msg.realPtyId;
					placeholder.tabEl.classList.remove("lazy");
					// Update active ID if this was active
					if (getActiveTerminalId() === msg.placeholderPtyId) {
						// Re-activate with real ID
						activateTerminal(msg.realPtyId);
					}
					diagLog("terminal", "lazy-ready", {
						placeholder: msg.placeholderPtyId, real: msg.realPtyId, claudeId: msg.claudeId
					});
				}
				break;
			}

			case "activate-lazy-session": {
				// Find the lazy placeholder tab by claudeId and activate it
				var found = false;
				getTerminals().forEach(function (t, tid) {
					if (t.claudeId === msg.claudeId) {
						activateTerminal(tid);
						showTerminalView();
						found = true;
					}
				});
				if (!found) {
					diagLog("session", "activate-lazy-session-miss", { claudeId: msg.claudeId });
				}
				break;
			}

			case "restore-view-mode":
				if (msg.mode === "terminals" && window._hasOpenSessions && window._hasOpenSessions()) {
					switchMode("terminals", true);
					window._sessionsRestored = true;
					send("request-restore-sessions");
				}
				// else: stay on sessions list (no open sessions to show)
				break;

			case "show-onboarding":
				showOnboarding(msg);
				break;

		}
	});

	// Signal extension that webview JS is ready
	send("webview-ready");
})();
