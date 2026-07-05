import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { isSecret, route } from "../src/policy.js";
import type { Learning } from "../src/types.js";

const prov = { session: "s", cwd: "/x", ts: "2026-07-05T00:00:00Z" };
const golden = JSON.parse(readFileSync("test/fixtures/golden-routing.json", "utf8")) as Array<{
  kind: Learning["kind"]; confidence: number; text: string; expect: string[];
}>;

test.each(golden)("route: $text", ({ kind, confidence, text, expect: want }) => {
  const l: Learning = { text, kind, confidence, provenance: prov };
  expect(route(l).sort()).toEqual([...want].sort());
});

test("isSecret flags token-shaped strings", () => {
  expect(isSecret("sk-abc123deadbeef")).toBe(true);
  expect(isSecret("PR #201 merged")).toBe(false);
});
