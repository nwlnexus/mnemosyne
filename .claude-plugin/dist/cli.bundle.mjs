#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/config.ts
var config_exports = {};
__export(config_exports, {
  brainInboxDir: () => brainInboxDir,
  mnemosyneHome: () => mnemosyneHome
});
import { homedir } from "node:os";
import { join } from "node:path";
function mnemosyneHome() {
  return process.env.MNEMOSYNE_HOME ?? join(homedir(), ".claude", "mnemosyne");
}
function brainInboxDir() {
  const sb = process.env.SECOND_BRAIN_PATH ?? join(homedir(), "Documents", "Obsidian Vault", "brain");
  return join(sb, "raw", "_inbox");
}
var init_config = __esm({
  "src/config.ts"() {
    "use strict";
  }
});

// src/errors.ts
var PermanentDrainError;
var init_errors = __esm({
  "src/errors.ts"() {
    "use strict";
    PermanentDrainError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "PermanentDrainError";
      }
    };
  }
});

// src/monetaWriter.ts
var monetaWriter_exports = {};
__export(monetaWriter_exports, {
  captureSession: () => captureSession,
  monetaCount: () => monetaCount,
  monetaOutboxDir: () => monetaOutboxDir,
  postCapture: () => postCapture,
  recallMoneta: () => recallMoneta,
  replayLegacyOutbox: () => replayLegacyOutbox,
  replayOutbox: () => replayOutbox,
  writeMoneta: () => writeMoneta
});
import { createHash as createHash2 } from "node:crypto";
import {
  mkdirSync as mkdirSync2,
  readdirSync,
  readFileSync as readFileSync2,
  rmSync,
  writeFileSync as writeFileSync3
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join4 } from "node:path";
function monetaUrl() {
  return process.env.MONETA_URL ?? DEFAULT_URL;
}
function resolveFileBackedCredential(envVar, fileEnvVar, defaultFile) {
  const fromEnv = process.env[envVar]?.trim();
  if (fromEnv) return fromEnv;
  const file = process.env[fileEnvVar] ?? defaultFile;
  try {
    return readFileSync2(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}
function resolveToken() {
  return resolveFileBackedCredential(
    "MONETA_AUTH_TOKEN",
    "MONETA_TOKEN_FILE",
    join4(homedir2(), ".config", "moneta", "token")
  );
}
function resolveAccessHeaders() {
  const id = resolveFileBackedCredential(
    "CF_ACCESS_CLIENT_ID",
    "CF_ACCESS_CLIENT_ID_FILE",
    join4(homedir2(), ".config", "moneta", "cf-access-client-id")
  );
  const secret = resolveFileBackedCredential(
    "CF_ACCESS_CLIENT_SECRET",
    "CF_ACCESS_CLIENT_SECRET_FILE",
    join4(homedir2(), ".config", "moneta", "cf-access-client-secret")
  );
  if (!id || !secret) return {};
  return {
    "CF-Access-Client-Id": id,
    "CF-Access-Client-Secret": secret
  };
}
function monetaOutboxDir() {
  const home = process.env.MNEMOSYNE_HOME ?? join4(homedir2(), ".claude", "mnemosyne");
  return join4(home, "moneta-outbox");
}
async function postCapture(json) {
  const token = resolveToken();
  if (!token) return false;
  try {
    const res = await fetch(`${monetaUrl()}/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...resolveAccessHeaders()
      },
      body: json,
      // NEVER follow redirects: when the CF Access service token is
      // invalid/expired, the edge 302s to the Access login page, and a
      // followed redirect lands on that page's 200 — which read as success
      // and silently deleted outbox files. Manual mode surfaces the 302
      // itself, so res.ok is false and the capture stays spooled.
      redirect: "manual"
    });
    return res.ok;
  } catch {
    return false;
  }
}
async function captureSession(payload) {
  const token = resolveToken();
  if (!token) {
    throw new Error("moneta capture-session: no auth token resolved");
  }
  let res;
  try {
    res = await fetch(`${monetaUrl()}/capture-session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...resolveAccessHeaders()
      },
      body: JSON.stringify(payload),
      // See postCapture: never follow redirects (CF Access login trap).
      redirect: "manual"
    });
  } catch (err) {
    throw new Error(
      `moneta capture-session: network error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (res.status === 400 || res.status === 413) {
    throw new PermanentDrainError(
      `moneta capture-session rejected the request (${res.status})`
    );
  }
  if (!res.ok) {
    throw new Error(`moneta capture-session failed: ${res.status}`);
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(
      `moneta capture-session: failed to parse response: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!data.ok || !Array.isArray(data.learnings)) {
    throw new Error("moneta capture-session: unexpected response shape");
  }
  return {
    status: data.status === "already_captured" ? "already_captured" : "captured",
    learnings: data.learnings
  };
}
function spool(json) {
  const dir = monetaOutboxDir();
  mkdirSync2(dir, { recursive: true });
  const name = createHash2("sha256").update(json).digest("hex").slice(0, 32);
  writeFileSync3(join4(dir, `${name}.json`), json);
}
async function writeMoneta(json) {
  if (await postCapture(json)) return;
  spool(json);
}
async function replayOutbox() {
  const summary = { replayed: 0, kept: 0 };
  let files;
  try {
    files = readdirSync(monetaOutboxDir()).filter((n) => n.endsWith(".json"));
  } catch {
    return summary;
  }
  for (const f of files) {
    const p = join4(monetaOutboxDir(), f);
    let json;
    try {
      json = readFileSync2(p, "utf8");
    } catch {
      continue;
    }
    if (await postCapture(json)) {
      rmSync(p);
      summary.replayed++;
    } else {
      summary.kept++;
    }
  }
  return summary;
}
function legacyOutboxDir() {
  const home = process.env.MNEMOSYNE_HOME ?? join4(homedir2(), ".claude", "mnemosyne");
  return join4(home, "outbox");
}
function convertLegacyPayload(raw) {
  try {
    const o = JSON.parse(raw);
    const text = typeof o.text === "string" && o.text.trim() ? o.text : null;
    if (!text) return null;
    const metadata = o.metadata && typeof o.metadata === "object" ? o.metadata : {};
    const kind = metadata.kind;
    const tags = ["mnemosyne", ...typeof kind === "string" ? [kind] : []];
    return JSON.stringify({
      content: text,
      tags,
      source: "mnemosyne",
      metadata
    });
  } catch {
    return null;
  }
}
async function replayLegacyOutbox() {
  const summary = { replayed: 0, kept: 0, skipped: 0 };
  let files;
  try {
    files = readdirSync(legacyOutboxDir()).filter((n) => n.endsWith(".json"));
  } catch {
    return summary;
  }
  for (const f of files) {
    const p = join4(legacyOutboxDir(), f);
    let raw;
    try {
      raw = readFileSync2(p, "utf8");
    } catch {
      continue;
    }
    const capture = convertLegacyPayload(raw);
    if (capture === null) {
      summary.skipped++;
      continue;
    }
    if (await postCapture(capture)) {
      rmSync(p);
      summary.replayed++;
    } else {
      summary.kept++;
    }
  }
  return summary;
}
async function monetaCount() {
  const token = resolveToken();
  if (!token) return null;
  try {
    const res = await fetch(`${monetaUrl()}/count`, {
      headers: {
        authorization: `Bearer ${token}`,
        ...resolveAccessHeaders()
      },
      redirect: "manual"
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.count === "number" ? data.count : null;
  } catch {
    return null;
  }
}
async function recallMoneta(query, topK = 5) {
  const token = resolveToken();
  if (!token) return null;
  try {
    const u = new URL(`${monetaUrl()}/recall`);
    u.searchParams.set("q", query);
    u.searchParams.set("topK", String(topK));
    u.searchParams.set("insight", "false");
    const res = await fetch(u, {
      headers: {
        authorization: `Bearer ${token}`,
        ...resolveAccessHeaders()
      },
      redirect: "manual"
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.results)) return null;
    return data.results.filter(
      (r) => !!r && typeof r.content === "string"
    );
  } catch {
    return null;
  }
}
var DEFAULT_URL;
var init_monetaWriter = __esm({
  "src/monetaWriter.ts"() {
    "use strict";
    init_errors();
    DEFAULT_URL = "https://mem.nwlnexus.io";
  }
});

// src/agents.ts
var agents_exports = {};
__export(agents_exports, {
  AGENTS: () => AGENTS,
  detectAgents: () => detectAgents,
  installHooks: () => installHooks,
  installHooksForAgent: () => installHooksForAgent,
  normalizePayload: () => normalizePayload,
  renderInjection: () => renderInjection
});
import { createHash as createHash3 } from "node:crypto";
import {
  existsSync as existsSync2,
  mkdirSync as mkdirSync3,
  readdirSync as readdirSync2,
  readFileSync as readFileSync3,
  statSync,
  writeFileSync as writeFileSync4
} from "node:fs";
import { homedir as homedir3 } from "node:os";
import { delimiter, join as join5 } from "node:path";
function defaultBinaryExists(name) {
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return paths.some((p) => existsSync2(join5(p, name)));
}
function detectAgents(io) {
  const binaryExists = io.binaryExists ?? defaultBinaryExists;
  const found = [];
  for (const [id, spec] of Object.entries(AGENTS)) {
    if (!existsSync2(join5(io.home, spec.markerDir))) continue;
    const confirmed = spec.binary === null && spec.markerFile === null || spec.binary !== null && binaryExists(spec.binary) || spec.markerFile !== null && existsSync2(join5(io.home, spec.markerFile));
    if (confirmed) found.push(id);
  }
  return found;
}
function str(v) {
  return typeof v === "string" && v.trim() ? v : null;
}
function findCodexRollout(home, sessionId) {
  const root = join5(home, ".codex", "sessions");
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try {
      names = readdirSync2(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = join5(dir, n);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      if (isDir) stack.push(p);
      else if (n.startsWith("rollout-") && n.endsWith(`-${sessionId}.jsonl`))
        return p;
    }
  }
  return null;
}
function findGeminiChat(home, cwd) {
  const hash = createHash3("sha256").update(cwd).digest("hex");
  const dir = join5(home, ".gemini", "tmp", hash, "chats");
  let names;
  try {
    names = readdirSync2(dir).filter(
      (n) => n.startsWith("session-") && n.endsWith(".json")
    );
  } catch {
    return null;
  }
  if (!names.length) return null;
  let newest = null;
  for (const n of names) {
    const p = join5(dir, n);
    let m = 0;
    try {
      m = statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || m > newest.m || m === newest.m && p > newest.p)
      newest = { p, m };
  }
  return newest?.p ?? null;
}
function normalizePayload(agent, stdin, io) {
  let p = {};
  try {
    const parsed = JSON.parse(stdin);
    if (parsed && typeof parsed === "object") p = parsed;
  } catch {
  }
  const session = str(p.session_id) ?? str(p.sessionId) ?? str(p.conversation_id) ?? str(p.conversationId) ?? `pid-${process.ppid}`;
  const cwd = str(p.cwd) ?? (Array.isArray(p.workspace_roots) ? str(p.workspace_roots[0]) : null) ?? process.cwd();
  let transcript = str(p.transcript_path) ?? str(p.transcriptPath);
  if (!transcript && agent === "codex")
    transcript = findCodexRollout(io.home, session);
  if (!transcript && agent === "gemini")
    transcript = findGeminiChat(io.home, cwd);
  if (agent === "copilot-cli") transcript = null;
  return { session, cwd, transcript };
}
function renderInjection(agent, text) {
  switch (agent) {
    case "cursor":
      return JSON.stringify({ additional_context: text });
    case "copilot-cli":
      return JSON.stringify({ additionalContext: text });
    case "gemini":
      return JSON.stringify({
        hookSpecificOutput: { additionalContext: text }
      });
    default:
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: text
        }
      });
  }
}
function hookCommand(agent, event) {
  return `mnemosyne hook ${agent} ${event}`;
}
function hasNeedle(json) {
  return NEEDLES.some((n) => json.includes(n));
}
function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync3(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function ensureCodexHooksFeature(home, notes) {
  const toml = join5(home, ".codex", "config.toml");
  let raw = "";
  try {
    raw = readFileSync3(toml, "utf8");
  } catch {
  }
  if (/^\s*hooks\s*=\s*true/m.test(raw)) return;
  if (raw.includes("[features]")) {
    notes.push(
      "codex: add `hooks = true` under the existing [features] section of ~/.codex/config.toml manually"
    );
    return;
  }
  writeFileSync4(
    toml,
    `${raw}${raw.endsWith("\n") || !raw ? "" : "\n"}
[features]
hooks = true
`
  );
  notes.push("codex: enabled [features] hooks = true in config.toml");
}
function installHooksForAgent(agent, io, dryRun = false) {
  const spec = AGENTS[agent];
  const cfgPath = join5(io.home, spec.configFile);
  const notes = [];
  const cfg = readJson(cfgPath);
  const before = JSON.stringify(cfg);
  if (hasNeedle(before)) return { agent, changed: false, notes };
  if (cfg.hooks === void 0) cfg.hooks = {};
  const hooks = cfg.hooks;
  for (const [event, kind] of Object.entries(spec.events)) {
    if (hooks[event] === void 0) hooks[event] = [];
    const entries = hooks[event];
    const cmd = hookCommand(agent, kind);
    if (spec.configStyle === "claude-nested") {
      entries.push({ hooks: [{ type: "command", command: cmd, timeout: 20 }] });
    } else if (spec.configStyle === "cursor-flat") {
      entries.push({ command: cmd });
    } else {
      entries.push({ type: "command", command: cmd });
    }
  }
  if (spec.configStyle !== "claude-nested" && cfg.version === void 0)
    cfg.version = 1;
  if (!dryRun) {
    mkdirSync3(join5(cfgPath, ".."), { recursive: true });
    writeFileSync4(cfgPath, `${JSON.stringify(cfg, null, 2)}
`);
    if (agent === "codex") ensureCodexHooksFeature(io.home, notes);
  }
  return { agent, changed: true, notes };
}
function installHooks(io, dryRun = false) {
  const resolved = {
    home: io?.home ?? homedir3(),
    binaryExists: io?.binaryExists
  };
  return detectAgents(resolved).map(
    (a) => installHooksForAgent(a, resolved, dryRun)
  );
}
var AGENTS, NEEDLES;
var init_agents = __esm({
  "src/agents.ts"() {
    "use strict";
    AGENTS = {
      claude: {
        markerDir: ".claude",
        binary: null,
        // the dir is created by the CLI itself; presence suffices
        markerFile: null,
        configFile: join5(".claude", "settings.json"),
        configStyle: "claude-nested",
        events: {
          SessionStart: "session-start",
          SessionEnd: "enqueue",
          PreCompact: "enqueue"
        }
      },
      codex: {
        markerDir: ".codex",
        binary: "codex",
        markerFile: join5(".codex", "config.toml"),
        configFile: join5(".codex", "hooks.json"),
        configStyle: "claude-nested",
        events: {
          SessionStart: "session-start",
          // Stop fires per assistant turn, not process exit — enqueue is
          // idempotent (content-hashed queue entries; drain dedupes), so
          // turn-level firing is safe.
          Stop: "enqueue",
          PreCompact: "enqueue"
        }
      },
      cursor: {
        markerDir: ".cursor",
        binary: null,
        markerFile: null,
        configFile: join5(".cursor", "hooks.json"),
        configStyle: "cursor-flat",
        events: {
          sessionStart: "session-start",
          stop: "enqueue"
        }
      },
      "copilot-cli": {
        markerDir: ".copilot",
        binary: null,
        markerFile: null,
        configFile: join5(".copilot", "hooks", "mnemosyne.json"),
        configStyle: "own-file",
        // copilot exposes no transcript surface — drain + recall only.
        events: {
          sessionStart: "session-start"
        }
      },
      gemini: {
        markerDir: ".gemini",
        binary: "gemini",
        markerFile: join5(".gemini", "settings.json"),
        configFile: join5(".gemini", "settings.json"),
        configStyle: "claude-nested",
        events: {
          SessionStart: "session-start",
          // Gemini has no session-end/stop event; PreCompress is the nearest
          // "about to lose context" signal.
          PreCompress: "enqueue"
        }
      }
    };
    NEEDLES = [
      "mnemosyne hook",
      "mnemosyne-drain.sh",
      "mnemosyne-enqueue.sh"
    ];
  }
});

// src/cli.ts
init_config();
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync as existsSync3,
  mkdirSync as mkdirSync4,
  readdirSync as readdirSync3,
  readFileSync as readFileSync4,
  renameSync,
  rmSync as rmSync2,
  statSync as statSync2,
  writeFileSync as writeFileSync5
} from "node:fs";
import { join as join6 } from "node:path";

// src/dispatch.ts
import { writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";

// src/ledger.ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";
function hashLearning(l) {
  const norm = l.text.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(`${l.kind}
${norm}`).digest("hex").slice(0, 32);
}
var Ledger = class {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }
  dir;
  has(hash) {
    return existsSync(join2(this.dir, hash));
  }
  add(hash) {
    writeFileSync(join2(this.dir, hash), "");
  }
};

// src/dispatch.ts
function defaultSlug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "note";
}
function inboxDoc(l) {
  const title = l.title ?? l.text.slice(0, 60);
  const why = `routed as ${l.kind} (confidence ${l.confidence})`;
  return [
    "---",
    "type: source",
    `title: ${JSON.stringify(title)}`,
    "status: new",
    `captured: ${l.provenance.ts.slice(0, 10)}`,
    "provenance:",
    `  session: ${JSON.stringify(l.provenance.session)}`,
    `  cwd: ${JSON.stringify(l.provenance.cwd)}`,
    `  why: ${JSON.stringify(why)}`,
    "---",
    "",
    l.text,
    ""
  ].join("\n");
}
function writeBrainDoc(l, brainInboxDir2, slugify = defaultSlug) {
  const slug = slugify(l.title ?? l.text);
  const hash = hashLearning(l).slice(0, 8);
  const filename = `${slug}-${hash}.md`;
  writeFileSync2(join3(brainInboxDir2, filename), inboxDoc(l));
  return filename;
}

// src/cli.ts
init_errors();

// src/transcript.ts
init_errors();
import { readFileSync } from "node:fs";
function partsToText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p.type === "text" || typeof p.text === "string").map((p) => p.text ?? "").join(" ").trim();
}
function parseTranscript(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new PermanentDrainError(`transcript not found: ${path}`);
    }
    throw err;
  }
  const lines = raw.split("\n").filter(Boolean);
  const turns = [];
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== "user" && rec.type !== "assistant") continue;
    const role = rec.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = partsToText(rec.message?.content);
    if (text) turns.push({ role, text });
  }
  return turns;
}

// src/cli.ts
async function drainOnce(entryPath, deps) {
  const entry = JSON.parse(readFileSync4(entryPath, "utf8"));
  const turns = parseTranscript(entry.transcript);
  if (turns.length === 0) return { written: [], skipped: 0 };
  const resp = await deps.captureSession({
    turns,
    session: entry.session,
    cwd: entry.cwd,
    ts: entry.ts,
    source: "mnemosyne"
  });
  if (resp.learnings.some((l) => l.reason === "capture_failed")) {
    throw new Error("moneta capture incomplete \u2014 retrying");
  }
  mkdirSync4(deps.brainInboxDir, { recursive: true });
  const ledger = new Ledger(deps.ledgerDir);
  const written = [];
  let skipped = 0;
  for (const l of resp.learnings) {
    if (l.kind !== "decision" && l.kind !== "lesson") continue;
    if (l.reason === "below_min_confidence" || l.reason === "secret_detected")
      continue;
    const learning = {
      text: l.text,
      kind: l.kind,
      confidence: l.confidence,
      provenance: { session: entry.session, cwd: entry.cwd, ts: entry.ts },
      ...l.title ? { title: l.title } : {}
    };
    const h = hashLearning(learning);
    if (ledger.has(h)) {
      skipped++;
      continue;
    }
    writeBrainDoc(learning, deps.brainInboxDir);
    ledger.add(h);
    written.push("brain");
  }
  return { written, skipped };
}
function moveToDead(p, deadDir, f) {
  mkdirSync4(deadDir, { recursive: true });
  try {
    renameSync(p, join6(deadDir, f));
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}
function isEntryClaimedByConcurrentDrain(err, entryPath) {
  const e = err;
  return e?.code === "ENOENT" && e.path === entryPath;
}
var DEFAULT_DRAIN_CONCURRENCY = 8;
function resolveDrainConcurrency() {
  const n = Number(process.env.MNEMOSYNE_DRAIN_CONCURRENCY) || DEFAULT_DRAIN_CONCURRENCY;
  return Math.max(1, Math.floor(n));
}
async function drainQueue(queueDir, deadDir, deps, concurrency = resolveDrainConcurrency()) {
  const summary = { drained: 0, dead: 0, retried: 0 };
  if (!existsSync3(queueDir)) return summary;
  const log = deps.log ?? ((m) => process.stderr.write(m));
  const files = readdirSync3(queueDir).filter((n) => n.endsWith(".json"));
  const safeConcurrency = Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_DRAIN_CONCURRENCY;
  const drainEntry = async (f) => {
    const p = join6(queueDir, f);
    try {
      await drainOnce(p, deps);
      rmSync2(p, { force: true });
      summary.drained++;
    } catch (err) {
      if (isEntryClaimedByConcurrentDrain(err, p)) {
        log(`drain: ${f} already handled by a concurrent drain \u2014 skipping
`);
        return;
      }
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof PermanentDrainError) {
        if (!moveToDead(p, deadDir, f)) {
          log(`drain: ${f} already handled by a concurrent drain \u2014 skipping
`);
          return;
        }
        summary.dead++;
        log(`drain: ${f} failed: ${reason} (discarded to dead/)
`);
      } else {
        summary.retried++;
        log(`drain: ${f} failed: ${reason} (left for retry)
`);
      }
    }
  };
  let cursor = 0;
  const worker = async () => {
    while (cursor < files.length) {
      const f = files[cursor++];
      if (f === void 0) continue;
      await drainEntry(f);
    }
  };
  const workerCount = Math.min(safeConcurrency, files.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return summary;
}
var STALE_LOCK_MS = 10 * 60 * 1e3;
function acquireDrainLock(home) {
  const lockDir = join6(home, "drain.lock");
  const take = () => {
    try {
      mkdirSync4(lockDir);
      writeFileSync5(join6(lockDir, "pid"), String(process.pid));
      return true;
    } catch (err) {
      if (err?.code === "EEXIST") return false;
      throw err;
    }
  };
  if (take()) return true;
  let ageMs;
  try {
    ageMs = Date.now() - statSync2(lockDir).mtimeMs;
  } catch (err) {
    if (err?.code === "ENOENT") return take();
    throw err;
  }
  if (ageMs < STALE_LOCK_MS) return false;
  rmSync2(lockDir, { recursive: true, force: true });
  return take();
}
function releaseDrainLock(home) {
  rmSync2(join6(home, "drain.lock"), { recursive: true, force: true });
}
var DEAD_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
function pruneDead(deadDir, ttlMs = DEAD_TTL_MS, now = Date.now()) {
  let files;
  try {
    files = readdirSync3(deadDir);
  } catch {
    return 0;
  }
  let pruned = 0;
  for (const f of files) {
    const p = join6(deadDir, f);
    try {
      if (now - statSync2(p).mtimeMs > ttlMs) {
        rmSync2(p, { force: true });
        pruned++;
      }
    } catch {
    }
  }
  return pruned;
}
function countEntries(dir) {
  try {
    return readdirSync3(dir).filter((n) => n.endsWith(".json")).length;
  } catch {
    return 0;
  }
}
function oldestAgeMs(dir, now = Date.now()) {
  let files;
  try {
    files = readdirSync3(dir);
  } catch {
    return null;
  }
  let oldest = null;
  for (const f of files) {
    try {
      const m = statSync2(join6(dir, f)).mtimeMs;
      if (oldest === null || m < oldest) oldest = m;
    } catch {
    }
  }
  return oldest === null ? null : now - oldest;
}
async function main() {
  const home = mnemosyneHome();
  if (!existsSync3(home)) return;
  const queueDir = join6(home, "queue");
  const deadDir = join6(home, "dead");
  if (!acquireDrainLock(home)) {
    process.stderr.write("drain: another drain is active \u2014 exiting\n");
    return;
  }
  try {
    const { replayOutbox: replayOutbox2, replayLegacyOutbox: replayLegacyOutbox2, captureSession: captureSession2 } = await Promise.resolve().then(() => (init_monetaWriter(), monetaWriter_exports));
    const { brainInboxDir: defaultInbox } = await Promise.resolve().then(() => (init_config(), config_exports));
    const outbox = await replayOutbox2();
    const legacy = await replayLegacyOutbox2();
    const deadPruned = pruneDead(deadDir);
    const logToFile = (msg) => {
      try {
        appendFileSync(join6(home, "drain.log"), msg);
      } catch {
      }
    };
    const queue = await drainQueue(queueDir, deadDir, {
      captureSession: captureSession2,
      brainInboxDir: defaultInbox(),
      ledgerDir: join6(home, "processed"),
      log: logToFile
    });
    const summary = `drain: moneta-outbox replayed=${outbox.replayed} kept=${outbox.kept}; legacy-outbox replayed=${legacy.replayed} kept=${legacy.kept} skipped=${legacy.skipped}; dead pruned=${deadPruned}; queue drained=${queue.drained} dead=${queue.dead} retried=${queue.retried}
`;
    logToFile(summary);
    process.stdout.write(summary);
  } finally {
    releaseDrainLock(home);
  }
}
var RECALL_TOP_K = 5;
function recallBlock(project, results) {
  const shown = Math.min(RECALL_TOP_K, results.length);
  const lines = [
    `Recalled ${results.length} memories for ${project} \u2014 top ${shown}:`
  ];
  for (const [i, r] of results.slice(0, RECALL_TOP_K).entries()) {
    const one = r.content.split(/\s+/).join(" ").trim();
    if (one)
      lines.push(
        `${i + 1}. ${one.length > 200 ? `${one.slice(0, 199).trimEnd()}\u2026` : one}`
      );
  }
  return lines.length > 1 ? lines.join("\n") : "";
}
async function handleHook(agent, event, stdin, deps) {
  const { normalizePayload: normalizePayload2, renderInjection: renderInjection2 } = await Promise.resolve().then(() => (init_agents(), agents_exports));
  const io = { home: deps.home };
  const p = normalizePayload2(agent, stdin, io);
  if (event === "enqueue") {
    if (p.transcript) {
      const queueDir = join6(mnemosyneHome(), "queue");
      mkdirSync4(queueDir, { recursive: true });
      const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
      writeFileSync5(
        join6(queueDir, `${stamp}-${p.session}.json`),
        JSON.stringify({
          transcript: p.transcript,
          session: p.session,
          cwd: p.cwd,
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          agent
        })
      );
    }
    return agent === "cursor" ? "{}" : "";
  }
  try {
    deps.kickDrain();
  } catch {
  }
  const project = p.cwd.replace(/\/+$/, "").split("/").pop() || p.cwd;
  let block = "";
  try {
    const results = await deps.recall(project);
    if (results?.length) block = recallBlock(project, results);
  } catch {
  }
  if (!block) return agent === "cursor" ? renderInjection2("cursor", "") : "";
  return renderInjection2(agent, block);
}
async function readStdin() {
  const chunks = [];
  try {
    for await (const c of process.stdin) chunks.push(c);
  } catch {
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function hookMain() {
  const agentArg = process.argv[3] ?? "";
  const event = process.argv[4] ?? "";
  const { AGENTS: AGENTS2 } = await Promise.resolve().then(() => (init_agents(), agents_exports));
  if (!(agentArg in AGENTS2)) return;
  const { homedir: homedir4 } = await import("node:os");
  const { recallMoneta: recallMoneta2 } = await Promise.resolve().then(() => (init_monetaWriter(), monetaWriter_exports));
  const out = await handleHook(
    agentArg,
    event,
    await readStdin(),
    {
      home: homedir4(),
      kickDrain: () => {
        const self = process.argv[1] ?? "mnemosyne";
        const child = spawn(process.execPath, [self, "drain"], {
          detached: true,
          stdio: "ignore"
        });
        child.unref();
      },
      recall: (q) => recallMoneta2(q, RECALL_TOP_K)
    }
  );
  if (out) process.stdout.write(`${out}
`);
}
async function installMain() {
  const { installHooks: installHooks2, detectAgents: detectAgents2 } = await Promise.resolve().then(() => (init_agents(), agents_exports));
  const { homedir: homedir4 } = await import("node:os");
  const dryRun = process.argv.includes("--dry-run");
  const detected = detectAgents2({ home: homedir4() });
  if (!detected.length) {
    process.stdout.write("install-hooks: no supported agents detected\n");
    return;
  }
  for (const r of installHooks2({ home: homedir4() }, dryRun)) {
    const state = r.changed ? dryRun ? "would install" : "installed" : "already wired";
    process.stdout.write(
      `${r.agent}: ${state}${r.notes.length ? ` (${r.notes.join("; ")})` : ""}
`
    );
  }
}
async function agentsMain() {
  const { AGENTS: AGENTS2, detectAgents: detectAgents2 } = await Promise.resolve().then(() => (init_agents(), agents_exports));
  const { homedir: homedir4 } = await import("node:os");
  const found = new Set(detectAgents2({ home: homedir4() }));
  for (const id of Object.keys(AGENTS2))
    process.stdout.write(
      `${id}: ${found.has(id) ? "detected" : "not found"}
`
    );
}
function fmtAge(ms) {
  if (ms === null) return "\u2014";
  const d = Math.floor(ms / 864e5);
  const h = Math.floor(ms % 864e5 / 36e5);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}
async function statusMain() {
  const home = mnemosyneHome();
  const { monetaCount: monetaCount2 } = await Promise.resolve().then(() => (init_monetaWriter(), monetaWriter_exports));
  const dead = countEntries(join6(home, "dead"));
  const lines = [
    `mnemosyne status (${home})`,
    `  queue (awaiting drain):          ${countEntries(join6(home, "queue"))}`,
    `  moneta-outbox (to replay):       ${countEntries(join6(home, "moneta-outbox"))}`,
    `  legacy mem0 outbox (to migrate): ${countEntries(join6(home, "outbox"))}`,
    `  dead (permanent failures):       ${dead}${dead ? ` (oldest ${fmtAge(oldestAgeMs(join6(home, "dead")))}, TTL ${DEAD_TTL_MS / 864e5}d)` : ""}`,
    `  drain lock:                      ${existsSync3(join6(home, "drain.lock")) ? "held" : "free"}`
  ];
  const total = await monetaCount2();
  lines.push(
    `  moneta total entries:            ${total === null ? "unreachable" : total}`
  );
  process.stdout.write(`${lines.join("\n")}
`);
}
var command = process.argv[2];
if (command === "drain") void main();
else if (command === "status") void statusMain();
else if (command === "hook") void hookMain();
else if (command === "install-hooks") void installMain();
else if (command === "agents") void agentsMain();
export {
  DEAD_TTL_MS,
  acquireDrainLock,
  countEntries,
  drainOnce,
  drainQueue,
  handleHook,
  isEntryClaimedByConcurrentDrain,
  moveToDead,
  oldestAgeMs,
  pruneDead,
  releaseDrainLock,
  resolveDrainConcurrency
};
