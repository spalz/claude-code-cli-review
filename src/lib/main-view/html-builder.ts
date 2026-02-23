import * as vscode from "vscode";

export function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const mediaUri = (file: string): vscode.Uri =>
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", file));
	const webviewUri = (file: string): vscode.Uri =>
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview", file));
	const codiconUri = webview.asWebviewUri(
		vscode.Uri.joinPath(vscode.Uri.file(vscode.env.appRoot), "out", "media", "codicon.ttf"),
	);

	const xtermCss = mediaUri("xterm.css");
	const xtermJs = mediaUri("xterm.min.js");
	const fitJs = mediaUri("addon-fit.min.js");
	const stylesCss = webviewUri("styles.css");
	const coreJs = webviewUri("core.js");
	const diagJs = webviewUri("diag.js");
	const sessionsJs = webviewUri("sessions.js");
	const terminalsJs = webviewUri("terminals.js");
	const reviewJs = webviewUri("review.js");
	const settingsJs = webviewUri("settings.js");
	const messageRouterJs = webviewUri("message-router.js");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
  style-src ${webview.cspSource} 'unsafe-inline';
  script-src ${webview.cspSource};
  font-src ${webview.cspSource};
  img-src ${webview.cspSource};">
<link rel="stylesheet" href="${xtermCss}">
<link rel="stylesheet" href="${stylesCss}">
<style>
@font-face{font-family:'codicon';src:url('${codiconUri}') format('truetype')}
</style>
</head>
<body>
<div class="root">

  <!-- HEADER BAR -->
  <div class="header-bar" id="headerBar">
    <!-- Session list mode -->
    <div id="headerSessionMode" class="header-mode">
      <span class="header-title">SESSIONS</span>
      <div class="header-actions">
        <span class="header-icon codicon codicon-refresh" id="btnRefresh" title="Refresh"></span>
        <span class="header-icon codicon codicon-add" id="btnNewChat" title="New Chat"></span>
        <span class="header-icon codicon codicon-settings-gear" id="btnSettings" title="Settings"></span>
      </div>
    </div>
    <!-- Terminal tabs mode -->
    <div id="headerTerminalMode" class="header-mode" style="display:none">
      <span class="header-icon codicon codicon-arrow-left" id="btnSessionsList" title="Sessions"></span>
      <div class="terminal-tabs-area" id="terminalBar"></div>
      <div class="header-actions">
        <span class="header-icon codicon codicon-add" id="btnNewChat2" title="New Chat"></span>
        <span class="header-icon codicon codicon-settings-gear" id="btnSettings2" title="Settings"></span>
      </div>
    </div>
  </div>

  <!-- REVIEW TOOLBAR (hidden by default) -->
  <div class="review-toolbar" id="reviewToolbar" style="display:none"></div>

  <!-- MAIN CONTENT -->
  <div class="content" id="mainContent">
    <div id="sessionsView">
      <div class="sessions-list" id="sessionsList"><div class="empty">Loading sessions...</div></div>
      <div class="archive-section" id="archiveSection" style="display:none">
        <button class="archive-toggle" id="archiveToggle">
          <span class="archive-arrow" id="archiveArrow">&#9654;</span>
          Archive
          <span class="archive-count" id="archiveCount"></span>
        </button>
        <div class="archive-list" id="archiveList" style="display:none"></div>
      </div>
    </div>
    <div id="terminalView" style="display:none">
      <div class="terminals-area" id="terminalsArea"></div>
    </div>
  </div>
  <div class="ctx-menu" id="ctxMenu" style="display:none"></div>
</div>

<!-- SETTINGS OVERLAY -->
<div class="settings-overlay" id="settingsOverlay" style="display:none">
  <div class="settings-header">
    <span class="header-title">SETTINGS</span>
    <span class="header-icon codicon codicon-close" id="btnCloseSettings" title="Close"></span>
  </div>
  <div class="settings-body">
    <div class="settings-section">
      <div class="settings-title">Integration</div>
      <div class="hook-status" id="hookStatusBox">
        <span class="hook-dot warn" id="hookDot"></span>
        <div class="hook-info">
          <div id="hookStatusText">Checking...</div>
          <div class="sub" id="hookStatusSub"></div>
        </div>
        <button class="btn primary" id="hookActionBtn" style="display:none">Install</button>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-title">CLI Command</div>
      <div class="settings-row">
        <span class="label">Command for sessions</span>
        <div class="select-wrap">
          <select id="cliSelect">
            <option value="claude">claude</option>
            <option value="happy">happy</option>
          </select>
        </div>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>Keyboard Shortcuts</span>
        <button class="btn" id="btnCustomizeKeys" style="font-size:10px;padding:2px 6px;text-transform:none;letter-spacing:0">Customize</button>
      </div>
      <div id="shortcutsContainer"><div style="font-size:12px;opacity:.4">Loading...</div></div>
      <div class="settings-title" style="margin-top:10px">Tips</div>
      <div style="font-size:12px;opacity:.6;line-height:1.5">
        Select code in editor and use the shortcut above to send file:line reference to the active Claude session.<br><br>
        Right-click a file in Explorer &rarr; <b>Send to Claude Session</b> to insert its path.<br><br>
        Paste an image (<b>Cmd+V</b>) into the terminal to send it as a file path.
      </div>
    </div>
  </div>
</div>

<!-- CONFIRMATION DIALOG -->
<div class="confirm-overlay" id="confirmOverlay" style="display:none">
  <div class="confirm-dialog">
    <p id="confirmMessage"></p>
    <div class="confirm-actions">
      <button class="btn" id="confirmCancel">Cancel</button>
      <button class="btn primary" id="confirmOk">Confirm</button>
    </div>
  </div>
</div>

<script src="${xtermJs}"></script>
<script src="${fitJs}"></script>
<script src="${coreJs}"></script>
<script src="${diagJs}"></script>
<script src="${sessionsJs}"></script>
<script src="${terminalsJs}"></script>
<script src="${reviewJs}"></script>
<script src="${settingsJs}"></script>
<script src="${messageRouterJs}"></script>
</body>
</html>`;
}
