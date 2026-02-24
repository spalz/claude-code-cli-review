// Diagnostic logging — bridge webview logs to extension Output channel
// Tag: [scroll-diag] — filter in Output to see only diagnostics
// Depends on: core.js (send)
// Exports: window.{diagLog, diagLogThrottled, diagHex, getTermBufferState}
(function () {
	"use strict";

	var throttleTimers = {};

	window.diagLog = function (category, message, data) {
		send("diag-log", {
			category: category,
			message: message,
			data: data || null,
			timestamp: Date.now(),
		});
	};

	window.diagLogThrottled = function (category, message, data) {
		if (throttleTimers[category]) return;
		throttleTimers[category] = setTimeout(function () {
			delete throttleTimers[category];
		}, 250);
		window.diagLog(category, message, data);
	};

	window.diagHex = function (str) {
		var hex = [];
		for (var i = 0; i < str.length; i++) {
			hex.push(str.charCodeAt(i).toString(16).padStart(2, "0"));
		}
		return hex.join(" ");
	};

	window.getTermBufferState = function (termEntry) {
		if (!termEntry || !termEntry.term) return null;
		var buf = termEntry.term.buffer.active;
		return {
			baseY: buf.baseY,
			cursorY: buf.cursorY,
			viewportY: buf.viewportY,
			length: buf.length,
			cols: termEntry.term.cols,
			rows: termEntry.term.rows,
			bufType: buf.type,
		};
	};
})();
