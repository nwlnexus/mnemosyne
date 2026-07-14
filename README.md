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
