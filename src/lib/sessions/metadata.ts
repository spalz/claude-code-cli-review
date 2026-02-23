// Session metadata parsing — extracts title, message count, branch from JSONL
import * as fs from "fs";
import type { SessionMeta } from "../../types";

export function parseSessionMeta(filePath: string): SessionMeta {
	const result: SessionMeta = { title: null, customTitle: null, messageCount: 0, branch: null };

	try {
		const content = fs.readFileSync(filePath, "utf8");
		const lines = content.split("\n").filter(Boolean);

		for (const line of lines) {
			try {
				const data = JSON.parse(line) as {
					type?: string;
					gitBranch?: string;
					summary?: unknown;
					customTitle?: string;
					message?: { content?: unknown };
				};
				const type = data.type;

				if (!result.branch && data.gitBranch) {
					result.branch = data.gitBranch;
				}

				if (type === "user") {
					result.messageCount++;
					if (!result.title) {
						const msg = data.message ?? {};
						const contentArr = msg.content;
						if (Array.isArray(contentArr)) {
							for (const item of contentArr as Array<{
								type?: string;
								text?: string;
							}>) {
								if (item.type !== "text" || !item.text) continue;
								const raw = item.text.trim();
								// Skip IDE/system context tags
								if (
									/^<(ide|system|context|auto|vscode|git|local|environment|command|user-prompt)/.test(
										raw,
									)
								)
									continue;
								// Strip any remaining XML-like tags
								const clean = raw
									.replace(/<[^>]+>/g, "")
									.trim()
									.slice(0, 80);
								if (clean) {
									result.title = clean;
									break;
								}
							}
						} else if (typeof contentArr === "string") {
							const clean = contentArr
								.replace(/<[^>]+>/g, "")
								.trim()
								.slice(0, 80);
							if (clean) result.title = clean;
						}
					}
				} else if (type === "assistant") {
					result.messageCount++;
				}

				// summary field overrides title
				if (type === "summary" && data.summary) {
					result.title = String(data.summary).slice(0, 80);
				}

				// custom-title has highest priority (CLI /rename)
				if (type === "custom-title" && data.customTitle) {
					const ct = String(data.customTitle).slice(0, 80);
					result.title = ct;
					result.customTitle = ct;
				}
			} catch {}
		}
	} catch {}

	return result;
}
