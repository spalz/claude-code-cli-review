// Session lifecycle — archive, unarchive, delete operations
import * as fs from "fs";
import * as path from "path";
import { getSessionsDir, getArchivedSessionsFile, getInvalidSessionsFile } from "./paths";

function loadInvalidSessions(workspacePath: string): Set<string> {
    try {
        return new Set(
            JSON.parse(fs.readFileSync(getInvalidSessionsFile(workspacePath), "utf8")) as string[],
        );
    } catch {
        return new Set();
    }
}

export function loadArchivedSessionIds(workspacePath: string): Set<string> {
    try {
        return new Set(
            JSON.parse(fs.readFileSync(getArchivedSessionsFile(workspacePath), "utf8")) as string[],
        );
    } catch {
        return new Set();
    }
}

export { loadInvalidSessions };

export function archiveSession(workspacePath: string, sessionId: string): void {
    const archived = loadArchivedSessionIds(workspacePath);
    archived.add(sessionId);
    fs.writeFileSync(
        getArchivedSessionsFile(workspacePath),
        JSON.stringify([...archived], null, 2),
        "utf8",
    );
}

export function unarchiveSession(workspacePath: string, sessionId: string): void {
    const archived = loadArchivedSessionIds(workspacePath);
    archived.delete(sessionId);
    fs.writeFileSync(
        getArchivedSessionsFile(workspacePath),
        JSON.stringify([...archived], null, 2),
        "utf8",
    );
}

export function deleteSession(workspacePath: string, sessionId: string): void {
    const dir = getSessionsDir(workspacePath);
    const filePath = path.join(dir, sessionId + ".jsonl");
    try {
        fs.unlinkSync(filePath);
    } catch {}
    // Cleanup from archived-sessions.json
    const archived = loadArchivedSessionIds(workspacePath);
    if (archived.has(sessionId)) {
        archived.delete(sessionId);
        fs.writeFileSync(
            getArchivedSessionsFile(workspacePath),
            JSON.stringify([...archived], null, 2),
            "utf8",
        );
    }
    // Cleanup from invalid-sessions.json
    const invalid = loadInvalidSessions(workspacePath);
    if (invalid.has(sessionId)) {
        invalid.delete(sessionId);
        fs.writeFileSync(
            getInvalidSessionsFile(workspacePath),
            JSON.stringify([...invalid], null, 2),
            "utf8",
        );
    }
}
