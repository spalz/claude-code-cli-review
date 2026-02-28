// Image tracker — manages CLI image index bindings and per-PTY queues

const MAX_BOUND = 200;

export class ImageTracker {
	/** Images keyed by CLI's [Image #N] number */
	private _bound: Map<number, string> = new Map(); // cliIndex → filePath
	/** Per-PTY-session FIFO queues of pending images */
	private _queues: Map<number, { filePath: string; base64: string; mimeType: string }[]> = new Map();

	/** Queue an image for a specific PTY session */
	enqueue(ptyId: number, filePath: string, base64: string, mimeType: string): void {
		let q = this._queues.get(ptyId);
		if (!q) { q = []; this._queues.set(ptyId, q); }
		q.push({ filePath, base64, mimeType });
	}

	/** Shift oldest pending for a PTY session */
	shiftPending(ptyId: number): { filePath: string; base64: string; mimeType: string } | undefined {
		const q = this._queues.get(ptyId);
		return q?.shift();
	}

	/** Bind CLI's [Image #N] to a file path (called after shiftPending) */
	bind(cliIndex: number, filePath: string): void {
		if (this._bound.size >= MAX_BOUND) {
			// Evict oldest entry
			const firstKey = this._bound.keys().next().value;
			if (firstKey !== undefined) this._bound.delete(firstKey);
		}
		this._bound.set(cliIndex, filePath);
	}

	getImagePath(index: number): string | undefined {
		return this._bound.get(index);
	}

	/** Clear pending queue for a specific PTY session (e.g., on terminal close) */
	clearSession(ptyId: number): void {
		this._queues.delete(ptyId);
	}

	clear(): void {
		this._bound.clear();
		this._queues.clear();
	}
}
