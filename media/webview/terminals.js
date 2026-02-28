// Terminal management — xterm instances, tabs, paste, key handling
// Depends on: core.js (send, switchMode, showTerminalView, showSessionsList), diag.js (diagLog, diagLogThrottled, getTermBufferState), sessions.js (findCachedSession, setActiveClaudeId)
// Globals: Terminal, FitAddon, WebLinksAddon (loaded via <script> in HTML)
// Exports: window.{getTerminals, getActiveTerminalId, addTerminal, removeTerminal, activateTerminal, fitActiveTerminal, renameTerminalTab, revertTabRename, syncTabNamesFromSessions, annotateFileLinks, closeErrorTerminal, reopenTerminal, startTabRename}
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
    var pathRegex =
        /((?:~\/|\.{1,2}\/|\/|[a-zA-Z]:[\\/])[\w.\-\\/]+\.\w{1,10}|(?:[\w.\-]+\/)+[\w.\-]+\.\w{1,10})(?::(\d+))?(?::(\d+))?/g;
    // Splits stream into [ANSI escape sequences] and [plain text] chunks
    var ansiSplitRegex =
        /(\x1b(?:\[[0-9;:]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]))/;
    // Underline + grey underline color
    var LINK_START = "\x1b[4m\x1b[58;5;245m";
    // Reset underline + reset underline color
    var LINK_END = "\x1b[24m\x1b[59m";

    // --- Timing & size constants ---
    var FIT_DELAYS_MS = [100, 300, 800];
    var FIT_INNER_DELAY_MS = 50;
    var RESIZE_DEBOUNCE_MS = 100;
    var CTRL_C_DEBOUNCE_MS = 2000;
    var LOADING_OVERLAY_TIMEOUT_MS = 15000;
    var SCROLLBACK_LINES = 10000;
    var SCROLL_BOTTOM_THRESHOLD = 20;
    // Idle timeout to detect "loading complete" after resume.
    // After last terminal-output chunk, wait this long before declaring load done.
    var LOAD_IDLE_MS = 2000;

    window.annotateFileLinks = function (data) {
        var hasPath =
            data.indexOf("/") !== -1 || data.indexOf("\\") !== -1 || data.indexOf("~") !== -1;
        // Fast path: skip if nothing to annotate
        if (!hasPath) {
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
            diagLogThrottled("links", "annotated", {
                inLen: data.length,
                outLen: parts.join("").length,
                parts: parts.length,
            });
        }
        return parts.join("");
    };

    var nextPlaceholderId = -1;

    // --- addTerminal helpers ---

    /** Create tab DOM element for the terminal bar */
    function createTerminalTab(id, displayName, sessionRef, lazy) {
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
        return tab;
    }

    /** Create xterm instance with FitAddon and WebLinksAddon */
    function createXterm(container) {
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
            scrollback: SCROLLBACK_LINES,
            convertEol: true,
        });

        var fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);

        try {
            var webLinksAddon = new WebLinksAddon.WebLinksAddon(function (event, uri) {
                send("open-external-url", { url: uri });
            });
            term.loadAddon(webLinksAddon);
        } catch (err) {
            diagLog("links", "addon-FAILED", { error: String(err) });
        }

        term.open(container);
        return { term: term, fitAddon: fitAddon };
    }

    /** Register link provider for multi-line URLs that TUI cursor positioning breaks */
    function registerWrappedUrlLinkProvider(term) {
        // Characters that terminate a URL
        var URL_TERMINATORS = /[\s"'<>(){}\[\]|\\^`]/;

        function getLineText(buf, row) {
            var line = buf.getLine(row);
            return line ? line.translateToString(true) : "";
        }

        /** Scan forward from urlStart on startRow, collecting URL chars across lines */
        function scanForward(buf, startRow, urlStart, cols, maxRows) {
            var fullUrl = "";
            var text = getLineText(buf, startRow);
            // Grab from urlStart to end of line
            var chunk = text.substring(urlStart);
            // Find terminator in this chunk
            var termMatch = URL_TERMINATORS.exec(chunk);
            if (termMatch) {
                fullUrl = chunk.substring(0, termMatch.index);
                return { url: fullUrl, endRow: startRow, endCol: urlStart + termMatch.index };
            }
            fullUrl = chunk;
            // If line doesn't fill terminal width, URL ends here
            if (text.length < cols - 2) {
                return { url: fullUrl, endRow: startRow, endCol: urlStart + chunk.length };
            }
            // Scan next lines
            for (var r = startRow + 1; r < startRow + maxRows && r < buf.length; r++) {
                var nextText = getLineText(buf, r);
                // Stop if line is empty or starts with whitespace
                if (!nextText || /^\s/.test(nextText)) break;
                var term = URL_TERMINATORS.exec(nextText);
                if (term) {
                    fullUrl += nextText.substring(0, term.index);
                    return { url: fullUrl, endRow: r, endCol: term.index };
                }
                fullUrl += nextText;
                if (nextText.length < cols - 2) {
                    return { url: fullUrl, endRow: r, endCol: nextText.length };
                }
            }
            return { url: fullUrl, endRow: startRow + maxRows - 1, endCol: cols };
        }

        try {
            term.registerLinkProvider({
                provideLinks: function (y, callback) {
                    var buf = term.buffer.active;
                    var row = y - 1;
                    var cols = term.cols;
                    var text = getLineText(buf, row);
                    if (!text) return callback(undefined);

                    var links = [];
                    var MAX_SCAN = 10;

                    // Strategy 1: "down" — this line contains https?://
                    var urlRe = /https?:\/\//g;
                    var m;
                    while ((m = urlRe.exec(text)) !== null) {
                        var result = scanForward(buf, row, m.index, cols, MAX_SCAN);
                        diagLog("links", "wrappedUrl-scan-down", {
                            y: y,
                            textLen: text.length,
                            cols: cols,
                            urlStart: m.index,
                            resultUrl: result.url ? result.url.slice(0, 60) + "..." : null,
                            endRow: result.endRow,
                            startRow: row,
                            multiLine: result.endRow > row,
                        });
                        if (!result.url) continue;
                        // Only handle multi-line URLs (single-line handled by WebLinksAddon)
                        if (result.endRow <= row) continue;
                        try {
                            new URL(result.url);
                        } catch (_) {
                            diagLog("links", "wrappedUrl-invalid", {
                                url: result.url.slice(0, 80),
                            });
                            continue;
                        }
                        var fullUrl = result.url;
                        var startX = m.index + 1;
                        var endRow = result.endRow;
                        var endCol = result.endCol;
                        (function (url, sx, ey, ec) {
                            links.push({
                                range: { start: { x: sx, y: y }, end: { x: ec + 1, y: ey + 1 } },
                                text: url,
                                activate: function () {
                                    send("open-external-url", { url: url });
                                },
                            });
                        })(fullUrl, startX, endRow, endCol);
                    }

                    // Strategy 2: "up" — this line may be a continuation of a URL from above
                    if (!links.length && text && !/^\s/.test(text)) {
                        // Check if previous line is filled and contains https?://
                        var prevRow = row - 1;
                        if (prevRow >= 0) {
                            var prevText = getLineText(buf, prevRow);
                            if (
                                prevText &&
                                prevText.length >= cols - 2 &&
                                /https?:\/\//.test(prevText)
                            ) {
                                // Scan backwards to find start of URL
                                var urlStartRow = prevRow;
                                var urlStartCol = prevText.search(/https?:\/\//);
                                for (
                                    var r = prevRow - 1;
                                    r >= Math.max(0, prevRow - MAX_SCAN);
                                    r--
                                ) {
                                    var rText = getLineText(buf, r);
                                    var rIdx = rText.search(/https?:\/\//);
                                    if (rIdx >= 0) {
                                        urlStartRow = r;
                                        urlStartCol = rIdx;
                                    }
                                    if (rText.length < cols - 2) break;
                                }
                                var result = scanForward(
                                    buf,
                                    urlStartRow,
                                    urlStartCol,
                                    cols,
                                    MAX_SCAN,
                                );
                                if (result.url && result.endRow > urlStartRow) {
                                    try {
                                        new URL(result.url);
                                        var fullUrl = result.url;
                                        (function (url, sr, sc, er, ec) {
                                            links.push({
                                                range: {
                                                    start: { x: sc + 1, y: sr + 1 },
                                                    end: { x: ec + 1, y: er + 1 },
                                                },
                                                text: url,
                                                activate: function () {
                                                    send("open-external-url", { url: url });
                                                },
                                            });
                                        })(
                                            fullUrl,
                                            urlStartRow,
                                            urlStartCol,
                                            result.endRow,
                                            result.endCol,
                                        );
                                    } catch (_) {
                                        /* invalid URL */
                                    }
                                }
                            }
                        }
                    }

                    callback(links.length ? links : undefined);
                },
            });
        } catch (err) {
            diagLog("links", "wrappedUrlProvider-FAILED", { error: String(err) });
        }
    }

    /** Register clickable file-path link provider on a terminal */
    function registerFileLinkProvider(term) {
        try {
            term.registerLinkProvider({
                provideLinks: function (y, callback) {
                    var line = term.buffer.active.getLine(y - 1);
                    if (!line) return callback(undefined);
                    var text = line.translateToString();
                    if (!text) return callback(undefined);

                    pathRegex.lastIndex = 0;
                    var links = [];
                    var m;
                    while ((m = pathRegex.exec(text)) !== null) {
                        var filePath = m[1];
                        var ln = m[3] ? +m[2] : m[2] ? +m[2] : undefined;
                        var col = m[3] ? +m[3] : undefined;
                        var startX = m.index + 1;
                        var fullMatch = m[0];
                        (function (fp, l, c) {
                            links.push({
                                range: {
                                    start: { x: startX, y: y },
                                    end: { x: startX + fullMatch.length, y: y },
                                },
                                text: fullMatch,
                                activate: function () {
                                    send("open-file-link", { path: fp, line: l, column: c });
                                },
                            });
                        })(filePath, ln, col);
                    }
                    callback(links.length ? links : undefined);
                },
            });
        } catch (err) {
            diagLog("links", "linkProvider-FAILED", { error: String(err) });
        }
    }

    // --- Image registry and link provider ---

    var imageRegistry = new Map(); // CLI index → { base64, mimeType }
    /** Per-PTY-session pending image queues: ptyId → [{base64, mimeType, filePath}] */
    var pendingBySession = new Map();
    /** Track which CLI [Image #N] we've already bound per session */
    var boundBySession = new Map(); // ptyId → Set of CLI indices
    /** Per-session: CLI is in image edit mode (arrows/delete to manage images) */
    var imageEditModeBySession = new Map(); // ptyId → boolean
    /** All known image data by file path (for tooltip/open regardless of bind order) */
    var imageDataByPath = new Map(); // filePath → { base64, mimeType }

    window.enqueueImage = function (base64, mimeType, filePath, ptyId) {
        // Always store data by path for later lookup
        imageDataByPath.set(filePath, { base64: base64, mimeType: mimeType });
        // Skip FIFO queue if CLI is in image edit mode — paste won't create [Image #N]
        if (imageEditModeBySession.get(ptyId)) {
            diagLog("images", "enqueue-skipped-edit-mode", { ptyId: ptyId, filePath: filePath });
            return;
        }
        var q = pendingBySession.get(ptyId);
        if (!q) {
            q = [];
            pendingBySession.set(ptyId, q);
        }
        q.push({ base64: base64, mimeType: mimeType, filePath: filePath });
        diagLog("images", "enqueued", { ptyId: ptyId, queueLen: q.length, filePath: filePath });
    };

    /**
     * Called from message-router on every terminal-output chunk.
     * Detects CLI image edit mode and binds new [Image #N] to pending images.
     */
    window.processImageOutput = function (data, sessionId) {
        // Detect image edit mode: "Delete to remove" in CLI status line
        var isEditMode = data.indexOf("Delete to remove") !== -1;
        var wasEditMode = imageEditModeBySession.get(sessionId) || false;
        if (isEditMode !== wasEditMode) {
            imageEditModeBySession.set(sessionId, isEditMode);
            if (isEditMode) {
                diagLog("images", "edit-mode-enter", { ptyId: sessionId });
            } else {
                // Exiting edit mode: flush stale pending items that accumulated
                // during edit mode (shouldn't be any if enqueue was skipped, but safety)
                diagLog("images", "edit-mode-exit", { ptyId: sessionId });
            }
        }

        // Bind new [Image #N] from output
        if (data.indexOf("[Image #") === -1) return;
        var regex = /\[Image #(\d+)\]/g;
        var m;
        var bound = boundBySession.get(sessionId);
        if (!bound) {
            bound = new Set();
            boundBySession.set(sessionId, bound);
        }
        while ((m = regex.exec(data)) !== null) {
            var idx = +m[1];
            if (!bound.has(idx)) {
                bound.add(idx);
                var q = pendingBySession.get(sessionId);
                var pending = q ? q.shift() : undefined;
                if (pending) {
                    imageRegistry.set(idx, { base64: pending.base64, mimeType: pending.mimeType });
                    send("bind-image", { cliIndex: idx, ptyId: sessionId });
                    diagLog("images", "bound", {
                        ptyId: sessionId,
                        cliIndex: idx,
                        filePath: pending.filePath,
                        queueRemaining: q ? q.length : 0,
                    });
                } else {
                    diagLog("images", "no-pending-for", { ptyId: sessionId, cliIndex: idx });
                }
            }
        }
    };

    var imageTooltipEl = null;
    var TOOLTIP_GAP = 8; // gap between cursor and tooltip
    var TOOLTIP_PADDING = 4; // CSS padding inside tooltip
    var TOOLTIP_BORDER = 1; // CSS border width

    function showImageTooltip(index, x, y) {
        var img = imageRegistry.get(index);
        if (!img) return;
        hideImageTooltip();
        imageTooltipEl = document.createElement("div");
        imageTooltipEl.style.cssText =
            "position:fixed;z-index:9999;background:var(--vscode-editorHoverWidget-background,#252526);border:1px solid var(--vscode-editorHoverWidget-border,#454545);border-radius:4px;padding:" +
            TOOLTIP_PADDING +
            "px;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.3);visibility:hidden";
        var imgEl = document.createElement("img");
        imgEl.src = "data:" + img.mimeType + ";base64," + img.base64;
        imgEl.style.cssText = "max-width:300px;max-height:200px;display:block";
        imageTooltipEl.appendChild(imgEl);
        document.body.appendChild(imageTooltipEl);
        // Position after image loads (to know actual dimensions)
        imgEl.onload = function () {
            positionTooltip(x, y);
        };
        // Fallback: if cached, onload may not fire
        if (imgEl.complete) {
            positionTooltip(x, y);
        }
    }

    function positionTooltip(mouseX, mouseY) {
        if (!imageTooltipEl) return;
        var vw = document.documentElement.clientWidth;
        var vh = document.documentElement.clientHeight;
        var tw = imageTooltipEl.offsetWidth;
        var th = imageTooltipEl.offsetHeight;

        // Horizontal: prefer right of cursor, flip left if overflows
        var left = mouseX + TOOLTIP_GAP;
        if (left + tw > vw) {
            left = mouseX - TOOLTIP_GAP - tw;
        }
        // Clamp to viewport
        if (left < 0) left = 0;

        // Vertical: prefer above cursor, flip below if overflows
        var top = mouseY - TOOLTIP_GAP - th;
        if (top < 0) {
            top = mouseY + TOOLTIP_GAP;
        }
        // Clamp to viewport
        if (top + th > vh) {
            top = vh - th;
        }
        if (top < 0) top = 0;

        imageTooltipEl.style.left = left + "px";
        imageTooltipEl.style.top = top + "px";
        imageTooltipEl.style.visibility = "visible";
    }

    function hideImageTooltip() {
        if (imageTooltipEl) {
            imageTooltipEl.remove();
            imageTooltipEl = null;
        }
    }

    /** Register clickable [Image #N] link provider + mouseover tooltip on a terminal */
    function registerImageLinkProvider(term) {
        var imageTagRegex = /\[Image #(\d+)\]/g;
        try {
            // Link provider for click handling
            term.registerLinkProvider({
                provideLinks: function (y, callback) {
                    var line = term.buffer.active.getLine(y - 1);
                    if (!line) return callback(undefined);
                    var text = line.translateToString();
                    if (!text) return callback(undefined);

                    imageTagRegex.lastIndex = 0;
                    var links = [];
                    var m;
                    while ((m = imageTagRegex.exec(text)) !== null) {
                        var imgIndex = +m[1];
                        var startX = m.index + 1;
                        var fullMatch = m[0];
                        (function (idx, sx, len, lineY) {
                            links.push({
                                // end.x - 1 to work around xterm.js off-by-one link underline rendering
                                range: {
                                    start: { x: sx, y: lineY },
                                    end: { x: sx + len - 1, y: lineY },
                                },
                                text: fullMatch,
                                activate: function () {
                                    hideImageTooltip();
                                    send("open-image", { index: idx });
                                },
                            });
                        })(imgIndex, startX, fullMatch.length, y);
                    }
                    callback(links.length ? links : undefined);
                },
            });
            // Hover tooltip via mouse tracking on terminal element
            var currentHoverIndex = null;
            var hoverRegex = /\[Image #(\d+)\]/g;
            term.element.addEventListener("mousemove", function (e) {
                // Get cell coordinates from mouse position
                var core = term._core;
                if (!core || !core._renderService) {
                    hideImageTooltip();
                    currentHoverIndex = null;
                    return;
                }
                var dims = core._renderService.dimensions;
                if (!dims || !dims.css || !dims.css.cell) {
                    hideImageTooltip();
                    currentHoverIndex = null;
                    return;
                }
                var rect = term.element.getBoundingClientRect();
                var col = Math.floor((e.clientX - rect.left) / dims.css.cell.width);
                var row = Math.floor((e.clientY - rect.top) / dims.css.cell.height);
                var bufRow = row + term.buffer.active.viewportY;
                var line = term.buffer.active.getLine(bufRow);
                if (!line) {
                    hideImageTooltip();
                    currentHoverIndex = null;
                    return;
                }
                var text = line.translateToString();
                hoverRegex.lastIndex = 0;
                var found = null;
                var hm;
                while ((hm = hoverRegex.exec(text)) !== null) {
                    if (col >= hm.index && col < hm.index + hm[0].length) {
                        found = +hm[1];
                        break;
                    }
                }
                if (found !== null && imageRegistry.has(found)) {
                    if (currentHoverIndex !== found) {
                        currentHoverIndex = found;
                        showImageTooltip(found, e.clientX, e.clientY);
                    } else if (imageTooltipEl) {
                        positionTooltip(e.clientX, e.clientY);
                    }
                } else {
                    if (currentHoverIndex !== null) {
                        hideImageTooltip();
                        currentHoverIndex = null;
                    }
                }
            });
            term.element.addEventListener("mouseleave", function () {
                hideImageTooltip();
                currentHoverIndex = null;
            });
        } catch (err) {
            diagLog("links", "imageLinkProvider-FAILED", { error: String(err) });
        }
    }

    /** Register link provider for multi-line Write/Edit/Read file paths (Bug #4) */
    function registerWrappedPathLinkProvider(term) {
        var toolCallRegex = /(?:Write|Edit|Read)\(/g;

        function getLine(buf, row) {
            var line = buf.getLine(row);
            return line ? line.translateToString(true) : "";
        }

        try {
            term.registerLinkProvider({
                provideLinks: function (y, callback) {
                    var buf = term.buffer.active;
                    var row = y - 1;
                    var text = getLine(buf, row);
                    if (!text) return callback(undefined);

                    var links = [];

                    // Forward scan: this line has Write(/Edit(/Read( with unclosed paren
                    toolCallRegex.lastIndex = 0;
                    var m;
                    while ((m = toolCallRegex.exec(text)) !== null) {
                        var pathStart = m.index + m[0].length;
                        var rest = text.substring(pathStart);
                        if (rest.indexOf(")") !== -1) continue; // closed on same line

                        var fullPath = rest;
                        var endRow = row;
                        var endCol = text.length;
                        for (var r = row + 1; r < Math.min(row + 6, buf.length); r++) {
                            var nextText = getLine(buf, r);
                            var trimmed = nextText.trim();
                            if (!trimmed) break;
                            var cp = trimmed.indexOf(")");
                            if (cp !== -1) {
                                fullPath += trimmed.substring(0, cp);
                                endRow = r;
                                endCol = nextText.indexOf(")");
                                break;
                            }
                            fullPath += trimmed;
                            endRow = r;
                            endCol = nextText.length;
                        }

                        fullPath = fullPath.replace(/\s+/g, "").trim();
                        if (!fullPath || fullPath.indexOf("/") === -1) continue;

                        var filePath = fullPath;
                        var ln, col;
                        var lm = filePath.match(/:(\d+)(?::(\d+))?$/);
                        if (lm) {
                            filePath = filePath.substring(0, lm.index);
                            ln = +lm[1];
                            col = lm[2] ? +lm[2] : undefined;
                        }

                        (function (fp, l, c, sx, sy, ex, ey) {
                            links.push({
                                range: { start: { x: sx, y: sy }, end: { x: ex + 1, y: ey + 1 } },
                                text: fp,
                                activate: function () {
                                    send("open-file-link", { path: fp, line: l, column: c });
                                },
                            });
                        })(filePath, ln, col, pathStart + 1, y, endCol, endRow);
                    }

                    // Backward scan: this line is a continuation of a tool call from above
                    if (!links.length && text.trim()) {
                        for (var pr = row - 1; pr >= Math.max(0, row - 5); pr--) {
                            var prevText = getLine(buf, pr);
                            toolCallRegex.lastIndex = 0;
                            var pm = toolCallRegex.exec(prevText);
                            if (pm && prevText.indexOf(")", pm.index + pm[0].length) === -1) {
                                // Found unclosed tool call — build full path from pm line through current
                                var fp2 = prevText.substring(pm.index + pm[0].length);
                                var eRow = pr;
                                var eCol = prevText.length;
                                for (
                                    var r2 = pr + 1;
                                    r2 <= Math.min(row + 3, buf.length - 1);
                                    r2++
                                ) {
                                    var lt = getLine(buf, r2);
                                    var t2 = lt.trim();
                                    if (!t2) break;
                                    var cp2 = t2.indexOf(")");
                                    if (cp2 !== -1) {
                                        fp2 += t2.substring(0, cp2);
                                        eRow = r2;
                                        eCol = lt.indexOf(")");
                                        break;
                                    }
                                    fp2 += t2;
                                    eRow = r2;
                                    eCol = lt.length;
                                }
                                fp2 = fp2.replace(/\s+/g, "").trim();
                                if (fp2 && fp2.indexOf("/") !== -1) {
                                    var lm2 = fp2.match(/:(\d+)(?::(\d+))?$/);
                                    var f = fp2,
                                        l2,
                                        c2;
                                    if (lm2) {
                                        f = fp2.substring(0, lm2.index);
                                        l2 = +lm2[1];
                                        c2 = lm2[2] ? +lm2[2] : undefined;
                                    }
                                    (function (fp, l, c, sx, sy, ex, ey) {
                                        links.push({
                                            range: {
                                                start: { x: sx, y: sy },
                                                end: { x: ex + 1, y: ey + 1 },
                                            },
                                            text: fp,
                                            activate: function () {
                                                send("open-file-link", {
                                                    path: fp,
                                                    line: l,
                                                    column: c,
                                                });
                                            },
                                        });
                                    })(f, l2, c2, pm.index + pm[0].length + 1, pr + 1, eCol, eRow);
                                }
                                break;
                            }
                        }
                    }

                    callback(links.length ? links : undefined);
                },
            });
        } catch (err) {
            diagLog("links", "wrappedPathProvider-FAILED", { error: String(err) });
        }
    }

    /** Wire up onData (slash guard, input forwarding), onScroll, onResize */
    function setupDataHandler(term, sessionRef, entry) {
        var cmdBuf = "";
        term.onData(function (data) {
            if (data === "\r") {
                entry.lastInputTime = Date.now();
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
        term.onScroll(function (newY) {
            diagLogThrottled("scroll", "onScroll", {
                sid: sessionRef.id,
                newY: newY,
                baseY: term.buffer.active.baseY,
                cursorY: term.buffer.active.cursorY,
                viewportY: term.buffer.active.viewportY,
            });
        });
        term.onResize(function (size) {
            send("terminal-resize", { sessionId: sessionRef.id, cols: size.cols, rows: size.rows });
        });
    }

    /** Create loading overlay with skeleton logo, auto-removes after timeout */
    function createLoadingOverlay(container, id) {
        var overlay = document.createElement("div");
        overlay.className = "term-loading-overlay";
        overlay.innerHTML =
            "" +
            '<div class="sk">' +
            '<pre class="sk-logo">' +
            "\u2590\u259B\u2588\u2588\u2588\u259C\u258C\n" +
            "\u259D\u259C\u2588\u2588\u2588\u2588\u2588\u259B\u2598\n" +
            "\u2598\u2598 \u259D\u259D" +
            "</pre>" +
            '<div class="sk-status">Starting session\u2026</div>' +
            "</div>";
        container.appendChild(overlay);
        setTimeout(function () {
            if (overlay.parentElement) {
                overlay.remove();
                var e = terminals.get(id);
                if (e) e.loadingOverlay = null;
            }
        }, LOADING_OVERLAY_TIMEOUT_MS);
        return overlay;
    }

    // --- addTerminal orchestrator ---

    window.addTerminal = function (id, name, claudeId, silent, lazy) {
        if (lazy && id === -1) id = nextPlaceholderId--;

        var displayName = name;
        if (claudeId) {
            var s = findCachedSession(claudeId);
            if (s) displayName = s.title;
        }

        var sessionRef = { id: id };
        var tab = createTerminalTab(id, displayName, sessionRef, lazy);

        var container = document.createElement("div");
        container.className = "term-container";
        container.id = "term-" + id;
        document.getElementById("terminalsArea").appendChild(container);

        var xt = createXterm(container);
        registerFileLinkProvider(xt.term);
        registerWrappedUrlLinkProvider(xt.term);
        registerWrappedPathLinkProvider(xt.term);
        registerImageLinkProvider(xt.term);
        setupKeyHandler(xt.term, sessionRef);
        blockXtermPaste(xt.term);

        var entry = {
            id: id,
            name: displayName,
            claudeId: claudeId,
            term: xt.term,
            fitAddon: xt.fitAddon,
            container: container,
            tabEl: tab,
            loadingOverlay: createLoadingOverlay(container, id),
            lazy: !!lazy,
            sessionRef: sessionRef,
            // When restoring (silent), mark as "initial loading" — always scroll to bottom
            // until output goes idle for LOAD_IDLE_MS, signaling CLI finished rendering.
            initialLoading: !!silent,
            loadIdleTimer: null,
        };
        terminals.set(id, entry);

        setupDataHandler(xt.term, sessionRef, entry);

        // Push prompt below review toolbar overlay (position:absolute, ~37px tall).
        // Unconditional: 2 blank lines are harmless when toolbar is hidden,
        // and necessary when it's visible (toolbar state may not be set yet).
        xt.term.write("\r\n\r\n");

        diagLog("terminal", "created", {
            id: id,
            name: displayName,
            claudeId: claudeId,
            total: terminals.size,
            silent: !!silent,
        });

        if (!silent) {
            activateTerminal(id);
            showTerminalView();
            FIT_DELAYS_MS.forEach(function (ms) {
                setTimeout(function () {
                    fitActiveTerminal("addTerminal");
                }, ms);
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
        var prevEntry = previousId ? terminals.get(previousId) : null;
        var entry = terminals.get(id);

        // Lazy tab — request PTY spawn on first activation
        if (entry && entry.lazy && !entry.lazyRequested) {
            entry.lazyRequested = true;
            diagLog("terminal", "lazy-resume", { id: id, claudeId: entry.claudeId });
            send("lazy-resume", { claudeId: entry.claudeId, placeholderPtyId: id });
        }

        activeTerminalId = id;
        diagLog("scroll-diag", "activate", {
            newId: id,
            prevId: previousId,
            total: terminals.size,
            prevBuf: getTermBufferState(prevEntry),
            newBuf: getTermBufferState(entry),
        });
        terminals.forEach(function (t, tid) {
            t.container.classList.toggle("active", tid === id);
            t.tabEl.classList.toggle("active", tid === id);
        });
        if (entry) entry.tabEl.scrollIntoView({ block: "nearest", inline: "nearest" });
        var claudeIdVal = entry ? entry.claudeId || null : null;
        if (window.setActiveClaudeId) setActiveClaudeId(claudeIdVal);
        send("set-active-session", { claudeId: claudeIdVal });
        fitActiveTerminal("activateTerminal");
        // Focus terminal so user can type immediately
        if (entry && entry.term) {
            setTimeout(function () {
                entry.term.focus();
            }, 60);
        }
    }
    window.activateTerminal = activateTerminal;

    window.fitActiveTerminal = function (caller, _retries) {
        if (!activeTerminalId) return;
        var t = terminals.get(activeTerminalId);
        if (t && window.viewMode === "terminals") {
            setTimeout(function () {
                try {
                    // Skip fit if container has zero size (tab not yet visible).
                    // Retry up to 5 times with increasing delay to handle tab switch transitions.
                    if (!t.container.offsetWidth || !t.container.offsetHeight) {
                        var attempt = (_retries || 0) + 1;
                        if (attempt <= 5) {
                            diagLog("scroll-diag", "fit-retry-zero", {
                                caller: caller,
                                sid: activeTerminalId,
                                attempt: attempt,
                            });
                            setTimeout(function () {
                                fitActiveTerminal(caller, attempt);
                            }, attempt * 100);
                        }
                        return;
                    }
                    var buf = t.term.buffer.active;
                    var wasAtBottom = buf.baseY - buf.viewportY <= SCROLL_BOTTOM_THRESHOLD;
                    var savedY = buf.viewportY;
                    t.fitAddon.fit();
                    if (wasAtBottom) {
                        // User was at bottom before fit — stay at bottom after
                        t.term.scrollToBottom();
                    } else if (savedY > 0) {
                        // User was scrolled up — try to preserve position
                        t.term.scrollToLine(savedY);
                    }
                } catch (e) {
                    /* ignore */
                }
            }, FIT_INNER_DELAY_MS);
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

    window.startTabRename = startTabRename;

    // --- Tab context menu ---

    function showTabCtxMenu(e, termId) {
        e.preventDefault();
        e.stopPropagation();
        var t = terminals.get(termId);
        var menu = document.getElementById("ctxMenu");
        window.setCtxTarget({
            sessionId: t ? t.claudeId : null,
            title: t ? t.name : "",
            termId: termId,
        });
        menu.data = [
            { label: "Rename", value: "rename" },
            { label: "Reload", value: "reload" },
            { separator: true },
            { label: "Close session", value: "close" },
        ];
        menu.style.left = e.clientX + "px";
        menu.style.top = e.clientY + "px";
        menu.show = true;
    }

    // --- Paste interception ---
    // xterm.js registers its own paste listeners on term.textarea and term.element
    // in bubble phase. We block them via capture phase to prevent duplicate paste
    // (our read-clipboard already handles paste via extension-side clipboard API).

    function blockXtermPaste(term) {
        var blocker = function (e) {
            e.preventDefault();
            e.stopImmediatePropagation();
        };
        if (term.textarea) {
            term.textarea.addEventListener("paste", blocker, true);
        }
        if (term.element) {
            term.element.addEventListener("paste", blocker, true);
        }
    }

    // --- Key handler ---

    function setupKeyHandler(term, sessionRef) {
        var lastCtrlC = 0;
        term.attachCustomKeyEventHandler(function (event) {
            // Block Shift+Enter for ALL event types (keydown, keypress, keyup)
            // to prevent xterm.js from sending an extra CR after our ESC+CR
            if (event.shiftKey && event.key === "Enter") {
                if (event.type === "keydown") {
                    send("terminal-input", { sessionId: sessionRef.id, data: "\x1b\r" });
                }
                return false;
            }
            // Block Cmd+V / Ctrl+V for ALL event types (keydown, keypress, keyup)
            // to prevent xterm.js from sending parasitic empty bracket paste.
            // Only send read-clipboard on keydown.
            if (event.key === "v" && (event.metaKey || event.ctrlKey)) {
                if (event.type === "keydown") {
                    send("read-clipboard", { sessionId: sessionRef.id });
                }
                return false;
            }

            if (event.type !== "keydown") return true;

            if (event.ctrlKey && event.key === "c") {
                var now = Date.now();
                if (now - lastCtrlC < CTRL_C_DEBOUNCE_MS) return false;
                lastCtrlC = now;
                return true;
            }
            if (event.ctrlKey && event.key === "d") return false; // Block EOF — kills PTY session
            if (event.ctrlKey && event.key === "z") return false; // Block suspend — no fg in embedded PTY
            if (event.ctrlKey && event.key === "\\") return false; // Block SIGQUIT — crashes session
            return true;
        });
    }

    // Sync tab names from fresh sessions data (called on sessions-list update)
    window.syncTabNamesFromSessions = function (sessions) {
        if (!sessions) return;
        terminals.forEach(function (t) {
            if (!t.claudeId) return;
            var s = sessions.find(function (x) {
                return x.id === t.claudeId;
            });
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

    document.getElementById("terminalBar").addEventListener(
        "wheel",
        function (e) {
            e.preventDefault();
            this.scrollLeft += e.deltaY || e.deltaX;
        },
        { passive: false },
    );

    // --- ResizeObserver ---

    var roDebounceTimer = null;
    var ro = new ResizeObserver(function () {
        var area = document.getElementById("terminalsArea");
        var toolbar = document.getElementById("reviewToolbar");
        var activeEntry = activeTerminalId ? terminals.get(activeTerminalId) : null;
        diagLog("scroll-diag", "ResizeObserver", {
            area: area ? { w: area.clientWidth, h: area.clientHeight } : null,
            toolbar: toolbar ? { display: toolbar.style.display, h: toolbar.offsetHeight } : null,
            buf: getTermBufferState(activeEntry),
        });
        clearTimeout(roDebounceTimer);
        roDebounceTimer = setTimeout(function () {
            fitActiveTerminal("ResizeObserver");
        }, RESIZE_DEBOUNCE_MS);
    });
    ro.observe(document.getElementById("terminalsArea"));
})();
