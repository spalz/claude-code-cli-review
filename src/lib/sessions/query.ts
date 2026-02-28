// Session queries — list, filter, and enumerate Claude CLI sessions
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as vscode from "vscode";
import { getSessionsDir } from "./paths";
import { loadSessionNames } from "./names";
import { parseSessionMeta } from "./metadata";
import { loadArchivedSessionIds, loadInvalidSessions } from "./lifecycle";
import type { SessionInfo } from "../../types";

export function listSessions(
    workspacePath: string,
    limit = 20,
    offset = 0,
    forceIncludeIds?: Set<string>,
): { sessions: SessionInfo[]; hasMore: boolean; archivedCount: number } {
    const dir = getSessionsDir(workspacePath);
    if (!fs.existsSync(dir)) return { sessions: [], hasMore: false, archivedCount: 0 };

    const customNames = loadSessionNames(workspacePath);
    const invalidSessions = loadInvalidSessions(workspacePath);
    const archivedSessions = loadArchivedSessionIds(workspacePath);

    const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
            const fp = path.join(dir, f);
            const stat = fs.statSync(fp);
            return { file: f, path: fp, mtime: stat.mtimeMs, size: stat.size };
        })
        .sort((a, b) => b.mtime - a.mtime);

    const allValid: SessionInfo[] = [];
    let archivedCount = 0;
    for (const f of files) {
        const sessionId = f.file.replace(".jsonl", "");

        // Skip sessions marked as invalid (legacy hidden)
        if (invalidSessions.has(sessionId)) continue;

        // Bypass size/message filters for currently open sessions
        const isOpen = forceIncludeIds?.has(sessionId) ?? false;

        // Quick skip: tiny files (< 3KB) are empty session stubs
        if (!isOpen && f.size < 3000 && !customNames[sessionId]) continue;

        const meta = parseSessionMeta(f.path);
        // Filter out sessions with no actual messages (abandoned starts)
        if (!isOpen && meta.messageCount === 0 && !customNames[sessionId]) continue;

        // Skip archived sessions from main list but count them
        if (archivedSessions.has(sessionId)) {
            archivedCount++;
            continue;
        }

        allValid.push({
            id: sessionId,
            title:
                meta.customTitle ||
                customNames[sessionId] ||
                meta.title ||
                sessionId.slice(0, 8) + "...",
            timestamp: new Date(f.mtime).toISOString(),
            size: f.size,
            messageCount: meta.messageCount,
            branch: meta.branch,
        });
    }

    const sessions = allValid.slice(offset, offset + limit);
    const hasMore = offset + limit < allValid.length;
    return { sessions, hasMore, archivedCount };
}

export function listArchivedSessions(workspacePath: string): SessionInfo[] {
    const dir = getSessionsDir(workspacePath);
    if (!fs.existsSync(dir)) return [];

    const customNames = loadSessionNames(workspacePath);
    const archivedSessions = loadArchivedSessionIds(workspacePath);
    if (archivedSessions.size === 0) return [];

    const result: SessionInfo[] = [];
    for (const sessionId of archivedSessions) {
        const fp = path.join(dir, sessionId + ".jsonl");
        if (!fs.existsSync(fp)) continue;
        const stat = fs.statSync(fp);
        const meta = parseSessionMeta(fp);
        result.push({
            id: sessionId,
            title:
                meta.customTitle ||
                customNames[sessionId] ||
                meta.title ||
                sessionId.slice(0, 8) + "...",
            timestamp: new Date(stat.mtimeMs).toISOString(),
            size: stat.size,
            messageCount: meta.messageCount,
            branch: meta.branch,
        });
    }

    return result.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export function getActiveDaemonSessions(): unknown[] {
    try {
        const cli = vscode.workspace
            .getConfiguration("claudeCodeReview")
            .get("cliCommand", "claude");
        const output = execSync(`${cli} daemon list`, {
            encoding: "utf8",
            timeout: 5000,
            stdio: "pipe",
        });
        return JSON.parse(output) as unknown[];
    } catch {
        return [];
    }
}
