import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	replayLegacyOutbox,
	replayOutbox,
	writeMoneta,
} from "../src/monetaWriter.js";

// Env keys this suite mutates; snapshot + restore so tests stay isolated.
const ENV_KEYS = [
	"MNEMOSYNE_HOME",
	"MONETA_URL",
	"MONETA_AUTH_TOKEN",
	"MONETA_TOKEN_FILE",
	"CF_ACCESS_CLIENT_ID",
	"CF_ACCESS_CLIENT_SECRET",
];
const saved: Record<string, string | undefined> = {};

function outbox(home: string): string {
	return join(home, "moneta-outbox");
}

// The outbox dir is created lazily (only when something spools), so treat a
// missing dir as empty.
function outboxFiles(home: string): string[] {
	const dir = outbox(home);
	return existsSync(dir) ? readdirSync(dir) : [];
}

function okFetch() {
	return vi.fn(
		async () => new Response('{"ok":true,"id":"x"}', { status: 200 }),
	);
}

beforeEach(() => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	const home = mkdtempSync(join(tmpdir(), "mnemo-home-"));
	process.env.MNEMOSYNE_HOME = home;
	process.env.MONETA_URL = "https://moneta.test";
	process.env.MONETA_AUTH_TOKEN = "tok-123";
	process.env.CF_ACCESS_CLIENT_ID = "cf-id";
	process.env.CF_ACCESS_CLIENT_SECRET = "cf-secret";
	// point token-file resolution somewhere that does not exist by default
	process.env.MONETA_TOKEN_FILE = join(home, "no-such-token");
});

afterEach(() => {
	vi.unstubAllGlobals();
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

test("writeMoneta posts to /capture with a Bearer header on success", async () => {
	const fetchMock = okFetch();
	vi.stubGlobal("fetch", fetchMock);
	const json = JSON.stringify({
		content: "hi",
		tags: ["mnemosyne"],
		source: "mnemosyne",
	});

	await writeMoneta(json);

	expect(fetchMock).toHaveBeenCalledOnce();
	const [url, init] = fetchMock.mock.calls[0];
	expect(url).toBe("https://moneta.test/capture");
	expect(init.method).toBe("POST");
	expect(init.headers.authorization).toBe("Bearer tok-123");
	expect(init.headers["CF-Access-Client-Id"]).toBe("cf-id");
	expect(init.headers["CF-Access-Client-Secret"]).toBe("cf-secret");
	expect(init.body).toBe(json);
	// nothing spooled on success
	expect(outboxFiles(process.env.MNEMOSYNE_HOME as string)).toHaveLength(0);
});

test("writeMoneta resolves the token from MONETA_TOKEN_FILE when env is unset", async () => {
	const fetchMock = okFetch();
	vi.stubGlobal("fetch", fetchMock);
	delete process.env.MONETA_AUTH_TOKEN;
	const tokenFile = join(process.env.MNEMOSYNE_HOME as string, "token");
	writeFileSync(tokenFile, "file-tok\n");
	process.env.MONETA_TOKEN_FILE = tokenFile;

	await writeMoneta("{}");

	expect(fetchMock.mock.calls[0][1].headers.authorization).toBe(
		"Bearer file-tok",
	);
});

test("writeMoneta spools and does not throw on a non-2xx response", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("nope", { status: 500 })),
	);
	const json = JSON.stringify({ content: "boom" });

	await expect(writeMoneta(json)).resolves.toBeUndefined();

	const dir = outbox(process.env.MNEMOSYNE_HOME as string);
	const files = readdirSync(dir);
	expect(files).toHaveLength(1);
	expect(readFileSync(join(dir, files[0]), "utf8")).toBe(json);
});

test("writeMoneta spools when no token can be resolved (fetch never runs)", async () => {
	const fetchMock = okFetch();
	vi.stubGlobal("fetch", fetchMock);
	delete process.env.MONETA_AUTH_TOKEN;

	await expect(writeMoneta("{}")).resolves.toBeUndefined();

	expect(fetchMock).not.toHaveBeenCalled();
	expect(
		readdirSync(outbox(process.env.MNEMOSYNE_HOME as string)),
	).toHaveLength(1);
});

test("writeMoneta spools on a network error without throwing", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		}),
	);

	await expect(writeMoneta("{}")).resolves.toBeUndefined();

	expect(
		readdirSync(outbox(process.env.MNEMOSYNE_HOME as string)),
	).toHaveLength(1);
});

test("writeMoneta does not duplicate spool files for identical content", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("nope", { status: 500 })),
	);
	await writeMoneta('{"content":"dup"}');
	await writeMoneta('{"content":"dup"}');
	expect(
		readdirSync(outbox(process.env.MNEMOSYNE_HOME as string)),
	).toHaveLength(1);
});

test("replayOutbox deletes a spooled file on confirmed 2xx", async () => {
	const dir = outbox(process.env.MNEMOSYNE_HOME as string);
	// seed a spool file via a failing write
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("nope", { status: 500 })),
	);
	await writeMoneta('{"content":"replay-me"}');
	expect(readdirSync(dir)).toHaveLength(1);

	// now the service is healthy → replay drains the outbox
	vi.stubGlobal("fetch", okFetch());
	await replayOutbox();
	expect(readdirSync(dir)).toHaveLength(0);
});

test("replayOutbox keeps a spooled file when the post fails", async () => {
	const dir = outbox(process.env.MNEMOSYNE_HOME as string);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("nope", { status: 500 })),
	);
	await writeMoneta('{"content":"still-down"}');
	expect(readdirSync(dir)).toHaveLength(1);

	await replayOutbox(); // still failing
	expect(readdirSync(dir)).toHaveLength(1);
});

// Emulates undici's default redirect handling at the mock layer: a CF
// Access-style 302 (expired/invalid service token) is transparently followed
// to the login page — a 200 text/html — unless the caller opts out with
// redirect:"manual". This is the production trap: the followed login page's
// 200 read as success and outbox files were silently deleted.
function accessRedirectFetch() {
	return vi.fn(async (_url: unknown, init?: RequestInit) =>
		init?.redirect === "manual"
			? new Response(null, {
					status: 302,
					headers: {
						location:
							"https://nwlnexus.cloudflareaccess.com/cdn-cgi/access/login",
					},
				})
			: new Response("<html>Cloudflare Access login</html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
	);
}

test("writeMoneta spools when CF Access answers with a login redirect", async () => {
	const dir = outbox(process.env.MNEMOSYNE_HOME as string);
	vi.stubGlobal("fetch", accessRedirectFetch());
	await writeMoneta('{"content":"behind-expired-token"}');
	expect(readdirSync(dir)).toHaveLength(1);
});

test("replayOutbox keeps spooled files when CF Access answers with a login redirect", async () => {
	const dir = outbox(process.env.MNEMOSYNE_HOME as string);
	// spool one entry while the service is down
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("nope", { status: 500 })),
	);
	await writeMoneta('{"content":"spooled-while-down"}');
	expect(readdirSync(dir)).toHaveLength(1);

	// service now "answers" — but it's the Access login redirect, not moneta
	vi.stubGlobal("fetch", accessRedirectFetch());
	expect(await replayOutbox()).toEqual({ replayed: 0, kept: 1 });
	expect(readdirSync(dir)).toHaveLength(1);
});

test("replayOutbox reports how many files it replayed vs kept", async () => {
	const dir = outbox(process.env.MNEMOSYNE_HOME as string);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("nope", { status: 500 })),
	);
	await writeMoneta('{"content":"a"}');
	await writeMoneta('{"content":"b"}');
	expect(readdirSync(dir)).toHaveLength(2);

	vi.stubGlobal("fetch", okFetch());
	expect(await replayOutbox()).toEqual({ replayed: 2, kept: 0 });
	expect(readdirSync(dir)).toHaveLength(0);
});

// --- legacy mem0 outbox migration -----------------------------------------
// Entries spooled before the mem0 retirement are mem0-API-shaped. They drain
// through the same confirmed-2xx-or-keep contract, converted to moneta
// captures. A missing/empty legacy outbox is a no-op — machines that never
// ran the dual-write (or already migrated) pay nothing.

function legacyDir(home: string): string {
	return join(home, "outbox");
}

function writeLegacy(home: string, name: string, payload: unknown): void {
	mkdirSync(legacyDir(home), { recursive: true });
	writeFileSync(join(legacyDir(home), name), JSON.stringify(payload));
}

test("replayLegacyOutbox converts a mem0 payload into a moneta capture", async () => {
	const home = process.env.MNEMOSYNE_HOME as string;
	writeLegacy(home, "a.json", {
		user_id: "mnemosyne",
		text: "chose D1 over Neon",
		infer: false,
		app: "claude-code",
		metadata: { kind: "decision", session: "s1", cwd: "/repo", ts: "t1" },
	});
	const fetchMock = okFetch();
	vi.stubGlobal("fetch", fetchMock);

	expect(await replayLegacyOutbox()).toEqual({
		replayed: 1,
		kept: 0,
		skipped: 0,
	});
	expect(readdirSync(legacyDir(home))).toHaveLength(0);
	const body = JSON.parse(fetchMock.mock.calls[0][1].body);
	expect(body).toEqual({
		content: "chose D1 over Neon",
		tags: ["mnemosyne", "decision"],
		source: "mnemosyne",
		metadata: { kind: "decision", session: "s1", cwd: "/repo", ts: "t1" },
	});
});

test("replayLegacyOutbox tolerates minimal payloads without metadata", async () => {
	const home = process.env.MNEMOSYNE_HOME as string;
	writeLegacy(home, "min.json", { user_id: "mnemosyne", text: "queued" });
	const fetchMock = okFetch();
	vi.stubGlobal("fetch", fetchMock);

	expect(await replayLegacyOutbox()).toEqual({
		replayed: 1,
		kept: 0,
		skipped: 0,
	});
	const body = JSON.parse(fetchMock.mock.calls[0][1].body);
	expect(body.tags).toEqual(["mnemosyne"]);
	expect(body.metadata).toEqual({});
});

test("replayLegacyOutbox keeps entries on failure and skips malformed ones", async () => {
	const home = process.env.MNEMOSYNE_HOME as string;
	writeLegacy(home, "good.json", { user_id: "m", text: "still down" });
	writeFileSync(join(legacyDir(home), "junk.json"), "not json at all");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("nope", { status: 500 })),
	);

	expect(await replayLegacyOutbox()).toEqual({
		replayed: 0,
		kept: 1,
		skipped: 1,
	});
	expect(readdirSync(legacyDir(home)).sort()).toEqual([
		"good.json",
		"junk.json",
	]);
});

test("replayLegacyOutbox no-ops when the legacy outbox does not exist", async () => {
	const fetchMock = okFetch();
	vi.stubGlobal("fetch", fetchMock);

	expect(await replayLegacyOutbox()).toEqual({
		replayed: 0,
		kept: 0,
		skipped: 0,
	});
	expect(fetchMock).not.toHaveBeenCalled();
});
