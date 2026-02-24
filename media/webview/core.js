// Core utilities — loaded first, provides globals for other webview modules
(function () {
	"use strict";

	var vsc = acquireVsCodeApi();

	window.send = function (type, data) {
		vsc.postMessage({ type: type, ...(data || {}) });
	};

	window.esc = function (s) {
		return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	};

	window.escAttr = function (s) {
		return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
	};

	// View mode management (replaces tab system)
	window.viewMode = "sessions";

	window.switchMode = function (mode, skipPersist) {
		var previousMode = window.viewMode;
		window.viewMode = mode;
		if (!skipPersist) {
			send("set-view-mode", { mode: mode });
		}
		if (window.diagLog) diagLog("view", "switchMode", { from: previousMode, to: mode });
		var sessionMode = document.getElementById("headerSessionMode");
		var terminalMode = document.getElementById("headerTerminalMode");
		var sessionsView = document.getElementById("sessionsView");
		var terminalView = document.getElementById("terminalView");

		if (mode === "sessions") {
			sessionMode.style.display = "";
			terminalMode.style.display = "none";
			sessionsView.classList.remove("hidden");
			terminalView.classList.remove("active");
			terminalView.style.display = "none";
		} else {
			sessionMode.style.display = "none";
			terminalMode.style.display = "";
			sessionsView.classList.add("hidden");
			terminalView.classList.add("active");
			terminalView.style.display = "";
			if (window.fitActiveTerminal) {
				setTimeout(window.fitActiveTerminal, 50);
			}
		}
	};

	// Confirmation dialog
	var confirmCallback = null;

	window.showConfirm = function (message, onConfirm) {
		var overlay = document.getElementById("confirmOverlay");
		document.getElementById("confirmMessage").textContent = message;
		confirmCallback = onConfirm;
		overlay.style.display = "";
	};

	window.hideConfirm = function () {
		document.getElementById("confirmOverlay").style.display = "none";
		confirmCallback = null;
	};

	document.getElementById("confirmOk").addEventListener("click", function () {
		if (confirmCallback) confirmCallback();
		hideConfirm();
	});
	document.getElementById("confirmCancel").addEventListener("click", function () {
		hideConfirm();
	});

	// Popup toggle
	window.togglePopup = function (id) {
		var el = document.getElementById(id);
		if (el.style.display === "none") {
			el.style.display = "";
		} else {
			el.style.display = "none";
		}
	};

	// Settings overlay
	window.showSettings = function () {
		document.getElementById("settingsOverlay").style.display = "";
		send("check-hook-status");
	};

	window.hideSettings = function () {
		document.getElementById("settingsOverlay").style.display = "none";
	};

	document.getElementById("btnCloseSettings").addEventListener("click", function () {
		hideSettings();
	});

	// Onboarding overlay
	window.showOnboarding = function (data) {
		document.getElementById("onboardingPath").textContent = data.workspacePath || data.folderName;
		document.getElementById("onboardingInstallHooks").checked = !data.hooksInstalled;
		document.getElementById("onboardingHooksRow").style.display = data.hooksInstalled ? "none" : "";
		document.getElementById("onboardingOverlay").style.display = "";
	};

	window.hideOnboarding = function () {
		document.getElementById("onboardingOverlay").style.display = "none";
	};

	document.getElementById("onboardingStart").addEventListener("click", function () {
		var installHooks = document.getElementById("onboardingInstallHooks").checked;
		hideOnboarding();
		send("onboarding-complete", { installHooks: installHooks });
	});

	document.getElementById("onboardingCancel").addEventListener("click", function () {
		hideOnboarding();
	});

})();
