import { homedir } from "node:os";
import { join } from "node:path";

export function mnemosyneHome(): string {
	return process.env.MNEMOSYNE_HOME ?? join(homedir(), ".claude", "mnemosyne");
}
export function brainInboxDir(): string {
	const sb =
		process.env.SECOND_BRAIN_PATH ??
		join(homedir(), "Documents", "Obsidian Vault", "brain");
	return join(sb, "raw", "_inbox");
}
