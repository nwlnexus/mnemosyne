# Mnemosyne

Mnemosyne worker: enqueue session transcripts, POST them to moneta's `/capture-session` (which does ALL extraction/embedding server-side), and route the returned decision/lesson learnings to the local second-brain inbox. See olympus-sdk `docs/superpowers/specs/2026-07-05-mnemosyne-capture-pipeline-design.md`.

## Install

```sh
npm install -g @nwlnexus/mnemosyne
```

Requires Node.js `>=24`. This installs the prebuilt `mnemosyne` CLI with zero
runtime dependencies beyond the Node binary itself — no local build step, no
git credentials, works on any machine with npm.

Run `mnemosyne install-hooks` afterwards to wire the agent-agnostic hooks
described below.

### Legacy: nix flake install

Older machines managed via `nix-darwin-hm` may still consume mnemosyne as a
nix flake package (`nix build .#`, or via the flake's `packages.default`
output, substituted from the project's own R2 binary cache in CI). This path
is deprecated in favor of the npm package above and is kept only for
already-provisioned hosts — new installs should use `npm install -g` instead.

## Configuration

mnemosyne is not tied to any one moneta deployment. **The defaults below
point at the original maintainer's own private moneta instance** — they
exist so mnemosyne works out of the box for that one setup, not because the
values are fixed or required. If you're running mnemosyne against your own
[moneta](https://github.com/nwlnexus/moneta) instance (or a fork/compatible
backend), set at minimum `MONETA_URL` and `MONETA_AUTH_TOKEN` (or
`MONETA_TOKEN_FILE`) to point at it — nothing in the code assumes
`mem.nwlnexus.io` specifically, that's purely the shipped default value.

| Var | Purpose | Default |
| --- | --- | --- |
| `MNEMOSYNE_HOME` | Queue / ledger / outbox root | `~/.claude/mnemosyne` |
| `SECOND_BRAIN_PATH` | Obsidian vault for the brain inbox | `~/Documents/Obsidian Vault/brain` |
| `MONETA_URL` | moneta capture endpoint base — **override this to point at your own moneta instance** | `https://mem.nwlnexus.io` |
| `MONETA_AUTH_TOKEN` | Bearer token for your moneta instance's `/capture` endpoint | — |
| `MONETA_TOKEN_FILE` | File to read the Bearer token from (trimmed) if `MONETA_AUTH_TOKEN` is unset | `~/.config/moneta/token` |
| `CF_ACCESS_CLIENT_ID` | Cloudflare Access Service Auth client ID — only needed if *your* moneta instance sits behind Cloudflare Access | — |
| `CF_ACCESS_CLIENT_SECRET` | Cloudflare Access Service Auth client secret — same caveat as above | — |

None of these have to be set for mnemosyne to run — with nothing configured
it talks to the maintainer's own instance, which will simply reject writes
it isn't authorized for (fail-open: rejected/failed captures spool locally
to `${MNEMOSYNE_HOME}/moneta-outbox/` rather than being lost, and replay on
the next successful drain once you've pointed it at a real, authorized
instance).

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
(`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`) are sent when set — only
relevant if the moneta instance you've configured sits behind Cloudflare
Access; most self-hosted moneta deployments won't need these at all.
Captures are fail-open: any failure spools the payload to
`${MNEMOSYNE_HOME}/moneta-outbox/` and the next `drain` replays it (moneta
dedupes server-side).

> The maintainer's own hosts provision `MONETA_AUTH_TOKEN` and the
> `CF_ACCESS_*` vars via a `nix-darwin-hm`-managed `.env` file — that's
> specific to that one setup, not a requirement of mnemosyne itself. Any
> mechanism that gets these into the process environment (a plain `.env`
> sourced by your shell, a secrets manager, `MONETA_TOKEN_FILE` pointing at
> a file on disk) works equally well.
