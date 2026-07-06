import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// Delegates to the resilient shell writer (Task B1) so outbox/retry lives in one place.
export async function spawnMem0Add(json: string): Promise<void> {
	await execFileAsync("mem0-add.sh", [json], { maxBuffer: 4 * 1024 * 1024 });
}
