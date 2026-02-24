// Settings — shortcuts display, hook status, CLI command, Claude CLI settings
// Now rendered inside #settingsOverlay instead of a tab panel
// Depends on: core.js (send)
// Exports: window.{updateShortcuts, updateClaudeSettings, onClaudeSettingsUpdate, updateHookUI, updateTerminalSettings}
(function () {
	"use strict";

	// Current scope and cached settings data
	var currentScope = "effective";
	var cachedSettings = { effective: {}, global: {}, project: {}, runtime: {} };

	window.updateShortcuts = function (bindings) {
		var el = document.getElementById("shortcutsContainer");
		if (!bindings || bindings.length === 0) {
			el.innerHTML = '<div style="font-size:12px;opacity:.4">No shortcuts configured</div>';
			return;
		}
		var html = "";
		bindings.forEach(function (b) {
			html += '<div class="shortcut-row">';
			html += '<span class="keys">' + esc(b.key) + "</span>";
			html += '<span class="desc">' + esc(b.desc) + "</span>";
			html += "</div>";
		});
		el.innerHTML = html;
	};

	// Static button listeners
	document.getElementById("hookActionBtn").addEventListener("click", function () {
		send("install-hook");
	});
	document.getElementById("cliSelect").addEventListener("change", function () {
		send("set-cli-command", { value: this.value });
	});
	document.getElementById("btnCustomizeKeys").addEventListener("click", function () {
		send("open-keybindings");
	});

	// --- Notification mode select ---
	var tsNotifMode = document.getElementById("ts_notificationMode");
	if (tsNotifMode) {
		tsNotifMode.addEventListener("change", function () {
			send("set-terminal-setting", { key: "notificationMode", value: this.value });
		});
	}

	window.updateTerminalSettings = function (data) {
		if (!data) return;
		if (tsNotifMode && data.notificationMode) tsNotifMode.value = data.notificationMode;
	};

	// --- Scope toggle ---
	var scopeBtns = document.querySelectorAll(".scope-btn");
	for (var i = 0; i < scopeBtns.length; i++) {
		scopeBtns[i].addEventListener("click", function () {
			currentScope = this.getAttribute("data-scope");
			for (var j = 0; j < scopeBtns.length; j++) {
				scopeBtns[j].classList.toggle("active", scopeBtns[j] === this);
			}
			applySettingsToUI();
			updateControlStates();
		});
	}

	// --- Settings keys (written to ~/.claude/settings.json, support scope) ---
	var csSelectMap = {
		cs_theme: "preferences.theme",
		cs_outputStyle: "outputStyle",
		cs_editorMode: "preferences.editorMode",
		cs_permissionMode: "permissions.defaultMode",
	};

	var csToggleMap = {
		cs_thinkingMode: "alwaysThinkingEnabled",
		cs_respectGitignore: "respectGitignore",
		cs_terminalProgressBar: "terminalProgressBarEnabled",
		cs_reduceMotion: "prefersReducedMotion",
		cs_showTips: "spinnerTipsEnabled",
	};

	var csTextMap = {
		cs_model: "model",
		cs_language: "language",
	};

	// --- Runtime keys (written to ~/.claude.json, always global) ---
	var rtToggleMap = {
		cs_verbose: "verbose",
		cs_autoUpdates: "autoUpdates",
		cs_showPRStatusFooter: "prStatusFooterEnabled",
		cs_promptSuggestions: "showSpinnerTree",
	};

	var rtSelectMap = {
		cs_notifications: "preferredNotifChannel",
	};

	// Helper: get nested value by dot-notation key
	function getNestedValue(obj, key) {
		var parts = key.split(".");
		var cur = obj;
		for (var i = 0; i < parts.length; i++) {
			if (cur === undefined || cur === null) return undefined;
			cur = cur[parts[i]];
		}
		return cur;
	}

	// Bind settings select controls
	Object.keys(csSelectMap).forEach(function (id) {
		var el = document.getElementById(id);
		if (el) {
			el.addEventListener("change", function () {
				var writeScope = currentScope === "effective" ? "global" : currentScope;
				send("set-claude-setting", { key: csSelectMap[id], value: this.value, scope: writeScope });
			});
		}
	});

	// Bind settings toggle controls
	Object.keys(csToggleMap).forEach(function (id) {
		var el = document.getElementById(id);
		if (el) {
			el.addEventListener("change", function () {
				var writeScope = currentScope === "effective" ? "global" : currentScope;
				send("set-claude-setting", { key: csToggleMap[id], value: this.checked, scope: writeScope });
			});
		}
	});

	// Bind settings text inputs
	Object.keys(csTextMap).forEach(function (id) {
		var el = document.getElementById(id);
		if (el) {
			var commit = function () {
				var writeScope = currentScope === "effective" ? "global" : currentScope;
				send("set-claude-setting", { key: csTextMap[id], value: el.value, scope: writeScope });
			};
			el.addEventListener("change", commit);
			el.addEventListener("keydown", function (e) {
				if (e.key === "Enter") { el.blur(); }
			});
		}
	});

	// Bind runtime toggle controls
	Object.keys(rtToggleMap).forEach(function (id) {
		var el = document.getElementById(id);
		if (el) {
			el.addEventListener("change", function () {
				send("set-claude-runtime", { key: rtToggleMap[id], value: this.checked });
			});
		}
	});

	// Bind runtime select controls
	Object.keys(rtSelectMap).forEach(function (id) {
		var el = document.getElementById(id);
		if (el) {
			el.addEventListener("change", function () {
				send("set-claude-runtime", { key: rtSelectMap[id], value: this.value });
			});
		}
	});

	/** Disable controls based on scope */
	function updateControlStates() {
		var isEffective = currentScope === "effective";
		var isProject = currentScope === "project";

		// Settings controls: disabled in effective mode
		var settingsIds = Object.keys(csSelectMap).concat(Object.keys(csToggleMap)).concat(Object.keys(csTextMap));
		settingsIds.forEach(function (id) {
			var el = document.getElementById(id);
			if (el) {
				el.disabled = isEffective;
				var row = el.closest(".settings-row");
				if (row) row.classList.toggle("readonly", isEffective);
			}
		});

		// Runtime controls: disabled in effective mode OR project scope (runtime is global-only)
		var runtimeIds = Object.keys(rtToggleMap).concat(Object.keys(rtSelectMap));
		runtimeIds.forEach(function (id) {
			var el = document.getElementById(id);
			if (el) {
				el.disabled = isEffective || isProject;
				var row = el.closest(".settings-row");
				if (row) row.classList.toggle("readonly", isEffective || isProject);
			}
		});
	}

	/**
	 * Apply cached settings to all UI controls based on current scope.
	 */
	function applySettingsToUI() {
		var settings = cachedSettings[currentScope] || {};
		var runtime = cachedSettings.runtime || {};

		// Settings selects
		Object.keys(csSelectMap).forEach(function (id) {
			setSelectValue(id, getNestedValue(settings, csSelectMap[id]));
		});

		// Settings toggles
		Object.keys(csToggleMap).forEach(function (id) {
			setCheckbox(id, getNestedValue(settings, csToggleMap[id]));
		});

		// Settings text
		Object.keys(csTextMap).forEach(function (id) {
			setTextValue(id, getNestedValue(settings, csTextMap[id]));
		});

		// Runtime toggles (always from runtime data)
		Object.keys(rtToggleMap).forEach(function (id) {
			setCheckbox(id, runtime[rtToggleMap[id]]);
		});

		// Runtime selects
		Object.keys(rtSelectMap).forEach(function (id) {
			setSelectValue(id, runtime[rtSelectMap[id]]);
		});
	}

	/**
	 * Called on settings-init with { effective, global, project, runtime }.
	 */
	window.updateClaudeSettings = function (data) {
		if (!data) return;
		cachedSettings = data;
		applySettingsToUI();
		updateControlStates();
	};

	/**
	 * Called on claude-settings-update after a write.
	 */
	window.onClaudeSettingsUpdate = function (data) {
		if (!data) return;
		cachedSettings = data;
		applySettingsToUI();
	};

	function setSelectValue(id, val) {
		var el = document.getElementById(id);
		if (!el) return;
		if (val !== undefined && val !== null) {
			el.value = String(val);
		} else {
			// vscode-single-select: set first option value
			var firstOpt = el.querySelector("vscode-option");
			if (firstOpt) el.value = firstOpt.getAttribute("value") || "";
		}
	}
	function setCheckbox(id, val) {
		var el = document.getElementById(id);
		if (el) el.checked = !!val;
	}
	function setTextValue(id, val) {
		var el = document.getElementById(id);
		if (!el) return;
		el.value = (val !== undefined && val !== null) ? String(val) : "";
	}

	window.updateHookUI = function (status) {
		var dot = document.getElementById("hookDot");
		var text = document.getElementById("hookStatusText");
		var sub = document.getElementById("hookStatusSub");
		var btn = document.getElementById("hookActionBtn");
		var gear1 = document.getElementById("btnSettings");
		var gear2 = document.getElementById("btnSettings2");
		var needsBadge = status !== "installed";
		if (gear1) gear1.classList.toggle("has-badge", needsBadge);
		if (gear2) gear2.classList.toggle("has-badge", needsBadge);
		if (status === "installed") {
			dot.className = "hook-dot ok";
			text.textContent = "Configured";
			sub.textContent = "Change tracking, OS notifications";
			btn.style.display = "none";
		} else if (status === "outdated") {
			dot.className = "hook-dot err";
			text.textContent = "Update available";
			sub.textContent = "New version of hooks and settings";
			btn.textContent = "Update";
			btn.style.display = "";
		} else {
			dot.className = "hook-dot err";
			text.textContent = "Not configured";
			sub.textContent = "Hooks and notifications";
			btn.textContent = "Install";
			btn.style.display = "";
		}
	};
})();
