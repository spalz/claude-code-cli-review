// Sessions list rendering, context menu, inline rename, popup
// Depends on: core.js (send, switchMode, showTerminalView)
// Exports: window.{renderSessions, updateOpenClaudeIds, findCachedSession, setActiveClaudeId, updateArchiveButton, renderArchivedSessions, handleRenameResult, _hasOpenSessions}
(function () {
    "use strict";

    var cachedSessions = [];
    var cachedArchivedSessions = [];
    var openClaudeIds = new Set();
    var lazyClaudeIds = new Set();
    var activeClaudeId = null;
    var ctxTarget = null;

    window.updateOpenClaudeIds = function (ids, lazyIds) {
        openClaudeIds = new Set(ids || []);
        lazyClaudeIds = new Set(lazyIds || []);
    };

    window._hasOpenSessions = function () {
        return openClaudeIds.size > 0;
    };

    window.setActiveClaudeId = function (id) {
        activeClaudeId = id;
    };

    window.getCachedSessions = function () {
        return cachedSessions;
    };

    window.findCachedSession = function (claudeId) {
        return (
            cachedSessions.find(function (x) {
                return x.id === claudeId;
            }) ||
            cachedArchivedSessions.find(function (x) {
                return x.id === claudeId;
            })
        );
    };

    // --- Sessions rendering ---

    window.renderSessions = function (sessions) {
        if (sessions) cachedSessions = sessions;
        if (sessions && window.diagLog)
            diagLog("session", "renderSessions", { count: sessions.length });
        var el = document.getElementById("sessionsList");
        if (!cachedSessions || cachedSessions.length === 0) {
            el.innerHTML =
                '<div class="empty">No sessions found<br><span class="sub">Click + to start a new Claude session</span></div>';
            return;
        }
        el.innerHTML = buildSessionListHtml(cachedSessions);
        bindSessionItems(el);
    };

    function buildSessionListHtml(sessions) {
        var html = "";
        var renamingId = pendingRename ? pendingRename.sessionId : null;
        sessions.forEach(function (s) {
            var date = new Date(s.timestamp);
            var ago = timeAgo(date);
            var msgs = s.messageCount ? s.messageCount + " msgs" : "";
            var meta = [ago, msgs].filter(Boolean).join(" \u00b7 ");
            var isOpen = openClaudeIds.has(s.id);
            var isLazy = lazyClaudeIds.has(s.id);
            var isActive = s.id === activeClaudeId;
            var isRenaming = s.id === renamingId;
            var dotClass = isOpen ? (isLazy ? "lazy" : "active") : "past";
            html +=
                '<div class="session-item' +
                (isActive ? " open" : "") +
                (isRenaming ? " renaming" : "") +
                '" data-sid="' +
                s.id +
                '">';
            html += '<span class="dot ' + dotClass + '"></span>';
            html += '<div class="info"><div class="session-title">' + esc(s.title) + "</div>";
            html +=
                '<div class="session-meta">' +
                esc(meta) +
                (isOpen ? (isLazy ? " &middot; suspended" : " &middot; running") : "") +
                "</div></div>";
            if (s.branch) html += '<span class="branch">' + esc(s.branch) + "</span>";
            html += "</div>";
        });
        return html;
    }

    function bindSessionItems(container) {
        container.querySelectorAll(".session-item").forEach(function (item) {
            var sid = item.dataset.sid;
            item.onclick = function () {
                resumeSession(sid, false);
            };
            item.oncontextmenu = function (e) {
                showCtxMenu(e, sid);
            };
        });
    }

    function timeAgo(date) {
        var sec = Math.floor((Date.now() - date.getTime()) / 1000);
        if (sec < 60) return "just now";
        if (sec < 3600) return Math.floor(sec / 60) + "m ago";
        if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
        return Math.floor(sec / 86400) + "d ago";
    }

    function resumeSession(claudeId, isArchived) {
        var item = document.querySelector('.session-item[data-sid="' + claudeId + '"]');
        if (item) item.style.opacity = "0.5";
        showSessionLoader("resume");
        if (isArchived) {
            send("unarchive-session", { sessionId: claudeId });
        }
        send("resume-claude-session", { claudeSessionId: claudeId });
    }

    // --- Context menu ---

    function showCtxMenu(e, sessionId, isArchived) {
        e.preventDefault();
        e.stopPropagation();
        var s = cachedSessions.find(function (x) {
            return x.id === sessionId;
        });
        var isOpen = openClaudeIds.has(sessionId);
        ctxTarget = {
            sessionId: sessionId,
            title: s ? s.title : "",
            isOpen: isOpen,
            isArchived: !!isArchived,
        };

        var menu = document.getElementById("ctxMenu");
        var items = [];
        if (isArchived) {
            items.push({ label: "Restore", value: "unarchive" });
            items.push({ separator: true });
            items.push({ label: "Delete", value: "delete" });
        } else {
            items.push({ label: "Rename", value: "rename" });
            if (isOpen) {
                items.push({ label: "Close session", value: "close" });
            }
            items.push({ separator: true });
            items.push({ label: "Archive", value: "archive" });
            items.push({ label: "Delete", value: "delete" });
        }
        menu.data = items;
        menu.style.left = e.clientX + "px";
        menu.style.top = e.clientY + "px";
        menu.show = true;
    }

    function hideCtxMenu() {
        var menu = document.getElementById("ctxMenu");
        menu.show = false;
    }

    // Handle context menu item selection
    document.getElementById("ctxMenu").addEventListener("vsc-context-menu-select", function (e) {
        var action = e.detail && e.detail.value;
        if (action) handleCtxAction(action);
    });

    document.addEventListener("click", hideCtxMenu);
    document.addEventListener("contextmenu", function (e) {
        if (!e.target.closest(".session-item") && !e.target.closest(".terminal-tab")) hideCtxMenu();
    });

    function handleCtxAction(action) {
        hideCtxMenu();
        if (!ctxTarget) return;
        var sessionId = ctxTarget.sessionId;
        var title = ctxTarget.title;

        if (action === "rename") {
            if (ctxTarget.termId != null) {
                window.startTabRename(ctxTarget.termId);
            } else {
                startInlineRename(sessionId, title);
            }
        } else if (action === "close") {
            send("close-session-by-claude-id", { claudeSessionId: sessionId });
        } else if (action === "reload") {
            if (ctxTarget.termId != null) {
                reopenTerminal(ctxTarget.termId);
            }
        } else if (action === "archive") {
            send("archive-session", { sessionId: sessionId });
        } else if (action === "unarchive") {
            send("unarchive-session", { sessionId: sessionId });
            // Reload archive list if open
            if (archiveOpen) {
                send("load-archived-sessions");
            }
        } else if (action === "delete") {
            showConfirm("Delete session permanently? This cannot be undone.", function () {
                send("delete-session", { sessionId: sessionId });
                // Reload archive list if the deleted session was archived
                if (ctxTarget && ctxTarget.isArchived && archiveOpen) {
                    send("load-archived-sessions");
                }
            });
        }
    }

    /** Set ctxTarget from external modules (e.g., terminals.js tab context menu) */
    window.setCtxTarget = function (target) {
        ctxTarget = target;
    };

    // --- Inline rename ---

    var pendingRename = null; // { sessionId, oldTitle }

    function startInlineRename(sessionId, currentTitle) {
        var item = document.querySelector('.session-item[data-sid="' + sessionId + '"]');
        if (!item) return;
        var titleEl = item.querySelector(".session-title");
        if (!titleEl) return;

        var input = document.createElement("input");
        input.type = "text";
        input.className = "inline-edit";
        input.value = currentTitle;
        titleEl.replaceWith(input);
        input.focus();
        input.select();

        item.onclick = null;

        var committed = false;
        function commit() {
            var newName = input.value.trim();
            if (newName && newName !== currentTitle) {
                // Optimistic update: change name in cache immediately
                pendingRename = { sessionId: sessionId, oldTitle: currentTitle };
                cachedSessions.forEach(function (s) {
                    if (s.id === sessionId) s.title = newName;
                });
                // Update tab name immediately too
                if (window.renameTerminalTab) renameTerminalTab(sessionId, newName);
                // Re-render list with new name + loading indicator
                renderSessions(null);
                // Send rename to extension (background process)
                send("rename-session", { sessionId: sessionId, newName: newName });
            } else {
                renderSessions(null);
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
                renderSessions(null);
            }
        };
    }

    window.handleRenameResult = function (claudeId, newName, success) {
        if (!success && pendingRename && pendingRename.sessionId === claudeId) {
            // Revert cached name on failure
            cachedSessions.forEach(function (s) {
                if (s.id === claudeId) s.title = pendingRename.oldTitle;
            });
            // Revert tab name
            if (window.revertTabRename) revertTabRename(claudeId);
        }
        pendingRename = null;
        // Re-render — removes renaming indicator
        renderSessions(null);
    };

    // --- View toggle ---

    window.showSessionsList = function () {
        var loader = document.getElementById("sessionLoader");
        if (loader) {
            diagLog("loading", "bar-removed", { reason: "showSessionsList" });
            loader.remove();
        }
        switchMode("sessions");
        send("refresh-sessions");
    };

    window._sessionsRestored = false;
    window.showTerminalView = function () {
        switchMode("terminals");
        if (!window._sessionsRestored) {
            window._sessionsRestored = true;
            send("request-restore-sessions");
        }
    };

    // --- Header button listeners ---

    document.getElementById("btnRefresh").addEventListener("click", function () {
        send("refresh-sessions");
    });
    function showSessionLoader(reason) {
        var existing = document.getElementById("sessionLoader");
        if (existing) return;
        var parent =
            window.viewMode === "terminals"
                ? document.getElementById("terminalView")
                : document.getElementById("sessionsView");
        if (!parent) return;
        var loader = document.createElement("div");
        loader.className = "loading-bar";
        loader.id = "sessionLoader";
        parent.insertBefore(loader, parent.firstChild);
        diagLog("loading", "bar-shown", { reason: reason, viewMode: window.viewMode });
    }

    document.getElementById("btnNewChat").addEventListener("click", function () {
        send("new-claude-session");
    });
    document.getElementById("btnSettings").addEventListener("click", function () {
        showSettings();
    });
    document.getElementById("btnNewChat2").addEventListener("click", function () {
        send("new-claude-session");
    });
    document.getElementById("btnSettings2").addEventListener("click", function () {
        showSettings();
    });
    document.getElementById("btnSessionsList").addEventListener("click", function () {
        showSessionsList();
    });

    // --- Archive section ---

    var archiveOpen = false;
    var archiveLoaded = false;

    window.updateArchiveButton = function (count) {
        var section = document.getElementById("archiveSection");
        var countEl = document.getElementById("archiveCount");
        if (count > 0) {
            section.style.display = "";
            countEl.textContent = count;
        } else {
            section.style.display = "none";
            // Reset state when no archived sessions
            archiveOpen = false;
            archiveLoaded = false;
            document.getElementById("archiveList").style.display = "none";
            document.getElementById("archiveArrow").classList.remove("open");
        }
    };

    function toggleArchive() {
        archiveOpen = !archiveOpen;
        var list = document.getElementById("archiveList");
        var arrow = document.getElementById("archiveArrow");
        if (archiveOpen) {
            list.style.display = "";
            arrow.classList.add("open");
            if (!archiveLoaded) {
                list.innerHTML =
                    '<div class="empty" style="padding:12px;font-size:12px">Loading...</div>';
                send("load-archived-sessions");
                archiveLoaded = true;
            }
        } else {
            list.style.display = "none";
            arrow.classList.remove("open");
        }
    }

    document.getElementById("archiveToggle").addEventListener("click", toggleArchive);

    window.renderArchivedSessions = function (sessions) {
        if (sessions) cachedArchivedSessions = sessions;
        var list = document.getElementById("archiveList");
        if (!sessions || sessions.length === 0) {
            list.innerHTML =
                '<div class="empty" style="padding:12px;font-size:12px">No archived sessions</div>';
            return;
        }
        list.innerHTML = buildSessionListHtml(sessions);
        list.querySelectorAll(".session-item").forEach(function (item) {
            var sid = item.dataset.sid;
            item.onclick = function () {
                resumeSession(sid, true);
            };
            item.oncontextmenu = function (e) {
                showCtxMenu(e, sid, true);
            };
        });
        // Reset loaded flag so next toggle will reload fresh data
        archiveLoaded = true;
    };
})();
