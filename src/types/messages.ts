import type { HookStatus } from "./hook";
import type { KeybindingInfo, ReviewStateUpdate } from "./ui";
import type { SessionInfo } from "./session";
import type { PtySessionInfo } from "./pty";

export type ExtensionToWebviewMessage =
	| { type: "sessions-list"; sessions: SessionInfo[]; archivedCount: number }
	| { type: "archived-sessions-list"; sessions: SessionInfo[] }
	| { type: "open-sessions-update"; openClaudeIds: string[] }
	| { type: "activate-terminal"; sessionId: number }
	| {
			type: "terminal-session-created";
			sessionId: number;
			name: string;
			claudeId: string | null;
	  }
	| { type: "update-terminal-claude-id"; sessionId: number; claudeId: string }
	| { type: "rename-terminal-tab"; claudeId: string; newName: string }
	| { type: "rename-result"; claudeId: string; newName: string; success: boolean }
	| { type: "terminal-session-closed"; sessionId: number }
	| { type: "terminal-output"; sessionId: number; data: string }
	| { type: "terminal-exit"; sessionId: number; exitCode: number }
	| { type: "terminal-error"; sessionId: number; error: string }
	| { type: "insert-text"; text: string }
	| { type: "hook-status"; status: HookStatus }
	| { type: "settings-init"; cliCommand: string; keybindings: KeybindingInfo[] }
	| {
			type: "state-update";
			review: ReviewStateUpdate;
			activeSessions: PtySessionInfo[];
	  }
;

export type WebviewToExtensionMessage =
	| { type: "webview-ready" }
	| { type: "new-claude-session" }
	| { type: "resume-claude-session"; claudeSessionId: string }
	| { type: "refresh-sessions" }
	| { type: "rename-session"; sessionId: string; newName: string }
	| { type: "delete-session"; sessionId: string }
	| { type: "archive-session"; sessionId: string }
	| { type: "unarchive-session"; sessionId: string }
	| { type: "load-archived-sessions" }
	| { type: "terminal-input"; sessionId: number; data: string }
	| { type: "terminal-resize"; sessionId: number; cols: number; rows: number }
	| { type: "close-terminal"; sessionId: number }
	| { type: "close-session-by-claude-id"; claudeSessionId: string }
	| { type: "file-dropped"; sessionId: number; uri: string }
	| { type: "start-review" }
	| { type: "accept-file"; filePath: string }
	| { type: "reject-file"; filePath: string }
	| { type: "go-to-file"; filePath: string }
	| { type: "prev-file" }
	| { type: "next-file" }
	| { type: "accept-all" }
	| { type: "reject-all" }
	| { type: "open-terminal" }
	| { type: "git-status" }
	| { type: "paste-image"; sessionId: number; data: string; mimeType: string }
	| { type: "install-hook" }
	| { type: "open-keybindings" }
	| { type: "set-active-session"; claudeId: string | null }
	| { type: "set-cli-command"; value: string }
	| { type: "undo-review" }
	| { type: "redo-review" }
	| { type: "navigate-hunk"; direction: -1 | 1 }
	| { type: "review-next-file" }
	| { type: "accept-all-confirm" }
	| { type: "reject-all-confirm" }
	| { type: "keep-current-file" }
	| { type: "undo-current-file" }
	| { type: "check-hook-status" }
	| { type: "diag-log"; category: string; message: string; data: Record<string, unknown> | null; timestamp: number };
