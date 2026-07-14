# Mnemosyne

Mnemosyne worker: extract → route → dispatch session learnings. See olympus-sdk `docs/superpowers/specs/2026-07-05-mnemosyne-capture-pipeline-design.md`.

## Environment

| Var | Purpose | Default |
| --- | --- | --- |
| `MNEMOSYNE_HOME` | Queue / ledger / outbox root | `~/.claude/mnemosyne` |
| `SECOND_BRAIN_PATH` | Obsidian vault for the brain inbox | `~/Documents/Obsidian Vault/brain` |
| `MONETA_URL` | moneta capture endpoint base | `https://mem.nwlnexus.io` |
| `MONETA_AUTH_TOKEN` | Bearer token for moneta `/capture` | — |
| `MONETA_TOKEN_FILE` | File to read the Bearer token from (trimmed) if `MONETA_AUTH_TOKEN` is unset | `~/.config/moneta/token` |
| `CF_ACCESS_CLIENT_ID` | Cloudflare Access Service Auth client ID (edge gate) | — |
| `CF_ACCESS_CLIENT_SECRET` | Cloudflare Access Service Auth client secret | — |

### agent-agnostic hooks

mnemosyne is not tied to one AI agent. `mnemosyne install-hooks` detects the
installed agents and inserts lifecycle hooks into each one's config
(idempotent — entries containing `mnemosyne` are treated as already wired,
including the legacy nix-managed shell scripts):

| agent | config | session start | capture (enqueue) |
|---|---|---|---|
| claude | `~/.claude/settings.json` | SessionStart | SessionEnd + PreCompact (`transcript_path` on stdin) |
| codex | `~/.codex/hooks.json` (+ `[features] hooks = true` in config.toml) | SessionStart | Stop + PreCompact (rollout discovered under `~/.codex/sessions/`) |
| cursor | `~/.cursor/hooks.json` (flat schema) | sessionStart | stop (`transcript_path` on stdin) |
| copilot-cli | `~/.copilot/hooks/mnemosyne.json` | sessionStart | — (no transcript surface; drain + recall only) |
| gemini | `~/.gemini/settings.json` (shared with Antigravity IDE) | SessionStart | PreCompress (newest chat under `~/.gemini/tmp/<hash>/chats/`) |

All hooks invoke the same entrypoint — `mnemosyne hook <agent> <event>` —
which normalizes the payload, enqueues transcripts, kicks a background
drain, and on session start injects moneta recall context in the agent's
expected stdout shape. Every path is fail-open. `mnemosyne agents` shows
what is detected; `install-hooks --dry-run` previews changes.

### moneta capture

moneta is the sole memory sink (the phase-1 mem0 dual-write is retired):
every routable fact/decision is captured to moneta
(`POST {MONETA_URL}/capture`). The Bearer token resolves from
`MONETA_AUTH_TOKEN` first, else from the file at `MONETA_TOKEN_FILE`
(default `~/.config/moneta/token`). Cloudflare Access Service Auth headers
(`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`) are sent when set — required
once the domain-wide `moneta-access` app is live. Both are provisioned via
`~/projects/personal/.env` (nix-darwin-hm op-secrets). Captures are fail-open: any failure spools the
payload to `${MNEMOSYNE_HOME}/moneta-outbox/` and the next `drain` replays it
(moneta dedupes server-side).
