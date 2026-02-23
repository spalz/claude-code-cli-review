// Diagnostic logging — bridge webview logs to extension Output channel
// Tag: [scroll-diag] — filter in Output to see only diagnostics
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
		};
	};
})();
