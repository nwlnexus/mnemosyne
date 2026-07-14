/**
 * Signals a drain failure that will never succeed on retry (e.g. the session
 * transcript no longer exists or cannot be parsed). Entries that fail this way
 * are moved to `dead/` instead of being requeued, so they stop re-failing on
 * every SessionStart drain. Transient failures (LLM / network / moneta) are left
 * to propagate as ordinary errors and remain in the queue for retry.
 */
export class PermanentDrainError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PermanentDrainError";
	}
}
