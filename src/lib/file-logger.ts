import * as fs from "fs";
import * as path from "path";

const MAX_LOG_SIZE = 1 * 1024 * 1024; // 1MB

class FileLogger {
	private streams: Map<string, fs.WriteStream> = new Map();
	private logDir: string | null = null;

	init(workspacePath: string): void {
		this.logDir = path.join(workspacePath, ".claude", "logs");
		fs.mkdirSync(this.logDir, { recursive: true });
	}

	log(category: string, message: string, data?: Record<string, unknown>): void {
		if (!this.logDir) return;
		const logPath = path.join(this.logDir, `${category}.log`);
		let stream = this.streams.get(category);
		if (!stream) {
			this.rotateIfNeeded(logPath);
			stream = fs.createWriteStream(logPath, { flags: "a" });
			this.streams.set(category, stream);
		}
		const ts = new Date().toISOString();
		const line = data ? `[${ts}] ${message} ${JSON.stringify(data)}\n` : `[${ts}] ${message}\n`;
		stream.write(line);
	}

	private rotateIfNeeded(logPath: string): void {
		try {
			const stat = fs.statSync(logPath);
			if (stat.size > MAX_LOG_SIZE) {
				const bakPath = logPath.replace(/\.log$/, ".bak");
				fs.renameSync(logPath, bakPath);
			}
		} catch {
			// File doesn't exist yet — nothing to rotate
		}
	}

	dispose(): void {
		for (const stream of this.streams.values()) {
			stream.end();
		}
		this.streams.clear();
	}
}

export const fileLog = new FileLogger();
