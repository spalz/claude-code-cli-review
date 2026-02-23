// Settings — shortcuts display, hook status, CLI command
// Now rendered inside #settingsOverlay instead of a tab panel
(function () {
	"use strict";

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

	// Static button listeners (IDs remain the same as before)
	document.getElementById("hookActionBtn").addEventListener("click", function () {
		send("install-hook");
	});
	document.getElementById("cliSelect").addEventListener("change", function () {
		send("set-cli-command", { value: this.value });
	});
	document.getElementById("btnCustomizeKeys").addEventListener("click", function () {
		send("open-keybindings");
	});

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
