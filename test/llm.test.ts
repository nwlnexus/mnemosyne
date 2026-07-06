import { expect, test, vi } from "vitest";
import { callLLM } from "../src/llm.js";

test("callLLM uses Ollama when it succeeds", async () => {
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify({ response: "ollama-said-this" }), { status: 200 }),
  ) as unknown as typeof fetch;
  const out = await callLLM("hi", { fetchImpl, runClaude: async () => "claude", ollamaUrl: "http://x", model: "m" });
  expect(out).toBe("ollama-said-this");
});

test("callLLM falls back to claude when Ollama fails", async () => {
  const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  const out = await callLLM("hi", { fetchImpl, runClaude: async () => "claude-fallback", ollamaUrl: "http://x", model: "m" });
  expect(out).toBe("claude-fallback");
});
