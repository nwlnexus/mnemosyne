import { expect, test } from "vitest";
import { parseTranscript } from "../src/transcript.js";

test("parseTranscript extracts user + assistant text, drops tool_use and summary", () => {
	const turns = parseTranscript("test/fixtures/session-basic.jsonl");
	expect(turns).toEqual([
		{ role: "user", text: "we decided to split Heimdall auth out of Hermes" },
		{ role: "assistant", text: "Done. PR #199 merged." },
	]);
});
