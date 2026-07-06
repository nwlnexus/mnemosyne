import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type LLMDeps = {
	fetchImpl?: typeof fetch;
	runClaude?: (prompt: string) => Promise<string>;
	ollamaUrl?: string;
	model?: string;
};

async function defaultRunClaude(prompt: string): Promise<string> {
	const { stdout } = await execFileAsync("claude", ["-p", prompt], {
		maxBuffer: 10 * 1024 * 1024,
	});
	return stdout;
}

export async function callLLM(
	prompt: string,
	deps: LLMDeps = {},
): Promise<string> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const runClaude = deps.runClaude ?? defaultRunClaude;
	const ollamaUrl =
		deps.ollamaUrl ??
		process.env.MNEMOSYNE_OLLAMA_URL ??
		"http://ai-hub.raptor-mimosa.ts.net:11434";
	const model = deps.model ?? process.env.MNEMOSYNE_MODEL ?? "qwen3.5:9b";
	try {
		const res = await fetchImpl(`${ollamaUrl}/api/generate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model, prompt, stream: false }),
		});
		if (!res.ok) throw new Error(`ollama ${res.status}`);
		const data = (await res.json()) as { response?: string };
		if (!data.response) throw new Error("ollama empty response");
		return data.response;
	} catch {
		return runClaude(prompt);
	}
}
