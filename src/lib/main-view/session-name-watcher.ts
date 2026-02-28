// Session name watcher — watches session-names.json and .jsonl files for tab name updates
import * as fs from "fs";
import * as log from "../log";
import { getSessionsDir, loadSessionNames } from "../sessions";

export interface NameWatcherCallbacks {
    postRename(claudeId: string, newName: string): void;
    refreshSessions(): void;
    getOpenIds(): ReadonlySet<string>;
}

export class SessionNameWatcher {
    private _watcher: fs.FSWatcher | null = null;
    private _namesDebounce: ReturnType<typeof setTimeout> | null = null;
    private _jsonlDebounce: ReturnType<typeof setTimeout> | null = null;
    private _cachedNames: Record<string, string> = {};

    constructor(
        private readonly _wp: string,
        private readonly _callbacks: NameWatcherCallbacks,
    ) {}

    start(): void {
        const dir = getSessionsDir(this._wp);
        try {
            this._watcher = fs.watch(dir, (_, filename) => {
                if (filename === "session-names.json") {
                    if (this._namesDebounce) clearTimeout(this._namesDebounce);
                    this._namesDebounce = setTimeout(() => this._syncTabNames(), 300);
                }
                if (filename?.endsWith(".jsonl")) {
                    const sessionId = filename.replace(".jsonl", "");
                    if (this._callbacks.getOpenIds().has(sessionId)) {
                        if (this._jsonlDebounce) clearTimeout(this._jsonlDebounce);
                        this._jsonlDebounce = setTimeout(
                            () => this._callbacks.refreshSessions(),
                            2000,
                        );
                    }
                }
            });
        } catch {
            // Directory might not exist yet
        }
    }

    dispose(): void {
        this._watcher?.close();
        this._watcher = null;
        if (this._namesDebounce) clearTimeout(this._namesDebounce);
        if (this._jsonlDebounce) clearTimeout(this._jsonlDebounce);
    }

    private _syncTabNames(): void {
        const names = loadSessionNames(this._wp);
        const openIds = this._callbacks.getOpenIds();
        for (const claudeId of openIds) {
            const newName = names[claudeId];
            if (newName && newName !== this._cachedNames[claudeId]) {
                log.log(`names-sync: ${claudeId.slice(0, 8)} -> "${newName}"`);
                this._callbacks.postRename(claudeId, newName);
            }
        }
        this._cachedNames = names;
    }
}
