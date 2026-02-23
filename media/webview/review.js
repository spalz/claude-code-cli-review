// Review toolbar rendering — compact toolbar replacing the old review panel
(function () {
	"use strict";

	var currentFilePath = null;

	window.getCurrentFilePath = function () {
		return currentFilePath;
	};
	window.setCurrentFilePath = function (fp) {
		currentFilePath = fp;
	};

	window.goToFile = function (fp) {
		send("go-to-file", { filePath: fp });
	};
	window.acceptFile = function (fp) {
		send("accept-file", { filePath: fp });
	};
	window.rejectFile = function (fp) {
		send("reject-file", { filePath: fp });
	};
	window.acceptCurrentFile = function () {
		if (currentFilePath) send("accept-file", { filePath: currentFilePath });
	};
	window.rejectCurrentFile = function () {
		if (currentFilePath) send("reject-file", { filePath: currentFilePath });
	};

	// Event delegation on review toolbar
	document.getElementById("reviewToolbar").addEventListener("click", function (e) {
		var btn = e.target.closest("[data-action]");
		if (!btn) return;
		e.stopPropagation();

		var action = btn.dataset.action;
		switch (action) {
			case "prev-hunk":
				send("navigate-hunk", { direction: -1 });
				break;
			case "next-hunk":
				send("navigate-hunk", { direction: 1 });
				break;
			case "keep-current-file":
				send("keep-current-file");
				break;
			case "undo-current-file":
				send("undo-current-file");
				break;
			case "prev-file":
				send("prev-file");
				break;
			case "next-file":
				send("next-file");
				break;
			case "accept-all":
				showConfirm("Accept all remaining changes?", function () {
					send("accept-all-confirm");
				});
				break;
			case "reject-all":
				showConfirm("Reject all remaining changes?", function () {
					send("reject-all-confirm");
				});
				break;
			case "review-next-file":
				send("review-next-file");
				break;
		}
	});

	/**
	 * Render the review toolbar based on current state.
	 * State A: user has an active review file open — full navigation toolbar
	 * State B: review files exist but user is not viewing one — "Review next file" button
	 * State C: no review files — toolbar hidden
	 */
	window.renderReviewToolbar = function (data) {
		if (!data) return;

		var toolbar = document.getElementById("reviewToolbar");
		var remaining = data.remaining;
		var total = data.total;
		var unresolvedHunks = data.unresolvedHunks;
		var totalHunks = data.totalHunks;
		var activeEditorInReview = data.activeEditorInReview;
		var currentHunkIndex = data.currentHunkIndex;
		var currentFileIndex = data.currentFileIndex;
		var unresolvedFileCount = data.unresolvedFileCount;
		var canUndo = data.canUndo;
		var canRedo = data.canRedo;
		var noReview = remaining === 0 && data.files.length === 0;

		// State C: no review — hide toolbar
		if (noReview) {
			toolbar.style.display = "none";
			toolbar.innerHTML = "";
			return;
		}

		toolbar.style.display = "";

		// State B: review exists but user not in a review file
		if (!activeEditorInReview) {
			toolbar.innerHTML =
				'<button class="toolbar-btn-text warning" data-action="review-next-file">' +
				"\u25B6 Review next file (" +
				remaining +
				"/" +
				total +
				")" +
				"</button>";
			return;
		}

		// State A: full toolbar
		var html = "";

		// Hunk navigation group
		html += '<div class="toolbar-group">';
		html +=
			'<button class="toolbar-btn" data-action="prev-hunk" title="Previous change (\u2318[)">\u25B2</button>';
		html +=
			'<span class="toolbar-label">' +
			(currentHunkIndex + 1) +
			"/" +
			unresolvedHunks +
			"</span>";
		html +=
			'<button class="toolbar-btn" data-action="next-hunk" title="Next change (\u2318])">\u25BC</button>';
		html += "</div>";

		// Separator
		html += '<div class="toolbar-separator"></div>';

		// Keep/Undo current file group
		html += '<div class="toolbar-group">';
		html +=
			'<button class="toolbar-btn-text accent" data-action="keep-current-file" title="Keep file changes">Keep</button>';
		html +=
			'<button class="toolbar-btn-text" data-action="undo-current-file" title="Undo file changes">Undo</button>';
		html += "</div>";

		// Separator
		html += '<div class="toolbar-separator"></div>';

		// File navigation group (hide arrows if only 1 file)
		html += '<div class="toolbar-group">';
		if (total > 1) {
			html +=
				'<button class="toolbar-btn" data-action="prev-file" title="Previous file">\u25C0</button>';
		}
		html +=
			'<span class="toolbar-label">' +
			(currentFileIndex + 1) +
			"/" +
			total +
			"</span>";
		if (total > 1) {
			html +=
				'<button class="toolbar-btn" data-action="next-file" title="Next file">\u25B6</button>';
		}
		html += "</div>";

		// Accept/Reject All (pushed to right)
		html += '<div class="toolbar-group" style="margin-left:auto">';
		html +=
			'<button class="toolbar-btn-text accept-all" data-action="accept-all" title="Accept all remaining"' +
			(remaining === 0 ? " disabled" : "") +
			">Accept All</button>";
		html +=
			'<button class="toolbar-btn reject-all" data-action="reject-all" title="Reject all remaining"' +
			(remaining === 0 ? " disabled" : "") +
			'><span class="codicon codicon-close"></span></button>';
		html += "</div>";

		toolbar.innerHTML = html;
	};
})();
