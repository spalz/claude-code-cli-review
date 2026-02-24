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
	const webLinksJs = mediaUri("xterm-addon-web-links.js");
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
      <div class="settings-row">
        <span class="label">OS notifications</span>
        <label class="toggle"><input type="checkbox" id="ts_osNotifications" checked><span class="toggle-slider"></span></label>
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
      <div class="settings-title">Terminal</div>
      <div class="settings-row">
        <span class="label">Shell</span>
        <div class="select-wrap">
          <select id="ts_shell">
            <option value="auto">auto (from $SHELL)</option>
            <option value="bash">bash</option>
            <option value="zsh">zsh</option>
            <option value="fish">fish</option>
            <option value="powershell">powershell</option>
            <option value="custom">custom</option>
          </select>
        </div>
      </div>
      <div class="settings-row" id="shellPathRow" style="display:none">
        <span class="label">Shell path</span>
        <input type="text" class="settings-text-input" id="ts_shellPath" placeholder="/usr/local/bin/bash">
      </div>
      <div class="settings-row">
        <span class="label">Login shell (-l)</span>
        <label class="toggle"><input type="checkbox" id="ts_loginShell" checked><span class="toggle-slider"></span></label>
      </div>
      <div class="settings-row">
        <span class="label">Clean environment</span>
        <label class="toggle"><input type="checkbox" id="ts_cleanEnv"><span class="toggle-slider"></span></label>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>Claude CLI</span>
        <div class="scope-toggle" id="scopeToggle">
          <button class="scope-btn active" data-scope="effective">Effective</button>
          <button class="scope-btn" data-scope="global">Global</button>
          <button class="scope-btn" data-scope="project">Project</button>
        </div>
      </div>

      <div class="settings-row">
        <span class="label">Theme</span>
        <div class="select-wrap">
          <select id="cs_theme">
            <option value="dark">dark</option>
            <option value="light">light</option>
            <option value="light-daltonized">light-daltonized</option>
            <option value="dark-daltonized">dark-daltonized</option>
            <option value="auto">auto</option>
          </select>
        </div>
      </div>

      <div class="settings-row">
        <span class="label">Output style</span>
        <div class="select-wrap">
          <select id="cs_outputStyle">
            <option value="default">default</option>
            <option value="concise">concise</option>
            <option value="verbose">verbose</option>
            <option value="markdown">markdown</option>
            <option value="explanatory">explanatory</option>
          </select>
        </div>
      </div>

      <div class="settings-row">
        <span class="label">Editor mode</span>
        <div class="select-wrap">
          <select id="cs_editorMode">
            <option value="normal">normal</option>
            <option value="vim">vim</option>
            <option value="emacs">emacs</option>
          </select>
        </div>
      </div>

      <div class="settings-row">
        <span class="label">Permission mode</span>
        <div class="select-wrap">
          <select id="cs_permissionMode">
            <option value="default">default</option>
            <option value="plan">plan</option>
            <option value="acceptEdits">acceptEdits</option>
            <option value="fullAuto">fullAuto</option>
            <option value="bypassPermissions">bypassPermissions</option>
          </select>
        </div>
      </div>

      <div class="settings-row">
        <span class="label">Default model</span>
        <input type="text" class="settings-text-input" id="cs_model" placeholder="e.g. claude-sonnet-4-6">
      </div>

      <div class="settings-row">
        <span class="label">Language</span>
        <input type="text" class="settings-text-input" id="cs_language" placeholder="e.g. ru, en">
      </div>

      <div class="settings-row">
        <span class="label">Thinking mode</span>
        <label class="toggle"><input type="checkbox" id="cs_thinkingMode"><span class="toggle-slider"></span></label>
      </div>
      <div class="settings-row">
        <span class="label">Respect .gitignore</span>
        <label class="toggle"><input type="checkbox" id="cs_respectGitignore"><span class="toggle-slider"></span></label>
      </div>
      <div class="settings-row">
        <span class="label">Terminal progress bar</span>
        <label class="toggle"><input type="checkbox" id="cs_terminalProgressBar"><span class="toggle-slider"></span></label>
      </div>
      <div class="settings-row">
        <span class="label">Reduce motion</span>
        <label class="toggle"><input type="checkbox" id="cs_reduceMotion"><span class="toggle-slider"></span></label>
      </div>
      <div class="settings-row">
        <span class="label">Show spinner tips</span>
        <label class="toggle"><input type="checkbox" id="cs_showTips"><span class="toggle-slider"></span></label>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>Runtime <span style="font-size:9px;opacity:0.5;text-transform:none;letter-spacing:0">(global only)</span></span>
      </div>
      <div class="settings-row">
        <span class="label">Verbose output</span>
        <label class="toggle"><input type="checkbox" id="cs_verbose"><span class="toggle-slider"></span></label>
      </div>
      <div class="settings-row">
        <span class="label">Notification sounds</span>
        <div class="select-wrap">
          <select id="cs_notifications">
            <option value="iterm2">iterm2</option>
            <option value="terminal_bell">terminal_bell</option>
            <option value="notifications_disabled">disabled</option>
          </select>
        </div>
      </div>
      <div class="settings-row">
        <span class="label">Auto-update</span>
        <label class="toggle"><input type="checkbox" id="cs_autoUpdates"><span class="toggle-slider"></span></label>
      </div>
      <div class="settings-row">
        <span class="label">Show PR status footer</span>
        <label class="toggle"><input type="checkbox" id="cs_showPRStatusFooter"><span class="toggle-slider"></span></label>
      </div>
      <div class="settings-row">
        <span class="label">Prompt suggestions</span>
        <label class="toggle"><input type="checkbox" id="cs_promptSuggestions"><span class="toggle-slider"></span></label>
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

<!-- ONBOARDING OVERLAY -->
<div class="onboarding-overlay" id="onboardingOverlay" style="display:none">
  <div class="onboarding-dialog">
    <div class="onboarding-path" id="onboardingPath"></div>
    <p class="onboarding-desc">Do you trust this folder? Claude will be able to read, edit, and run files here.</p>
    <div class="onboarding-section" id="onboardingHooksRow">
      <div class="onboarding-row">
        <span class="label">Install review hooks</span>
        <label class="toggle"><input type="checkbox" id="onboardingInstallHooks" checked><span class="toggle-slider"></span></label>
      </div>
    </div>
    <div class="onboarding-actions">
      <button class="btn" id="onboardingCancel">Cancel</button>
      <button class="btn primary" id="onboardingStart">Trust this folder</button>
    </div>
  </div>
</div>

<script src="${xtermJs}"></script>
<script src="${fitJs}"></script>
<script src="${webLinksJs}"></script>
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
