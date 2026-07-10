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

### moneta dual-write

Phase 1: every learning routed to mem0 is **also** captured to moneta
(`POST {MONETA_URL}/capture`). The Bearer token resolves from
`MONETA_AUTH_TOKEN` first, else from the file at `MONETA_TOKEN_FILE`
(default `~/.config/moneta/token`). The token file is provisioned
out-of-band by nix-darwin-hm. Captures are fail-open: any failure spools the
payload to `${MNEMOSYNE_HOME}/moneta-outbox/` and the next `drain` replays it
(moneta dedupes server-side). Phase 2 (removing mem0) is tracked in
`nwlnexus/moneta`.
