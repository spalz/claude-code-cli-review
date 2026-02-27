// Message router — handles messages from the extension to the webview
// Depends on: core.js (send, switchMode, showTerminalView, setCurrentFilePath), diag.js (diagLog, diagLogThrottled, getTermBufferState), terminals.js (getTerminals, getActiveTerminalId, addTerminal, removeTerminal, activateTerminal, fitActiveTerminal, renameTerminalTab, annotateFileLinks, closeErrorTerminal, reopenTerminal), sessions.js (renderSessions, updateOpenClaudeIds, findCachedSession, updateArchiveButton, renderArchivedSessions, handleRenameResult), review.js (renderReviewToolbar), settings.js (updateHookUI, updateShortcuts, updateClaudeSettings, updateTerminalSettings, onClaudeSettingsUpdate)
// Exports: none (self-executing message listener)
(function () {
	"use strict";

	var FIT_DELAYS_MS = [100, 300, 800];
	var RECENT_INPUT_MS = 500;
	var SCROLL_BOTTOM_THRESHOLD = 5;

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
					sid: msg.sessionId,
					exists: getTerminals().has(msg.sessionId),
					prevActive: getActiveTerminalId(),
				});
				var terminals = getTerminals();
				if (terminals.has(msg.sessionId)) {
					activateTerminal(msg.sessionId);
					if (window.viewMode !== "terminals") {
						showTerminalView();
					}
					FIT_DELAYS_MS.forEach(function (ms) {
						setTimeout(function () {
							fitActiveTerminal("activate-terminal-msg");
						}, ms);
					});
				}
				break;
			}

			case "terminal-session-created": {
				var loader = document.getElementById("sessionLoader");
				diagLog("session", "terminal-session-created", {
					sid: msg.sessionId,
					name: msg.name,
					claudeId: msg.claudeId,
					loaderVisible: !!loader,
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
						sid: msg.sessionId,
						claudeId: msg.claudeId,
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
						} else {
							// Pre-TUI text — show in skeleton status
							var plain = msg.data
								.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
								.replace(/[\x00-\x1f]/g, " ")
								.trim();
							if (plain) {
								var statusEl = t.loadingOverlay.querySelector(".sk-status");
								if (statusEl) statusEl.textContent = plain.slice(0, 80);
							}
						}
						// Always write to terminal buffer (visible after overlay removed)
						t.term.write(window.annotateFileLinks(msg.data));
						t.term.scrollToBottom();
						break;
					}

					// --- Initial loading phase (after resume) ---
					// During initial loading, always scroll to bottom after each write.
					// Reset idle timer; when output goes silent for LOAD_IDLE_MS,
					// declare loading complete and do a final fit + scroll.
					if (t.initialLoading) {
						t.term.write(window.annotateFileLinks(msg.data));
						t.term.scrollToBottom();
						clearTimeout(t.loadIdleTimer);
						t.loadIdleTimer = setTimeout(function () {
							t.initialLoading = false;
							t.loadIdleTimer = null;
							diagLog("scroll-diag", "initial-load-done", {
								sid: msg.sessionId,
							});
							// Final fit + scroll after CLI finished loading
							fitActiveTerminal("load-idle-done");
							setTimeout(function () {
								t.term.scrollToBottom();
							}, 100);
						}, 2500); // LOAD_IDLE_MS
						break;
					}

					var before = getTermBufferState(t);
					var buf = t.term.buffer.active;
					var isAlt = buf.type === "alternate";
					var wasAtBottom = isAlt || buf.baseY - buf.viewportY <= SCROLL_BOTTOM_THRESHOLD;
					var recentInput =
						t.lastInputTime && Date.now() - t.lastInputTime < RECENT_INPUT_MS;
					var baseYBefore = buf.baseY;

					// Detect screen-switching sequences
					var hasAltEnter = msg.data.indexOf("\x1b[?1049h") !== -1;
					var hasAltExit = msg.data.indexOf("\x1b[?1049l") !== -1;
					var hasFullRedraw =
						msg.data.indexOf("\x1b[H\x1b[2J") !== -1 ||
						msg.data.indexOf("\x1b[2J") !== -1;

					t.term.write(window.annotateFileLinks(msg.data));

					// Track image edit mode and bind new [Image #N] to pending images
					if (typeof processImageOutput === "function") {
						processImageOutput(msg.data, msg.sessionId);
					}

					var afterBuf = t.term.buffer.active;
					var isAltAfter = afterBuf.type === "alternate";
					var baseYAfter = afterBuf.baseY;
					var scrollbackGrew = baseYAfter > baseYBefore;

					// TUI refresh: \x1b[H\x1b[2J rewrites same viewport, baseY unchanged.
					// Real clear (user typed `clear`): recentInput=true handles it.
					var isTuiRefresh = hasFullRedraw && !scrollbackGrew;

					// Force scroll-to-bottom on: already at bottom, recent user input,
					// screen switch, or full redraw that actually grew scrollback.
					// Suppress hasFullRedraw when it's a TUI viewport refresh (no new scrollback).
					var didScroll = wasAtBottom || recentInput || hasAltEnter || hasAltExit;
					if (hasFullRedraw && !isTuiRefresh) {
						didScroll = true;
					}
					if (didScroll) {
						t.term.scrollToBottom();
					}
					var after = getTermBufferState(t);
					var jumped =
						!didScroll && before && after && before.viewportY !== after.viewportY;

					// Log suppressed TUI refresh (user scrolled up, TUI redraw didn't move viewport)
					if (isTuiRefresh && !wasAtBottom) {
						diagLogThrottled("scroll-diag", "TUI-REFRESH-SUPPRESSED", {
							sid: msg.sessionId,
							len: msg.data.length,
							baseY: baseYAfter,
							viewportY: afterBuf.viewportY,
						});
					}

					// Log forced-scroll from fullRedraw/screen-switch
					if (didScroll && !wasAtBottom && !recentInput) {
						diagLog("scroll-diag", "FORCE-SCROLL-BOTTOM", {
							sid: msg.sessionId,
							len: msg.data.length,
							reason: hasAltEnter
								? "altEnter"
								: hasAltExit
									? "altExit"
									: hasFullRedraw
										? "fullRedraw-grew"
										: "unknown",
							scrollbackGrew: scrollbackGrew,
							baseYBefore: baseYBefore,
							baseYAfter: baseYAfter,
							before: before,
							after: after,
						});
					}

					// Log screen switches unconditionally
					if (hasAltEnter || hasAltExit || isAlt !== isAltAfter) {
						diagLog("scroll-diag", "SCREEN-SWITCH", {
							sid: msg.sessionId,
							len: msg.data.length,
							hasAltEnter: hasAltEnter,
							hasAltExit: hasAltExit,
							bufBefore: isAlt ? "alt" : "normal",
							bufAfter: isAltAfter ? "alt" : "normal",
							before: before,
							after: after,
						});
					}

					if (jumped) {
						diagLog("scroll-diag", "OUTPUT-VIEWPORT-JUMP", {
							sid: msg.sessionId,
							len: msg.data.length,
							before: before,
							after: after,
							wasAtBottom: wasAtBottom,
							isAlt: isAlt,
							recentInput: !!recentInput,
							hasFullRedraw: hasFullRedraw,
						});
					} else if (!didScroll && before && before.viewportY !== before.baseY) {
						// User is scrolled away from bottom — log every write
						diagLog("scroll-diag", "WRITE-WHILE-SCROLLED-UP", {
							sid: msg.sessionId,
							len: msg.data.length,
							isAlt: isAlt,
							before: before,
							after: after,
							hasFullRedraw: hasFullRedraw,
						});
					} else {
						diagLogThrottled("output", "write", {
							sid: msg.sessionId,
							len: msg.data.length,
							isAlt: isAlt,
							before: before,
							after: after,
							didScroll: didScroll,
						});
					}
				}
				break;
			}

			case "terminal-exit": {
				var te = getTerminals().get(msg.sessionId);
				diagLog("session", "terminal-exit", {
					sid: msg.sessionId,
					exitCode: msg.exitCode,
					buf: te ? getTermBufferState(te) : null,
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
						send("close-terminal", {
							sessionId: msg.sessionId,
							claudeId: te.claudeId || null,
						});
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
					var activeId = getActiveTerminalId();
					var stBefore = activeId
						? getTermBufferState(getTerminals().get(activeId))
						: null;
					renderReviewToolbar(msg.review);
					var stAfter = activeId
						? getTermBufferState(getTerminals().get(activeId))
						: null;
					if (stBefore && stAfter && stBefore.viewportY !== stAfter.viewportY) {
						diagLog("scroll-diag", "state-update-JUMP", {
							before: stBefore,
							after: stAfter,
						});
					}
				}
				break;

			case "lazy-session-ready": {
				// Replace placeholder terminal entry with real PTY
				// Primary: find by claudeId (reliable — placeholder IDs are auto-generated)
				var placeholder = null;
				var placeholderKey = null;
				if (msg.claudeId) {
					getTerminals().forEach(function (t, tid) {
						if (!placeholder && t.claudeId === msg.claudeId && t.lazy) {
							placeholder = t;
							placeholderKey = tid;
						}
					});
				}
				// Fallback: find by placeholderPtyId
				if (!placeholder) {
					placeholder = getTerminals().get(msg.placeholderPtyId);
					placeholderKey = msg.placeholderPtyId;
				}
				if (placeholder) {
					var terms = getTerminals();
					terms.delete(placeholderKey);
					placeholder.id = msg.realPtyId;
					placeholder.lazy = false;
					placeholder.sessionRef.id = msg.realPtyId;
					terms.set(msg.realPtyId, placeholder);
					placeholder.tabEl.dataset.tid = msg.realPtyId;
					placeholder.tabEl.classList.remove("lazy");
					// Mark as loading — will scroll to bottom until output goes idle
					placeholder.initialLoading = true;
					// Update active ID if this was active
					if (getActiveTerminalId() === placeholderKey) {
						// Re-activate with real ID
						activateTerminal(msg.realPtyId);
					}
					diagLog("terminal", "lazy-ready", {
						placeholder: placeholderKey,
						real: msg.realPtyId,
						claudeId: msg.claudeId,
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
				if (
					msg.mode === "terminals" &&
					window._hasOpenSessions &&
					window._hasOpenSessions()
				) {
					switchMode("terminals", true);
					window._sessionsRestored = true;
					send("request-restore-sessions");
				}
				// else: stay on sessions list (no open sessions to show)
				break;

			case "show-onboarding":
				showOnboarding(msg);
				break;

			case "image-pending":
				if (typeof enqueueImage === "function") {
					enqueueImage(msg.base64, msg.mimeType, msg.filePath, msg.ptyId);
				}
				break;

			case "play-notification-sound":
				playNotificationSound();
				break;
		}
	});

	// --- Notification sound via Web Audio API ---
	// Cursor-style chime: C4 (261Hz) + E4 (329Hz) major third, soft bell tone
	function playNotificationSound() {
		try {
			var ctx = new (window.AudioContext || window.webkitAudioContext)();
			var now = ctx.currentTime;

			// C4 + E4 major third — simultaneous onset, E4 sustains longer
			var notes = [
				{ freq: 261.63, gain: 0.12, attack: 0.05, decay: 0.6 }, // C4 — fades first
				{ freq: 329.63, gain: 0.1, attack: 0.05, decay: 0.85 }, // E4 — sustains longer
			];

			notes.forEach(function (n) {
				var osc = ctx.createOscillator();
				var gainNode = ctx.createGain();
				osc.type = "sine";
				osc.frequency.value = n.freq;
				// Quick attack → long exponential decay (bell envelope)
				gainNode.gain.setValueAtTime(0.001, now);
				gainNode.gain.linearRampToValueAtTime(n.gain, now + n.attack);
				gainNode.gain.exponentialRampToValueAtTime(0.001, now + n.decay);
				osc.connect(gainNode);
				gainNode.connect(ctx.destination);
				osc.start(now);
				osc.stop(now + n.decay);
			});

			setTimeout(function () {
				ctx.close();
			}, 1200);
		} catch (e) {
			// Web Audio API not available — silently ignore
		}
	}

	// Signal extension that webview JS is ready
	send("webview-ready");
})();
