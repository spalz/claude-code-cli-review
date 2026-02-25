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
	const veJs = mediaUri("vscode-elements.js");
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
  img-src ${webview.cspSource} data:;">
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
  <vscode-context-menu id="ctxMenu"></vscode-context-menu>
</div>

<!-- SETTINGS OVERLAY -->
<div class="settings-overlay" id="settingsOverlay" style="display:none">
  <div class="settings-header">
    <span class="header-title">SETTINGS</span>
    <span class="settings-close-btn" id="btnCloseSettings" title="Close">Close <span class="codicon codicon-close"></span></span>
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
        <vscode-button id="hookActionBtn" style="display:none">Install</vscode-button>
      </div>
      <div class="settings-row">
        <span class="label">Notifications</span>
        <vscode-single-select id="ts_notificationMode">
          <vscode-option value="notifications_sound">Notifications + Sound</vscode-option>
          <vscode-option value="sound_only">Sound only</vscode-option>
          <vscode-option value="notifications_only">Notifications only</vscode-option>
          <vscode-option value="disabled">Disabled</vscode-option>
        </vscode-single-select>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-title">CLI Command</div>
      <div class="settings-row">
        <span class="label">Command for sessions</span>
        <vscode-single-select id="cliSelect">
          <vscode-option value="claude">claude</vscode-option>
          <vscode-option value="happy">happy</vscode-option>
        </vscode-single-select>
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
        <vscode-single-select id="cs_theme">
          <vscode-option value="dark">dark</vscode-option>
          <vscode-option value="light">light</vscode-option>
          <vscode-option value="light-daltonized">light-daltonized</vscode-option>
          <vscode-option value="dark-daltonized">dark-daltonized</vscode-option>
          <vscode-option value="auto">auto</vscode-option>
        </vscode-single-select>
      </div>

      <div class="settings-row">
        <span class="label">Output style</span>
        <vscode-single-select id="cs_outputStyle">
          <vscode-option value="default">default</vscode-option>
          <vscode-option value="concise">concise</vscode-option>
          <vscode-option value="verbose">verbose</vscode-option>
          <vscode-option value="markdown">markdown</vscode-option>
          <vscode-option value="explanatory">explanatory</vscode-option>
        </vscode-single-select>
      </div>

      <div class="settings-row">
        <span class="label">Editor mode</span>
        <vscode-single-select id="cs_editorMode">
          <vscode-option value="normal">normal</vscode-option>
          <vscode-option value="vim">vim</vscode-option>
          <vscode-option value="emacs">emacs</vscode-option>
        </vscode-single-select>
      </div>

      <div class="settings-row">
        <span class="label">Permission mode</span>
        <vscode-single-select id="cs_permissionMode">
          <vscode-option value="default">default</vscode-option>
          <vscode-option value="plan">plan</vscode-option>
          <vscode-option value="acceptEdits">acceptEdits</vscode-option>
          <vscode-option value="fullAuto">fullAuto</vscode-option>
          <vscode-option value="bypassPermissions">bypassPermissions</vscode-option>
        </vscode-single-select>
      </div>

      <div class="settings-row">
        <span class="label">Default model</span>
        <vscode-textfield id="cs_model" placeholder="e.g. claude-sonnet-4-6"></vscode-textfield>
      </div>

      <div class="settings-row">
        <span class="label">Language</span>
        <vscode-textfield id="cs_language" placeholder="e.g. ru, en"></vscode-textfield>
      </div>

      <div class="settings-subtitle">Behavior</div>

      <div class="settings-row">
        <span class="label">Thinking mode</span>
        <vscode-checkbox id="cs_thinkingMode"></vscode-checkbox>
      </div>
      <div class="settings-row">
        <span class="label">Respect .gitignore</span>
        <vscode-checkbox id="cs_respectGitignore"></vscode-checkbox>
      </div>

      <div class="settings-subtitle">UI</div>

      <div class="settings-row">
        <span class="label">Terminal progress bar</span>
        <vscode-checkbox id="cs_terminalProgressBar"></vscode-checkbox>
      </div>
      <div class="settings-row">
        <span class="label">Reduce motion</span>
        <vscode-checkbox id="cs_reduceMotion"></vscode-checkbox>
      </div>
      <div class="settings-row">
        <span class="label">Show spinner tips</span>
        <vscode-checkbox id="cs_showTips"></vscode-checkbox>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>Runtime <span style="font-size:9px;opacity:0.5;text-transform:none;letter-spacing:0">(global only)</span></span>
      </div>
      <div class="settings-row">
        <span class="label">Verbose output</span>
        <vscode-checkbox id="cs_verbose"></vscode-checkbox>
      </div>
      <div class="settings-row">
        <span class="label">Notification sounds</span>
        <vscode-single-select id="cs_notifications">
          <vscode-option value="iterm2">iterm2</vscode-option>
          <vscode-option value="terminal_bell">terminal_bell</vscode-option>
          <vscode-option value="notifications_disabled">disabled</vscode-option>
        </vscode-single-select>
      </div>
      <div class="settings-subtitle">Updates &amp; UI</div>

      <div class="settings-row">
        <span class="label">Auto-update</span>
        <vscode-checkbox id="cs_autoUpdates"></vscode-checkbox>
      </div>
      <div class="settings-row">
        <span class="label">Show PR status footer</span>
        <vscode-checkbox id="cs_showPRStatusFooter"></vscode-checkbox>
      </div>
      <div class="settings-row">
        <span class="label">Prompt suggestions</span>
        <vscode-checkbox id="cs_promptSuggestions"></vscode-checkbox>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>Keyboard Shortcuts</span>
        <vscode-button secondary id="btnCustomizeKeys" style="font-size:10px">Customize</vscode-button>
      </div>
      <div id="shortcutsContainer"><div style="font-size:12px;opacity:.4">Loading...</div></div>
    </div>
    <div class="settings-section">
      <div class="settings-title">Tips</div>
      <div class="settings-tips">
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
      <vscode-button secondary id="confirmCancel">Cancel</vscode-button>
      <vscode-button id="confirmOk">Confirm</vscode-button>
    </div>
  </div>
</div>

<!-- ONBOARDING OVERLAY -->
<div class="onboarding-overlay" id="onboardingOverlay" style="display:none">
  <div class="onboarding-dialog">
    <div class="onboarding-path" id="onboardingPath"></div>
    <p class="onboarding-desc">Do you trust this folder? Claude will be able to read, edit, and run files here.</p>
    <div class="onboarding-permissions">
      <div class="onboarding-perm"><span class="codicon codicon-file-code"></span> Read, edit, and create files</div>
      <div class="onboarding-perm"><span class="codicon codicon-terminal"></span> Execute shell commands</div>
      <div class="onboarding-perm" id="onboardingMcpRow" style="display:none"><span class="codicon codicon-extensions"></span> <span id="onboardingMcpText">Use MCP servers</span></div>
    </div>
    <div class="onboarding-section" id="onboardingHooksRow">
      <div class="onboarding-row">
        <span class="label">Install review hooks</span>
        <vscode-checkbox id="onboardingInstallHooks" checked></vscode-checkbox>
      </div>
    </div>
    <div class="onboarding-actions">
      <vscode-button secondary id="onboardingCancel">Cancel</vscode-button>
      <vscode-button id="onboardingStart">Trust this folder</vscode-button>
    </div>
  </div>
</div>

<script src="${veJs}" type="module"></script>
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
