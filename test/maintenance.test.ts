import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { countEntries, oldestAgeMs, pruneDead } from "../src/cli.js";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "dead-"));
}
function touch(dir: string, name: string, ageMs = 0, now = Date.now()): string {
	const p = join(dir, name);
	writeFileSync(p, "{}");
	if (ageMs > 0) {
		const t = new Date(now - ageMs);
		utimesSync(p, t, t);
	}
	return p;
}

const DAY = 24 * 60 * 60 * 1000;

test("pruneDead deletes entries older than the TTL and keeps recent ones", () => {
	const dir = tmp();
	touch(dir, "old.json", 40 * DAY);
	touch(dir, "fresh.json", 2 * DAY);

	const pruned = pruneDead(dir, 30 * DAY);

	expect(pruned).toBe(1);
	expect(readdirSync(dir)).toEqual(["fresh.json"]);
});

test("pruneDead on a missing directory returns 0 and does not throw", () => {
	expect(pruneDead(join(tmpdir(), "no-such-dir-xyz"))).toBe(0);
});

test("pruneDead keeps everything when all entries are within the TTL", () => {
	const dir = tmp();
	touch(dir, "a.json", 1 * DAY);
	touch(dir, "b.json", 5 * DAY);

	expect(pruneDead(dir, 30 * DAY)).toBe(0);
	expect(readdirSync(dir).sort()).toEqual(["a.json", "b.json"]);
});

test("countEntries counts only *.json and tolerates a missing dir", () => {
	const dir = tmp();
	touch(dir, "one.json");
	touch(dir, "two.json");
	touch(dir, "note.txt");

	expect(countEntries(dir)).toBe(2);
	expect(countEntries(join(tmpdir(), "absent-dir-xyz"))).toBe(0);
});

test("oldestAgeMs returns the age of the oldest entry, or null when empty/absent", () => {
	const dir = tmp();
	const now = Date.now();
	touch(dir, "recent.json", 1 * DAY, now);
	touch(dir, "ancient.json", 10 * DAY, now);

	const age = oldestAgeMs(dir, now);
	expect(age).not.toBeNull();
	// oldest is ~10 days; allow a small slop for mtime rounding
	expect(Math.round((age as number) / DAY)).toBe(10);
	expect(oldestAgeMs(join(tmpdir(), "absent-dir-xyz"))).toBeNull();
});
