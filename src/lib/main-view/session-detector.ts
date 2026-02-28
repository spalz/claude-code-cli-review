// Session ID detector — polls and watches for new Claude session .jsonl files
import * as fs from "fs";
import * as log from "../log";
import { getSessionsDir } from "../sessions";

export interface DetectSessionCallbacks {
	onDetected(ptyId: number, sessionId: string): void;
	isAlreadyBound(ptyId: number): boolean;
}

/**
 * Detect a newly created Claude session ID by watching the sessions directory.
 * Combines fs.watch (fast) with polling (reliable) for robustness.
 *
 * @returns Disposable to cancel detection early
 */
export function detectNewSessionId(
	wp: string,
	ptyId: number,
	callbacks: DetectSessionCallbacks,
): { dispose(): void } {
	const sessionsDir = getSessionsDir(wp);

	let existingFiles: Set<string>;
	try {
		existingFiles = new Set(
			fs.readdirSync(sessionsDir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => f.replace(".jsonl", "")),
		);
	} catch {
		existingFiles = new Set();
	}

	const createdAt = Date.now();
	let disposed = false;
	let interval: ReturnType<typeof setInterval> | null = null;
	let watcher: fs.FSWatcher | null = null;

	const cleanup = (): void => {
		if (disposed) return;
		disposed = true;
		if (interval) clearInterval(interval);
		try { watcher?.close(); } catch {}
	};

	const tryDetect = (): boolean => {
		if (disposed || callbacks.isAlreadyBound(ptyId)) return true;
		try {
			const files = fs
				.readdirSync(sessionsDir)
				.filter((f) => f.endsWith(".jsonl"));

			for (const file of files) {
				const sessionId = file.replace(".jsonl", "");
				if (existingFiles.has(sessionId)) continue;

				const stat = fs.statSync(`${sessionsDir}/${file}`);
				if (stat.mtimeMs < createdAt - 2000) continue;

				log.log(`detected new claude session: ${sessionId.slice(0, 8)} for pty #${ptyId}`);
				callbacks.onDetected(ptyId, sessionId);
				cleanup();
				return true;
			}
		} catch {}
		return false;
	};

	// Poll every 2s for up to 60 seconds
	let attempts = 0;
	interval = setInterval(() => {
		attempts++;
		if (attempts > 30 || tryDetect()) {
			cleanup();
			if (attempts > 30) {
				log.log(`detectNewSessionId: timed out for pty #${ptyId} after 60s`);
			}
		}
	}, 2000);

	// Also use fs.watch for faster detection
	try {
		if (fs.existsSync(sessionsDir)) {
			watcher = fs.watch(sessionsDir, (_, filename) => {
				if (filename?.endsWith(".jsonl")) tryDetect();
			});
			setTimeout(() => { try { watcher?.close(); } catch {} }, 62000);
		}
	} catch {}

	return { dispose: cleanup };
}
