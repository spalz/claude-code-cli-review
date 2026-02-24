import * as fs from "fs";
import * as path from "path";

class FileLogger {
	private streams: Map<string, fs.WriteStream> = new Map();
	private logDir: string | null = null;

	init(workspacePath: string): void {
		this.logDir = path.join(workspacePath, ".claude", "logs");
		fs.mkdirSync(this.logDir, { recursive: true });
	}

	log(category: string, message: string, data?: Record<string, unknown>): void {
		if (!this.logDir) return;
		let stream = this.streams.get(category);
		if (!stream) {
			stream = fs.createWriteStream(path.join(this.logDir, `${category}.log`), { flags: "a" });
			this.streams.set(category, stream);
		}
		const ts = new Date().toISOString();
		const line = data ? `[${ts}] ${message} ${JSON.stringify(data)}\n` : `[${ts}] ${message}\n`;
		stream.write(line);
	}

	dispose(): void {
		for (const stream of this.streams.values()) {
			stream.end();
		}
		this.streams.clear();
	}
}

export const fileLog = new FileLogger();
