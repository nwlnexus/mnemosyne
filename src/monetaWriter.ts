import { createHash } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PermanentDrainError } from "./errors.js";
import type { Turn } from "./types.js";

// moneta is olympus's memory Worker. This writer POSTs learnings to its
// /capture endpoint and is FAIL-OPEN: any failure spools
// the payload to an outbox and returns so a capture can never break the hook
// pipeline. The CLI `drain` path replays the outbox on its next run.

const DEFAULT_URL = "https://mem.nwlnexus.io";

function monetaUrl(): string {
	return process.env.MONETA_URL ?? DEFAULT_URL;
}

// Shared credential resolution, in priority order:
//   1. `envVar` env var
//   2. file at `fileEnvVar` (falling back to `defaultFile`), trimmed
//   3. null (caller decides how to treat an unresolved credential)
function resolveFileBackedCredential(
	envVar: string,
	fileEnvVar: string,
	defaultFile: string,
): string | null {
	const fromEnv = process.env[envVar]?.trim();
	if (fromEnv) return fromEnv;
	const file = process.env[fileEnvVar] ?? defaultFile;
	try {
		return readFileSync(file, "utf8").trim() || null;
	} catch {
		return null;
	}
}

// Bearer token resolution (token itself is provisioned out-of-band by
// nix-darwin-hm — see README), in priority order:
//   1. MONETA_AUTH_TOKEN env var
//   2. file at MONETA_TOKEN_FILE (default ~/.config/moneta/token), trimmed
function resolveToken(): string | null {
	return resolveFileBackedCredential(
		"MONETA_AUTH_TOKEN",
		"MONETA_TOKEN_FILE",
		join(homedir(), ".config", "moneta", "token"),
	);
}

// Cloudflare Access Service Auth (required at the edge once moneta-access is
// live). nix-darwin-hm provisions CF_ACCESS_CLIENT_ID/SECRET from 1Password.
// Each credential mirrors MONETA_AUTH_TOKEN's own resolution: env var first,
// else a trimmed file read (CF_ACCESS_CLIENT_ID_FILE /
// CF_ACCESS_CLIENT_SECRET_FILE, defaulting to
// ~/.config/moneta/cf-access-client-id and
// ~/.config/moneta/cf-access-client-secret) — headers are simply omitted
// when a credential can't be resolved either way (fail-open, unchanged).
function resolveAccessHeaders(): Record<string, string> {
	const id = resolveFileBackedCredential(
		"CF_ACCESS_CLIENT_ID",
		"CF_ACCESS_CLIENT_ID_FILE",
		join(homedir(), ".config", "moneta", "cf-access-client-id"),
	);
	const secret = resolveFileBackedCredential(
		"CF_ACCESS_CLIENT_SECRET",
		"CF_ACCESS_CLIENT_SECRET_FILE",
		join(homedir(), ".config", "moneta", "cf-access-client-secret"),
	);
	if (!id || !secret) return {};
	return {
		"CF-Access-Client-Id": id,
		"CF-Access-Client-Secret": secret,
	};
}

export function monetaOutboxDir(): string {
	const home =
		process.env.MNEMOSYNE_HOME ?? join(homedir(), ".claude", "mnemosyne");
	return join(home, "moneta-outbox");
}

// Single POST used by BOTH writeMoneta and replayOutbox so a replay failure
// never re-spools content that is already on disk. Returns true only on 2xx;
// swallows every error (missing token, network, non-2xx) into `false`.
export async function postCapture(json: string): Promise<boolean> {
	const token = resolveToken();
	if (!token) return false;
	try {
		const res = await fetch(`${monetaUrl()}/capture`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
				...resolveAccessHeaders(),
			},
			body: json,
			// NEVER follow redirects: when the CF Access service token is
			// invalid/expired, the edge 302s to the Access login page, and a
			// followed redirect lands on that page's 200 — which read as success
			// and silently deleted outbox files. Manual mode surfaces the 302
			// itself, so res.ok is false and the capture stays spooled.
			redirect: "manual",
		});
		return res.ok;
	} catch {
		return false;
	}
}

// ─── capture-session (server-side extraction) ───────────────────────────────
// moneta's /capture-session endpoint does ALL extraction/embedding: mnemosyne
// just POSTs the raw transcript turns and moneta returns the learnings it
// derived (and, for each, whether/why it stored to moneta). Unlike
// writeMoneta/postCapture this is NOT fail-open — the queue entry on disk is
// the durable store, so a failure here must throw and let drainQueue decide
// whether to dead-letter (permanent) or leave the entry queued (transient).

export type SessionLearningKind = "fact" | "decision" | "lesson" | "noise";

export type SessionLearningReason =
	| "kind_not_routed_to_moneta"
	| "below_min_confidence"
	| "secret_detected"
	| "duplicate_blocked"
	| "capture_failed";

export type SessionLearning = {
	text: string;
	kind: SessionLearningKind;
	confidence: number;
	title?: string;
	stored: boolean;
	id?: string;
	captureStatus?: string;
	reason?: SessionLearningReason;
};

export type CaptureSessionPayload = {
	turns: Turn[];
	session: string;
	cwd: string;
	ts: string;
	source?: string;
	tags?: string[];
	force?: boolean;
};

export type SessionCaptureResult = {
	status: "captured" | "already_captured";
	learnings: SessionLearning[];
};

export async function captureSession(
	payload: CaptureSessionPayload,
): Promise<SessionCaptureResult> {
	const token = resolveToken();
	if (!token) {
		// Transient: no token resolvable yet (e.g. not provisioned). Leave the
		// entry queued rather than dead-lettering — it may resolve later.
		throw new Error("moneta capture-session: no auth token resolved");
	}
	let res: Response;
	try {
		res = await fetch(`${monetaUrl()}/capture-session`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
				...resolveAccessHeaders(),
			},
			body: JSON.stringify(payload),
			// See postCapture: never follow redirects (CF Access login trap).
			redirect: "manual",
		});
	} catch (err) {
		throw new Error(
			`moneta capture-session: network error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	// Malformed/oversized request bodies can never succeed on retry.
	if (res.status === 400 || res.status === 413) {
		throw new PermanentDrainError(
			`moneta capture-session rejected the request (${res.status})`,
		);
	}
	// Auth failures, extraction failures (502), and anything else unexpected
	// are transient — leave the entry queued for the next drain.
	if (!res.ok) {
		throw new Error(`moneta capture-session failed: ${res.status}`);
	}
	let data: { ok?: boolean; status?: unknown; learnings?: unknown };
	try {
		data = (await res.json()) as typeof data;
	} catch (err) {
		throw new Error(
			`moneta capture-session: failed to parse response: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!data.ok || !Array.isArray(data.learnings)) {
		throw new Error("moneta capture-session: unexpected response shape");
	}
	return {
		status:
			data.status === "already_captured" ? "already_captured" : "captured",
		learnings: data.learnings as SessionLearning[],
	};
}

function spool(json: string): void {
	const dir = monetaOutboxDir();
	mkdirSync(dir, { recursive: true });
	// Content hash → filename: unique per distinct payload (mirrors the brain
	// inbox's slug-hash scheme) and idempotent — re-spooling identical content
	// overwrites rather than duplicating.
	const name = createHash("sha256").update(json).digest("hex").slice(0, 32);
	writeFileSync(join(dir, `${name}.json`), json);
}

// FAIL-OPEN writer: post the capture, spooling to the outbox on any failure.
export async function writeMoneta(json: string): Promise<void> {
	if (await postCapture(json)) return;
	spool(json);
}

export type ReplaySummary = { replayed: number; kept: number };

// Replay spooled captures. Delete a file ONLY on a confirmed 2xx; leave it
// otherwise (idempotent + fail-safe — moneta dedupes server-side, so a
// re-post of an already-stored capture is harmless). Returns how many files
// were delivered-and-removed vs kept for the next drain.
export async function replayOutbox(): Promise<ReplaySummary> {
	const summary: ReplaySummary = { replayed: 0, kept: 0 };
	let files: string[];
	try {
		files = readdirSync(monetaOutboxDir()).filter((n) => n.endsWith(".json"));
	} catch {
		return summary; // no outbox yet → nothing to replay
	}
	for (const f of files) {
		const p = join(monetaOutboxDir(), f);
		let json: string;
		try {
			json = readFileSync(p, "utf8");
		} catch {
			continue;
		}
		if (await postCapture(json)) {
			rmSync(p);
			summary.replayed++;
		} else {
			summary.kept++;
		}
	}
	return summary;
}

// --- legacy mem0 outbox migration -----------------------------------------

function legacyOutboxDir(): string {
	const home =
		process.env.MNEMOSYNE_HOME ?? join(homedir(), ".claude", "mnemosyne");
	return join(home, "outbox");
}

// Entries spooled before the mem0 retirement are mem0-API-shaped
// ({ user_id, text, infer, app, metadata }). Convert to a moneta capture, or
// null when the entry has no usable text (malformed JSON, empty text) — those
// can never succeed and are counted as skipped rather than retried forever.
function convertLegacyPayload(raw: string): string | null {
	try {
		const o = JSON.parse(raw) as {
			text?: unknown;
			metadata?: Record<string, unknown>;
		};
		const text = typeof o.text === "string" && o.text.trim() ? o.text : null;
		if (!text) return null;
		const metadata =
			o.metadata && typeof o.metadata === "object" ? o.metadata : {};
		const kind = metadata.kind;
		const tags = ["mnemosyne", ...(typeof kind === "string" ? [kind] : [])];
		return JSON.stringify({
			content: text,
			tags,
			source: "mnemosyne",
			metadata,
		});
	} catch {
		return null;
	}
}

export type LegacyReplaySummary = ReplaySummary & { skipped: number };

// Drain the legacy mem0 outbox into moneta under the same
// confirmed-2xx-or-keep contract as replayOutbox. No-op when the directory
// does not exist — hosts that never dual-wrote (or finished migrating and
// deleted it) pay nothing.
export async function replayLegacyOutbox(): Promise<LegacyReplaySummary> {
	const summary: LegacyReplaySummary = { replayed: 0, kept: 0, skipped: 0 };
	let files: string[];
	try {
		files = readdirSync(legacyOutboxDir()).filter((n) => n.endsWith(".json"));
	} catch {
		return summary;
	}
	for (const f of files) {
		const p = join(legacyOutboxDir(), f);
		let raw: string;
		try {
			raw = readFileSync(p, "utf8");
		} catch {
			continue;
		}
		const capture = convertLegacyPayload(raw);
		if (capture === null) {
			summary.skipped++;
			continue;
		}
		if (await postCapture(capture)) {
			rmSync(p);
			summary.replayed++;
		} else {
			summary.kept++;
		}
	}
	return summary;
}

// GET /count — total entries moneta holds. Same token/Access/redirect
// contract as the other calls; fail-open to null so `status` degrades to
// "moneta: unreachable" rather than throwing.
export async function monetaCount(): Promise<number | null> {
	const token = resolveToken();
	if (!token) return null;
	try {
		const res = await fetch(`${monetaUrl()}/count`, {
			headers: {
				authorization: `Bearer ${token}`,
				...resolveAccessHeaders(),
			},
			redirect: "manual",
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { count?: unknown };
		return typeof data.count === "number" ? data.count : null;
	} catch {
		return null;
	}
}

// ─── recall (read path) ──────────────────────────────────────────────────────

export type RecallResult = { content: string };

// GET /recall with insight=false (skips moneta's ~5s LLM prose synthesis —
// machine callers never show it). Same token/Access resolution and
// never-follow-redirects contract as the capture path. Fail-open: any
// problem returns null so a session start can never break on recall.
export async function recallMoneta(
	query: string,
	topK = 5,
): Promise<RecallResult[] | null> {
	const token = resolveToken();
	if (!token) return null;
	try {
		const u = new URL(`${monetaUrl()}/recall`);
		u.searchParams.set("q", query);
		u.searchParams.set("topK", String(topK));
		u.searchParams.set("insight", "false");
		const res = await fetch(u, {
			headers: {
				authorization: `Bearer ${token}`,
				...resolveAccessHeaders(),
			},
			redirect: "manual",
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { results?: unknown };
		if (!Array.isArray(data.results)) return null;
		return data.results.filter(
			(r): r is RecallResult =>
				!!r && typeof (r as RecallResult).content === "string",
		);
	} catch {
		return null;
	}
}
