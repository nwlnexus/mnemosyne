# CLAUDE.md — mnemosyne

> Claude Code project memory. Concise, directive. Also accessible as
> `AGENTS.md` (agents.md open-standard format) and `GEMINI.md` — both are
> symlinks to this file, so there is exactly one copy to keep current.

mnemosyne is an agent-agnostic session-learning capture CLI: it hooks into
Claude Code, Codex, Cursor, Copilot CLI, and Gemini CLI's lifecycle events,
enqueues session transcripts, and routes extracted decisions/lessons to
[moneta](https://github.com/nwlnexus/moneta) (the shared memory backend) and
the local second-brain inbox. See `README.md` for install, configuration, and
the full per-agent hook reference.

## Quick Commands

- `pnpm build` (tsc → `dist/`) / `pnpm clean`
- `pnpm test` / `pnpm test:watch` (vitest)
- `pnpm typecheck` / `pnpm lint` (Biome)

## Rules

- **Conventional commits; PR titles must follow the format** (`feat:`,
  `fix:`, `chore:`, `feat!:`/`fix!:` for breaking changes, etc.). This repo
  squash-merges PRs, and the PR title becomes the commit message on `main`
  that `semantic-release` parses to compute the next version and generate
  `CHANGELOG.md` — a non-conventional title means that change is silently
  invisible to the release pipeline (no version bump, nothing in the
  changelog), not just a style nit.
- **Do NOT hand-edit `package.json`'s `version` field or `CHANGELOG.md`** —
  `semantic-release` owns both (see `release.config.cjs`, runs on every push
  to `main` via `.github/workflows/release.yml`). Manual edits will be
  overwritten or will conflict with its next run.
- **Do NOT run `npm publish` by hand.** Publishing is fully automatic:
  `semantic-release` computes the version and pushes a `vX.Y.Z` tag, which
  triggers `.github/workflows/npm-publish.yml` — that workflow publishes via
  npm **Trusted Publishing (OIDC)**, not a stored token. There is nothing to
  authenticate manually and no secret to rotate.
- **Do NOT skip hooks** (`--no-verify`) — the husky pre-commit hook runs a
  `betterleaks` secret scan.
- **The moneta backend URL/auth are configurable, not hardcoded** — see
  `README.md`'s Configuration section before assuming `MONETA_URL` always
  points at `mem.nwlnexus.io`; it's an override-able default, not a
  requirement, for anyone else running this CLI against their own moneta
  instance.
- **There is no nix packaging anymore** — `flake.nix` and the `nix-cache.yml`
  CI workflow were removed (mnemosyne#33) once `nix-darwin-hm` migrated to
  consuming this as an `npm:@nwlnexus/mnemosyne` mise global instead
  (nix-darwin-hm#58/#61). `npm install -g @nwlnexus/mnemosyne` is the only
  supported install path — don't reintroduce nix-specific packaging.

## Layout

- `src/cli.ts` — entrypoint (`mnemosyne <command>`), built via `tsc` to
  `dist/cli.js` for the npm package.
- `src/agents.ts` — agent-agnostic hook detection/install/normalization
  (`detectAgents`, `installHooksForAgent`, `normalizePayload`).
- `src/monetaWriter.ts` — moneta `/capture` client (fail-open, outbox spool).
- `src/dispatch.ts` — second-brain inbox writer for routed learnings.
- `.claude-plugin/` — self-contained Claude Code plugin (prebuilt esbuild
  bundle, separate from the `tsc`-built npm package — see its own bundling
  step before assuming the two build outputs are interchangeable).
- `test/` — vitest; `.github/workflows/` — CI (`npm-publish.yml` OIDC
  publish, `release.yml` semantic-release).
