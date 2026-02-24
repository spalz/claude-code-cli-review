// Terminal management — xterm instances, tabs, drag&drop, paste, key handling
(function () {
	"use strict";

	var terminals = new Map();
	var activeTerminalId = null;

	window.getTerminals = function () {
		return terminals;
	};
	window.getActiveTerminalId = function () {
		return activeTerminalId;
	};

	// ANSI-annotate file paths with dotted underline so they're always visible
	var pathRegex = /((?:~\/|\.{1,2}\/|\/|[a-zA-Z]:[\\/])[\w.\-\\/]+\.\w{1,10}|(?:[\w.\-]+\/)+[\w.\-]+\.\w{1,10})(?::(\d+))?(?::(\d+))?/g;
	// Splits stream into [ANSI escape sequences] and [plain text] chunks
	var ansiSplitRegex = /(\x1b(?:\[[0-9;:]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]))/;
	// Dotted underline + grey underline color
	var LINK_START = "\x1b[4:4m\x1b[58;5;245m";
	// Reset underline + reset underline color
	var LINK_END = "\x1b[4:0m\x1b[59m";

	window.annotateFileLinks = function (data) {
		// Fast path: skip if no slash-like chars
		if (data.indexOf("/") === -1 && data.indexOf("\\") === -1 && data.indexOf("~") === -1) {
			return data;
		}
		// Split into ANSI escape and plain text segments, only apply regex to plain text
		var parts = data.split(ansiSplitRegex);
		var changed = false;
		for (var i = 0; i < parts.length; i++) {
			// Even indices are plain text, odd indices are ANSI escapes
			if (i % 2 === 0 && parts[i]) {
				var before = parts[i];
				parts[i] = parts[i].replace(pathRegex, function (match) {
					return LINK_START + match + LINK_END;
				});
				if (parts[i] !== before) changed = true;
			}
		}
		if (changed) {
			diagLog("links", "annotated", { inLen: data.length, outLen: parts.join("").length, parts: parts.length });
		}
		return parts.join("");
	};

	var nextPlaceholderId = -1;
	window.addTerminal = function (id, name, claudeId, silent, lazy) {
		// For lazy placeholders, generate a unique negative ID
		if (lazy && id === -1) {
			id = nextPlaceholderId--;
		}
		var displayName = name;
		if (claudeId) {
			var s = findCachedSession(claudeId);
			if (s) displayName = s.title;
		}

		// Use object ref so lazy→real ID swap is picked up by closures
		var sessionRef = { id: id };

		// Tab element — inserted into header's terminal bar
		var tab = document.createElement("div");
		tab.className = "terminal-tab" + (lazy ? " lazy" : "");
		tab.dataset.tid = id;

		var nameSpan = document.createElement("span");
		nameSpan.textContent = displayName;
		nameSpan.ondblclick = function (e) {
			e.stopPropagation();
			startTabRename(sessionRef.id);
		};

		var closeBtn = document.createElement("span");
		closeBtn.className = "tab-close";
		closeBtn.textContent = "\u00d7";
		closeBtn.onclick = function (e) {
			e.stopPropagation();
			var ct = terminals.get(sessionRef.id);
			send("close-terminal", { sessionId: sessionRef.id, claudeId: ct ? ct.claudeId : null });
		};

		tab.appendChild(nameSpan);
		tab.appendChild(closeBtn);
		tab.onclick = function (e) {
			if (e.target === closeBtn) return;
			activateTerminal(sessionRef.id);
		};
		tab.oncontextmenu = function (e) {
			showTabCtxMenu(e, sessionRef.id);
		};
		document.getElementById("terminalBar").appendChild(tab);

		// Container
		var container = document.createElement("div");
		container.className = "term-container";
		container.id = "term-" + id;
		document.getElementById("terminalsArea").appendChild(container);

		setupDragDrop(container, sessionRef);

		// xterm
		var term = new Terminal({
			cursorBlink: true,
			fontSize: 12,
			fontFamily: "'Menlo','Monaco','Courier New',monospace",
			theme: {
				background:
					getComputedStyle(document.body)
						.getPropertyValue("--vscode-sideBar-background")
						.trim() || "#1e1e1e",
				foreground: "#cccccc",
				cursor: "#ffffff",
				selectionBackground: "#264f78",
			},
			scrollback: 10000,
			convertEol: true,
		});

		var fitAddon = new FitAddon.FitAddon();
		term.loadAddon(fitAddon);

		// URL links (http/https) — open in browser
		try {
			var webLinksAddon = new WebLinksAddon.WebLinksAddon(function (event, uri) {
				send("open-external-url", { url: uri });
			});
			term.loadAddon(webLinksAddon);
		} catch (err) {
			diagLog("links", "addon-FAILED", { error: String(err) });
		}

		term.open(container);

		// File path links — custom provider (click-only, no hover decorations)
		try {
		term.registerLinkProvider({
			provideLinks: function (y, callback) {
				// y is 1-based buffer line number; getLine() is 0-based
				var line = term.buffer.active.getLine(y - 1);
				if (!line) return callback(undefined);
				var text = line.translateToString();
				if (!text) return callback(undefined);

				var regex = /((?:~\/|\.{1,2}\/|\/|[a-zA-Z]:[\\/])[\w.\-\\/]+\.\w{1,10}|(?:[\w.\-]+\/)+[\w.\-]+\.\w{1,10})(?::(\d+))?(?::(\d+))?/g;
				var links = [];
				var m;
				while ((m = regex.exec(text)) !== null) {
					var filePath = m[1];
					var ln = m[3] ? +m[2] : m[2] ? +m[2] : undefined;
					var col = m[3] ? +m[3] : undefined;
					var startX = m.index + 1;
					var fullMatch = m[0];
					(function (fp, l, c) {
						links.push({
							range: { start: { x: startX, y: y }, end: { x: startX + fullMatch.length, y: y } },
							text: fullMatch,
							activate: function () {
								send("open-file-link", { path: fp, line: l, column: c });
							}
						});
					})(filePath, ln, col);
				}
				callback(links.length ? links : undefined);
			}
		});
		} catch (err) {
			diagLog("links", "linkProvider-FAILED", { error: String(err) });
		}

		setupKeyHandler(term, sessionRef);
		setupPasteHandler(container, sessionRef);

		var cmdBuf = "";
		term.onData(function (data) {
			// Slash command guard: block /resume and /exit in embedded sessions
			if (data === "\r") {
				var cmd = cmdBuf.trim();
				if (/^\/(resume|exit)\b/.test(cmd)) {
					cmdBuf = "";
					send("blocked-slash-command", { command: cmd.split(/\s/)[0] });
					return;
				}
				cmdBuf = "";
			} else if (data === "\x7f") {
				cmdBuf = cmdBuf.slice(0, -1);
			} else if (data[0] === "\x1b" || data === "\x03" || data === "\x15") {
				cmdBuf = "";
			} else {
				cmdBuf += data;
			}
			send("terminal-input", { sessionId: sessionRef.id, data: data });
		});
		term.onResize(function (size) {
			send("terminal-resize", { sessionId: sessionRef.id, cols: size.cols, rows: size.rows });
		});

		// Loading overlay — shown until TUI starts
		var overlay = document.createElement("div");
		overlay.className = "term-loading-overlay";
		overlay.innerHTML = ''
			+ '<div class="sk">'
			+   '<pre class="sk-logo">'
			+  '\u2590\u259B\u2588\u2588\u2588\u259C\u258C\n'
			+  '\u259D\u259C\u2588\u2588\u2588\u2588\u2588\u259B\u2598\n'
			+  '\u2598\u2598 \u259D\u259D'
			+   '</pre>'
			+   '<div class="sk-status">Starting session\u2026</div>'
			+ '</div>';
		container.appendChild(overlay);
		setTimeout(function () {
			if (overlay.parentElement) {
				overlay.remove();
				var e = terminals.get(id);
				if (e) e.loadingOverlay = null;
			}
		}, 15000);

		var entry = {
			id: id,
			name: displayName,
			claudeId: claudeId,
			term: term,
			fitAddon: fitAddon,
			container: container,
			tabEl: tab,
			loadingOverlay: overlay,
			lazy: !!lazy,
			sessionRef: sessionRef,
		};
		terminals.set(id, entry);

		diagLog("terminal", "created", {
			id: id, name: displayName, claudeId: claudeId, total: terminals.size, silent: !!silent
		});

		if (!silent) {
			activateTerminal(id);
			showTerminalView();
			[100, 300, 800].forEach(function (ms) {
				setTimeout(fitActiveTerminal, ms);
			});
		}
	};

	window.removeTerminal = function (id) {
		var t = terminals.get(id);
		if (!t) return;
		diagLog("terminal", "removed", { id: id, remaining: terminals.size - 1 });
		t.term.dispose();
		t.container.remove();
		t.tabEl.remove();
		terminals.delete(id);


		if (activeTerminalId === id) {
			var remaining = Array.from(terminals.keys());
			if (remaining.length > 0) activateTerminal(remaining[remaining.length - 1]);
			else {
				activeTerminalId = null;
				if (window.setActiveClaudeId) setActiveClaudeId(null);
				showSessionsList();
			}
		}
	};

	function activateTerminal(id) {
		var previousId = activeTerminalId;
		var entry = terminals.get(id);

		// Lazy tab — request PTY spawn on first activation
		if (entry && entry.lazy && !entry.lazyRequested) {
			entry.lazyRequested = true;
			diagLog("terminal", "lazy-resume", { id: id, claudeId: entry.claudeId });
			send("lazy-resume", { claudeId: entry.claudeId, placeholderPtyId: id });
		}

		activeTerminalId = id;
		diagLog("terminal", "activate", { newId: id, prevId: previousId, total: terminals.size });
		terminals.forEach(function (t, tid) {
			t.container.classList.toggle("active", tid === id);
			t.tabEl.classList.toggle("active", tid === id);
		});
		if (entry) entry.tabEl.scrollIntoView({ block: "nearest", inline: "nearest" });
		var claudeIdVal = entry ? entry.claudeId || null : null;
		if (window.setActiveClaudeId) setActiveClaudeId(claudeIdVal);
		send("set-active-session", { claudeId: claudeIdVal });
		fitActiveTerminal();
	}
	window.activateTerminal = activateTerminal;

	window.fitActiveTerminal = function () {
		if (!activeTerminalId) return;
		var t = terminals.get(activeTerminalId);
		if (t && window.viewMode === "terminals") {
			var beforeCols = t.term.cols;
			var beforeRows = t.term.rows;
			setTimeout(function () {
				try {
					var buf = t.term.buffer.active;
					var wasAtBottom = buf.viewportY >= buf.baseY;
					var savedY = buf.viewportY;
					t.fitAddon.fit();
					if (!wasAtBottom && savedY > 0) {
						t.term.scrollToLine(savedY);
					}
					if (t.term.cols !== beforeCols || t.term.rows !== beforeRows) {
						diagLog("resize", "fit", {
							sid: activeTerminalId,
							from: { c: beforeCols, r: beforeRows },
							to: { c: t.term.cols, r: t.term.rows },
							container: { w: t.container.clientWidth, h: t.container.clientHeight }
						});
					}
				} catch (e) {
					/* ignore */
				}
			}, 50);
		}
	};

	// Rename terminal tab for sessions rename sync
	window.renameTerminalTab = function (claudeId, newName) {
		terminals.forEach(function (t) {
			if (t.claudeId === claudeId) {
				t.name = newName;
				delete t._pendingRename;
				var span = t.tabEl.querySelector("span:first-child");
				if (span) {
					span.textContent = newName;
					span.classList.remove("renaming");
				}
			}
		});
	};

	// Revert tab name on rename failure
	window.revertTabRename = function (claudeId) {
		terminals.forEach(function (t) {
			if (t.claudeId === claudeId && t._pendingRename) {
				t.name = t._pendingRename;
				delete t._pendingRename;
				var span = t.tabEl.querySelector("span:first-child");
				if (span) {
					span.textContent = t.name;
					span.classList.remove("renaming");
				}
			}
		});
	};

	// --- Tab inline rename ---

	function startTabRename(termId) {
		var t = terminals.get(termId);
		if (!t) return;
		var nameSpan = t.tabEl.querySelector("span:first-child");
		if (!nameSpan) return;

		var oldName = t.name;
		var input = document.createElement("input");
		input.type = "text";
		input.className = "tab-inline-edit";
		input.value = t.name;
		nameSpan.replaceWith(input);
		input.focus();
		input.select();

		function restoreSpan(text, loading) {
			var span = document.createElement("span");
			span.textContent = text;
			if (loading) span.classList.add("renaming");
			span.onclick = function () {
				activateTerminal(termId);
			};
			span.ondblclick = function (e) {
				e.stopPropagation();
				startTabRename(termId);
			};
			input.replaceWith(span);
		}

		var committed = false;
		function commit() {
			var newName = input.value.trim();
			if (newName && newName !== t.name) {
				t.name = newName;
				t._pendingRename = oldName;
				restoreSpan(newName, true);
				if (t.claudeId) send("rename-session", { sessionId: t.claudeId, newName: newName });
			} else {
				restoreSpan(t.name, false);
			}
		}

		input.onblur = function () {
			if (!committed) {
				committed = true;
				commit();
			}
		};
		input.onkeydown = function (e) {
			if (e.key === "Enter") {
				e.preventDefault();
				committed = true;
				commit();
			}
			if (e.key === "Escape") {
				e.preventDefault();
				committed = true;
				restoreSpan(t.name, false);
			}
		};
	}

	// --- Tab context menu ---

	function showTabCtxMenu(e, termId) {
		e.preventDefault();
		e.stopPropagation();
		var menu = document.getElementById("ctxMenu");
		var html = "";
		html += '<div class="ctx-menu-item" data-action="tab-rename">Rename</div>';
		html += '<div class="ctx-menu-item" data-action="tab-reload">Reload</div>';
		html += '<div class="ctx-menu-sep"></div>';
		html += '<div class="ctx-menu-item danger" data-action="tab-close">Close session</div>';
		menu.innerHTML = html;

		var rect = document.body.getBoundingClientRect();
		var x = e.clientX, y = e.clientY;
		menu.style.display = "block";
		if (x + menu.offsetWidth > rect.width) x = rect.width - menu.offsetWidth - 4;
		if (y + menu.offsetHeight > rect.height) y = rect.height - menu.offsetHeight - 4;
		menu.style.left = x + "px";
		menu.style.top = y + "px";

		menu.querySelectorAll(".ctx-menu-item").forEach(function (item) {
			item.onclick = function (ev) {
				ev.stopPropagation();
				menu.style.display = "none";
				var action = item.dataset.action;
				if (action === "tab-rename") {
					startTabRename(termId);
				} else if (action === "tab-reload") {
					reopenTerminal(termId);
				} else if (action === "tab-close") {
					var ct = terminals.get(termId);
					send("close-terminal", { sessionId: termId, claudeId: ct ? ct.claudeId : null });
				}
			};
		});
	}

	// --- Drag & drop ---

	function setupDragDrop(container, sessionRef) {
		container.addEventListener("dragover", function (e) {
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
			container.classList.add("drop-active");
		});
		container.addEventListener("dragleave", function () {
			container.classList.remove("drop-active");
		});
		container.addEventListener("drop", function (e) {
			e.preventDefault();
			container.classList.remove("drop-active");
			var uri =
				e.dataTransfer.getData("text/uri-list") ||
				e.dataTransfer.getData("text/plain") ||
				e.dataTransfer.getData("text");
			if (uri) {
				send("file-dropped", { sessionId: sessionRef.id, uri: uri });
			} else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
				var filePath = e.dataTransfer.files[0].path || e.dataTransfer.files[0].name;
				if (filePath)
					send("file-dropped", { sessionId: sessionRef.id, uri: "file://" + filePath });
			}
		});
	}

	// --- Key handler ---

	function setupKeyHandler(term, sessionRef) {
		var lastCtrlC = 0;
		term.attachCustomKeyEventHandler(function (event) {
			if (event.type !== "keydown") return true;
			// Shift+Enter → send same sequence as Option+Enter (newline in Claude CLI)
			if (event.shiftKey && event.key === "Enter") {
				send("terminal-input", { sessionId: sessionRef.id, data: "\x1b\n" });
				return false;
			}
			if (event.ctrlKey && event.key === "c") {
				var now = Date.now();
				if (now - lastCtrlC < 2000) return false;
				lastCtrlC = now;
				return true;
			}
			if (event.ctrlKey && event.key === "d") return false;
			if (event.ctrlKey && event.key === "z") return false;
			if (event.ctrlKey && event.key === "\\") return false;
			return true;
		});
	}

	// --- Image paste ---

	function setupPasteHandler(container, sessionRef) {
		container.addEventListener("paste", function (e) {
			var items = e.clipboardData && e.clipboardData.items;
			if (!items) return;
			for (var i = 0; i < items.length; i++) {
				if (items[i].type.startsWith("image/")) {
					e.preventDefault();
					e.stopPropagation();
					var blob = items[i].getAsFile();
					if (!blob) return;
					var mimeType = items[i].type;
					var reader = new FileReader();
					reader.onload = function () {
						var base64 = reader.result.split(",")[1];
						send("paste-image", {
							sessionId: sessionRef.id,
							data: base64,
							mimeType: mimeType,
						});
					};
					reader.readAsDataURL(blob);
					return;
				}
			}
		});
	}

	// Sync tab names from fresh sessions data (called on sessions-list update)
	window.syncTabNamesFromSessions = function (sessions) {
		if (!sessions) return;
		terminals.forEach(function (t) {
			if (!t.claudeId) return;
			var s = sessions.find(function (x) { return x.id === t.claudeId; });
			if (s && s.title && s.title !== t.name) {
				t.name = s.title;
				var span = t.tabEl.querySelector("span:first-child");
				if (span) span.textContent = s.title;
			}
		});
	};

	// --- Reopen / close error ---

	window.closeErrorTerminal = function (sessionId) {
		var t = terminals.get(sessionId);
		send("close-terminal", { sessionId: sessionId, claudeId: t ? t.claudeId : null });
	};

	window.reopenTerminal = function (sessionId) {
		var t = terminals.get(sessionId);
		if (!t || !t.claudeId) return;
		var claudeId = t.claudeId;
		send("close-terminal", { sessionId: sessionId, claudeId: claudeId });
		setTimeout(function () {
			send("resume-claude-session", { claudeSessionId: claudeId });
		}, 200);
	};

	// --- Wheel scroll for tab bar ---

	document.getElementById("terminalBar").addEventListener("wheel", function (e) {
		e.preventDefault();
		this.scrollLeft += e.deltaY || e.deltaX;
	}, { passive: false });

	// --- ResizeObserver ---

	var ro = new ResizeObserver(function () {
		var area = document.getElementById("terminalsArea");
		diagLogThrottled("resize", "observer", {
			w: area ? area.clientWidth : 0, h: area ? area.clientHeight : 0
		});
		clearTimeout(ro._t);
		ro._t = setTimeout(fitActiveTerminal, 100);
	});
	ro.observe(document.getElementById("terminalsArea"));
})();
