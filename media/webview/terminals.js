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

	window.addTerminal = function (id, name, claudeId) {
		var displayName = name;
		if (claudeId) {
			var s = findCachedSession(claudeId);
			if (s) displayName = s.title;
		}

		// Tab element — inserted into header's terminal bar
		var tab = document.createElement("div");
		tab.className = "terminal-tab";
		tab.dataset.tid = id;

		var nameSpan = document.createElement("span");
		nameSpan.textContent = displayName;
		nameSpan.onclick = function () {
			activateTerminal(id);
		};
		nameSpan.ondblclick = function (e) {
			e.stopPropagation();
			startTabRename(id);
		};

		tab.appendChild(nameSpan);
		tab.oncontextmenu = function (e) {
			showTabCtxMenu(e, id);
		};
		document.getElementById("terminalBar").appendChild(tab);

		// Container
		var container = document.createElement("div");
		container.className = "term-container";
		container.id = "term-" + id;
		document.getElementById("terminalsArea").appendChild(container);

		setupDragDrop(container, id);

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
		term.open(container);

		setupKeyHandler(term, id);
		setupPasteHandler(container, id);

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
			send("terminal-input", { sessionId: id, data: data });
		});
		term.onResize(function (size) {
			send("terminal-resize", { sessionId: id, cols: size.cols, rows: size.rows });
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
		};
		terminals.set(id, entry);

		diagLog("terminal", "created", {
			id: id, name: displayName, claudeId: claudeId, total: terminals.size
		});

		activateTerminal(id);
		showTerminalView();

		[100, 300, 800].forEach(function (ms) {
			setTimeout(fitActiveTerminal, ms);
		});
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
		activeTerminalId = id;
		diagLog("terminal", "activate", { newId: id, prevId: previousId, total: terminals.size });
		terminals.forEach(function (t, tid) {
			t.container.classList.toggle("active", tid === id);
			t.tabEl.classList.toggle("active", tid === id);
		});
		var active = terminals.get(id);
		if (active) active.tabEl.scrollIntoView({ block: "nearest", inline: "nearest" });
		var claudeIdVal = active ? active.claudeId || null : null;
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
					send("close-terminal", { sessionId: termId });
				}
			};
		});
	}

	// --- Drag & drop ---

	function setupDragDrop(container, sessionId) {
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
				send("file-dropped", { sessionId: sessionId, uri: uri });
			} else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
				var filePath = e.dataTransfer.files[0].path || e.dataTransfer.files[0].name;
				if (filePath)
					send("file-dropped", { sessionId: sessionId, uri: "file://" + filePath });
			}
		});
	}

	// --- Key handler ---

	function setupKeyHandler(term, sessionId) {
		var lastCtrlC = 0;
		term.attachCustomKeyEventHandler(function (event) {
			if (event.type !== "keydown") return true;
			// Shift+Enter → send same sequence as Option+Enter (newline in Claude CLI)
			if (event.shiftKey && event.key === "Enter") {
				send("terminal-input", { sessionId: sessionId, data: "\x1b\n" });
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

	function setupPasteHandler(container, sessionId) {
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
							sessionId: sessionId,
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
		send("close-terminal", { sessionId: sessionId });
	};

	window.reopenTerminal = function (sessionId) {
		var t = terminals.get(sessionId);
		if (!t || !t.claudeId) return;
		var claudeId = t.claudeId;
		send("close-terminal", { sessionId: sessionId });
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
