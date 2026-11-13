// The studio's server: the shell around spec/index.md. Every change to the session goes through the generated
// `enabled` and `step`; this file only runs the jobs the session allows, reads and writes the specs, keeps the
// manifest (./doc.ts), and serves the page (./page.ts) with the modules it imports.
// README, "Studio".
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import ts from "typescript";
import { parseSpec, pending, readSpecs, type Result } from "../../spec.ts";
import { specFiles, specName } from "../../parse.ts";
import { projectRoot } from "../../util.ts";
import { enabled, initial, step, type Event, type Session, type Verdict } from "../gen/index.ts";
import { manifestOf, nodesOf, promptFor, type Ids, type Manifest } from "./doc.ts";
import { outlineOf } from "./markdown.ts";

const EXT = path.extname(import.meta.filename);
/** The tools: vibespec/ from source, dist/ when built. */
const TOOLS = path.join(import.meta.dirname, "..", "..");
/** The `spec` command, as source or as built. */
const SPEC = path.join(TOOLS, `spec${EXT}`);
const PUBLIC = path.join(import.meta.dirname, "public");
/** The modules the page may load from the tools, by their path below them: the page, what it imports, and nothing else. */
const MODULES = /^(scan|studio\/src\/(page|markdown)|studio\/gen\/(index|outline))$/;
const DEEPLINK_LIMIT = 5000; // characters of a prompt a claude-cli:// link carries

export interface Project { id: string; name: string; root: string }

/** An agent the studio can start on the sync prompt, and the link that opens its app on the same prompt. */
export interface Agent {
  label: string;
  /** The program, and its arguments for a project; the prompt arrives on standard input. */
  command: (p: { root: string; check: string }) => [string, string[]];
  link?: (p: { root: string; prompt: string }) => string;
}
export const AGENTS: Record<string, Agent> = {
  claude: {
    label: "Claude Code",
    command: ({ check }) => ["claude", ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
      "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep", `Bash(${check}:*)`, "Bash(npm run -s check:*)", "Bash(npx quint:*)",
      "--disallowedTools", "Bash(npm run accept:*)", "Bash(spec accept:*)"]],
    link: ({ root, prompt }) => `claude-cli://open?cwd=${encodeURIComponent(root)}&q=${encodeURIComponent(prompt)}`,
  },
  codex: {
    label: "Codex",
    command: ({ root }) => ["codex", ["exec", "--json", "-s", "workspace-write", "-C", root, "-"]],
    link: ({ root, prompt }) => `codex://new?path=${encodeURIComponent(root)}&prompt=${encodeURIComponent(prompt)}`,
  },
};

/** The process behind the session's job, and what it printed. The last of each kind is kept, for its log. */
interface Job { kind: "check" | "agent" | "accept"; label: string; status: "running" | "passed" | "failed" | "stopped"; started: number; finished?: number; log: string[]; child?: ChildProcess }
interface State { baseline: Record<string, string>; ids: Ids }
interface Live {
  project: Project;
  /** spec/index.md; `unpublished` is the page's to know, and is always false here. */
  session: Session;
  jobs: Partial<Record<Job["kind"], Job>>;
  check?: { ok: boolean; results: Result[]; next: string; finished: number };
  clients: Set<http.ServerResponse>;
  watcher?: fs.FSWatcher;
  timer?: NodeJS.Timeout;
}

/** A request the session does not allow now. */
class Refused extends Error {}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const readJson = <T>(file: string): T | undefined => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined);
const projectName = (root: string) => readJson<{ name?: string }>(path.join(root, "package.json"))?.name ?? path.basename(root);
const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};
const stateFile = (root: string) => path.join(root, ".studio", "state.json");
const manifestFile = (root: string) => path.join(root, ".studio", "manifest.json");

/** Every Markdown spec in the tree, by its path from the project root. */
function specTexts(root: string): Record<string, string> {
  return Object.fromEntries(specFiles(root).map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
}

/** The projects under `repo`: the repository itself, and each package in vibespec/examples/ that has specs. */
export function projectsOf(repo: string): Project[] {
  const examples = path.join(repo, "vibespec", "examples");
  const found = fs.existsSync(examples) ? fs.readdirSync(examples).sort().filter((d) => fs.existsSync(path.join(examples, d, "spec"))) : [];
  return [{ id: ".", name: projectName(repo), root: repo }, ...found.map((d) => ({ id: `vibespec/examples/${d}`, name: d, root: path.join(examples, d) }))];
}

/** The command a person or agent runs in a project to check it: its own script if it can, else the tools of this repository. */
function checkCommand(root: string): string {
  const scripts = readJson<{ scripts?: Record<string, string> }>(path.join(root, "package.json"))?.scripts ?? {};
  const installed = fs.existsSync(path.join(root, "node_modules/.bin/spec")) || !scripts.check?.startsWith("spec ");
  return scripts.check && installed ? "npm run check" : `node ${path.relative(root, SPEC)} check`;
}

/** The sync skill, as a path from the project root: its own copy, or the nearest one above it. */
function skillPath(root: string): string {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const file = path.join(dir, ".claude/skills/sync/SKILL.md");
    if (fs.existsSync(file)) return path.relative(root, file);
    if (dir === path.dirname(dir)) return ".claude/skills/sync/SKILL.md";
  }
}

const installed = new Map<string, boolean>();
const onPath = (program: string) => {
  if (!installed.has(program)) installed.set(program, spawnSync(process.platform === "win32" ? "where" : "which", [program]).status === 0);
  return installed.get(program)!;
};

/**
 * What a check found, as spec/index.md's verdict. `Reviewable` is what `accept` can record: every stage but review
 * passed, every story has rules and every rule has Quint.
 */
export function verdictOf(results: Result[]): Verdict {
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) return "Green";
  const reviewOnly = failed.every((r) => r.stage === "review") && !failed.some((r) => /story has no rules|not formalized/.test(r.detail));
  return reviewOnly ? "Reviewable" : "Failing";
}

/** Everything the page shows for a project. */
function snapshot(live: Live, agents: Record<string, Agent>) {
  const { root } = live.project;
  // The specs, and what the review ledger says of each story and rule; what is wrong if they cannot be read.
  let texts: Record<string, string> = {};
  let review: Record<string, Record<string, string>> = {};
  let problem: string | undefined;
  try {
    texts = specTexts(root);
    const specs = readSpecs(root);
    review = Object.fromEntries(specs.map((s) => [s.file, Object.fromEntries(pending(root, s, specs).map((p) => [
      p.story ? `## ${p.story.title}` : p.rule?.key ?? p.where.split("  ")[1], p.status + (p.note ?? "")]))]));
  } catch (e) {
    problem = (e as Error).message;
  }
  const manifest = readJson<Manifest>(manifestFile(root));
  const context = { skill: skillPath(root), check: checkCommand(root) };
  const order = (file: string) => file.replace(/(?:^spec\/|\/)index\.md$/, "/");
  return {
    project: live.project,
    session: live.session,
    specs: Object.entries(texts).sort(([a], [b]) => order(a).localeCompare(order(b)))
      .map(([file, text]) => ({ file, module: specName(file), hash: hash(text), text, outline: outlineOf(file, text), review: review[file] ?? {} })),
    problem,
    manifest,
    prompt: promptFor(manifest, context),
    check: live.check,
    jobs: jobsView(live),
    agents: Object.entries(agents).map(([id, a]) => ({ id, label: a.label, available: onPath(a.command({ root, check: context.check })[0]), link: a.link?.({ root, prompt: promptFor(manifest, context, DEEPLINK_LIMIT) }) })),
  };
}
const jobsView = (live: Live) => Object.fromEntries(Object.values(live.jobs).map((j) => [j.kind, { label: j.label, status: j.status, started: j.started, finished: j.finished, log: j.log.slice(-400) }]));

/** A line of an agent's JSON output, as a person would want to read it; undefined for bookkeeping. */
function readable(line: string): string | undefined {
  let e: any;
  try { e = JSON.parse(line); } catch { return line; }
  const clip = (s: string, n = 600) => (s.length > n ? s.slice(0, n) + " …" : s);
  // Claude Code's stream-json
  if (e.type === "assistant") return (e.message?.content ?? []).map((c: any) =>
    c.type === "text" ? clip(c.text) : c.type === "tool_use" ? `▸ ${c.name} ${clip(String(c.input?.command ?? c.input?.file_path ?? c.input?.pattern ?? ""), 200)}` : "").filter(Boolean).join("\n") || undefined;
  // The final message was already shown; the result says only how the run ended, and what it cost.
  if (e.type === "result") return `${e.is_error ? "✗ failed" : "✓ done"}${e.total_cost_usd ? ` · $${Number(e.total_cost_usd).toFixed(2)}` : ""}`;
  // Codex's --json events
  const item = e.item ?? e.msg;
  if (e.type === "item.completed" && item?.type === "agent_message") return clip(item.text ?? "");
  if (e.type === "item.started" && item?.type === "command_execution") return `▸ ${clip(item.command ?? "", 200)}`;
  if (e.type === "item.completed" && item?.type === "file_change") return `▸ edit ${(item.changes ?? []).map((c: any) => c.path).join(", ")}`;
  if (e.type === "item.completed" && item?.type === "error") return `! ${clip(item.message ?? "")}`;
  if (e.type === "turn.failed" || e.type === "error") return `✗ ${clip(e.error?.message ?? e.message ?? line)}`;
}

/** A module the page imports, as JavaScript: transpiled from source, or as built. */
function pageModule(file: string): string {
  const code = fs.readFileSync(file, "utf8");
  if (!file.endsWith(".ts")) return code;
  return ts.transpileModule(code, { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023, rewriteRelativeImportExtensions: true } }).outputText;
}

/** The studio's HTTP server. `open` is the project shown first. */
export async function startStudio({ projects, open = projects[0].id, port = 4321, agents = AGENTS }: { projects: Project[]; open?: string; port?: number; agents?: Record<string, Agent> }) {
  const lives = new Map<string, Live>(projects.map((p) => [p.id, { project: p, session: initial, jobs: {}, clients: new Set() }]));

  const broadcast = (live: Live, event: string, data: unknown) => {
    for (const res of live.clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const changed = (live: Live) => {
    clearTimeout(live.timer);
    live.timer = setTimeout(() => broadcast(live, "job", { session: live.session, jobs: jobsView(live), check: live.check }), 100);
  };
  /** Refuse what the session does not allow now, saying why. */
  const allow = (live: Live, event: Event, session = live.session) => {
    if (enabled(session, event)) return;
    const busy = Object.values(live.jobs).find((j) => j.child);
    throw new Refused(busy ? `${busy.label} is still running` : `${event.type} is not allowed now`);
  };
  /** The session moves only by an event it allows. */
  const act = (live: Live, event: Event, session = live.session) => {
    allow(live, event, session);
    live.session = step(session, event);
    changed(live);
  };
  /** Changes to the specs reach every page, whoever made them, and make the last verdict unknown (spec/index.md). */
  const watch = (live: Live) => {
    if (live.watcher || !fs.existsSync(path.join(live.project.root, "spec"))) return;
    let timer: NodeJS.Timeout | undefined;
    live.watcher = fs.watch(path.join(live.project.root, "spec"), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        act(live, { type: "touch" });
        broadcast(live, "files", {});
      }, 150);
    });
  };

  /** Run the program behind the job the session has just started; `done` hears how it ended. */
  const run = (live: Live, kind: Job["kind"], label: string, [program, args]: [string, string[]], input: string | undefined, read: (line: string) => string | undefined, done: (job: Job, out: string) => void) => {
    const job: Job = { kind, label, status: "running", started: Date.now(), log: [] };
    live.jobs[kind] = job;
    let out = "";
    const child = spawn(program, args, { cwd: live.project.root, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    job.child = child;
    if (input !== undefined) child.stdin!.end(input);
    const lines = (stream: NodeJS.ReadableStream, keep: boolean) => {
      let rest = "";
      stream.on("data", (chunk: Buffer) => {
        if (keep) out += chunk.toString();
        const parts = (rest + chunk.toString()).split("\n");
        rest = parts.pop()!;
        for (const l of parts) { const r = read(l); if (r?.trim()) job.log.push(r); }
        changed(live);
      });
      stream.on("end", () => { const r = rest.trim() && read(rest); if (r) job.log.push(r); });
    };
    lines(child.stdout!, true);
    lines(child.stderr!, false);
    child.on("error", (e) => job.log.push(`✗ ${e.message}`));
    child.on("close", (code) => {
      job.finished = Date.now();
      job.child = undefined;
      const stopped = job.status === "stopped";
      if (!stopped) job.status = code === 0 ? "passed" : "failed";
      // A stopped job's end was already stepped (spec/index.md, "A running job can be stopped, and then nothing is known of its result").
      if (!stopped) try { done(job, out); } catch (e) { job.log.push(`✗ ${(e as Error).message}`); }
      changed(live);
    });
    changed(live);
  };

  /** The check the session is now waiting on (`job == Checking`). */
  const runCheck = (live: Live) => run(live, "check", "check", [process.execPath, [SPEC, "check", "--json"]], undefined, () => undefined, (job, out) => {
    let verdict: Verdict = "Failing";
    try {
      const r = JSON.parse(out) as { ok: boolean; results: Result[]; next: string };
      live.check = { ...r, finished: Date.now() };
      verdict = verdictOf(r.results);
      job.log.push(r.next);
    } catch {
      job.log.push(out.trim() || "the check did not finish");
    }
    job.status = verdict === "Failing" ? "failed" : "passed";
    act(live, { type: "checked", verdict });
  });

  /** What the agent synced is the new baseline of the manifest. */
  const clearManifest = (root: string) => {
    fs.rmSync(stateFile(root), { force: true });
    fs.rmSync(manifestFile(root), { force: true });
  };

  const publish = (live: Live, body: { files: { file: string; base: string | null; text: string | null }[]; origins: [string, string | null][]; force?: boolean }) => {
    // The request carries edits, so the session as the page sees it has some (spec/index.md, "Only edits can be published, and not while a job runs").
    const session = { ...live.session, unpublished: true };
    allow(live, { type: "publish", changes: 0 }, session);
    const { root } = live.project;
    const disk = specTexts(root);
    const conflicts = body.force ? [] : body.files.filter((f) => (f.file in disk ? hash(disk[f.file]) : null) !== f.base).map((f) => f.file);
    if (conflicts.length) return { status: 409, body: { error: "changed on disk since you loaded it", conflicts } };
    const next = { ...disk };
    for (const f of body.files) {
      try {
        specName(f.file);
        let target = root;
        for (const segment of f.file.split("/")) {
          target = path.join(target, segment);
          if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${f.file}: spec paths may not be symlinks`);
        }
        if (f.text !== null) parseSpec(root, f.file, f.text);
      } catch (e) { return { status: 400, body: { error: (e as Error).message } }; }
      if (f.text === null) delete next[f.file];
      else next[f.file] = f.text;
    }
    // Every heading the page meant to write is a heading of the text: a prose line that starts with ## would not be.
    const origins = new Map(body.origins);
    for (const f of body.files) if (f.text !== null) {
      const stray = nodesOf(f.file, f.text).find((n) => !origins.has(n.id));
      if (stray) return { status: 400, body: { error: `${f.file}: "${stray.heading}" would be a heading; a line of prose may not start with ## or ###` } };
    }
    const state = readJson<State>(stateFile(root)) ?? { baseline: disk, ids: {} };
    const inBaseline = new Set(Object.entries(state.baseline).flatMap(([f, t]) => nodesOf(f, t).map((n) => n.id)));
    const baseOf = (id: string) => (id in state.ids ? state.ids[id] : inBaseline.has(id) ? id : null);
    const ids: Ids = {};
    for (const [file, text] of Object.entries(next)) for (const n of nodesOf(file, text)) {
      const origin = body.files.some((f) => f.file === file) ? origins.get(n.id) ?? null : n.id;
      ids[n.id] = origin === null ? null : baseOf(origin);
    }
    for (const f of body.files) {
      const target = path.join(root, f.file);
      if (f.text === null) for (const ext of [".md", ".proof.dfy"]) fs.rmSync(target.replace(/\.md$/, ext), { force: true });
      else if (disk[f.file] !== f.text) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, f.text); }
    }
    const manifest = manifestOf(root, state.baseline, next, ids);
    if (!manifest.changes.length) clearManifest(root);
    else {
      writeJson(stateFile(root), { baseline: state.baseline, ids });
      writeJson(manifestFile(root), manifest);
    }
    live.check = undefined;
    act(live, { type: "publish", changes: manifest.changes.length }, session);
    runCheck(live);
    return { status: 200, body: { manifest: manifest.changes.length ? manifest : undefined } };
  };

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

  const server = http.createServer(async (req, res) => {
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'");
    res.setHeader("x-content-type-options", "nosniff");
    try {
      const port = (server.address() as { port: number }).port;
      const host = req.headers.host?.toLowerCase();
      if (!host || ![`localhost:${port}`, `127.0.0.1:${port}`].includes(host)) return send(res, 403, { error: "use the local studio address" });
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) return send(res, 403, { error: "cross-origin requests are not allowed" });
      if (req.headers["sec-fetch-site"] === "cross-site") return send(res, 403, { error: "cross-site requests are not allowed" });
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (req.method === "GET" && url.pathname.startsWith("/vibespec/")) {
        const name = url.pathname.slice("/vibespec/".length).replace(/\.js$/, "");
        const file = [`${name}${EXT}`, `${name}.js`].map((f) => path.join(TOOLS, f)).find((f) => MODULES.test(name) && fs.existsSync(f));
        if (!file) return send(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        return res.end(pageModule(file));
      }
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        const file = path.join(PUBLIC, url.pathname === "/" ? "index.html" : path.normalize(url.pathname).replace(/^([/\\])+/, ""));
        if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
        return res.end(fs.readFileSync(file));
      }
      if (url.pathname === "/api/projects") return send(res, 200, { projects: projects.map(({ id, name }) => ({ id, name })), open });
      const live = lives.get(url.searchParams.get("project") ?? open);
      if (!live) return send(res, 404, { error: "no such project" });
      const { root } = live.project;
      if (url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": studio\n\n");
        live.clients.add(res);
        watch(live);
        req.on("close", () => live.clients.delete(res));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/project") return send(res, 200, snapshot(live, agents));
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
      if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") return send(res, 415, { error: "send application/json" });
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      switch (url.pathname) {
        case "/api/publish": {
          const r = publish(live, body);
          return send(res, r.status, r.body);
        }
        case "/api/check":
          act(live, { type: "check" });
          runCheck(live);
          return send(res, 200, {});
        case "/api/agent": {
          const agent = agents[body.agent];
          if (!agent) return send(res, 400, { error: `no agent ${body.agent}` });
          act(live, { type: "sync" });
          const check = checkCommand(root);
          run(live, "agent", agent.label, agent.command({ root, check }), promptFor(readJson<Manifest>(manifestFile(root)), { skill: skillPath(root), check }), readable, (job) => {
            const ok = job.status === "passed";
            if (ok) clearManifest(root);
            act(live, { type: "synced", ok });
            if (ok) runCheck(live);
          });
          return send(res, 200, {});
        }
        case "/api/accept":
          act(live, { type: "signOff" });
          run(live, "accept", "sign-off", [process.execPath, [SPEC, "accept"]], undefined, (l) => l, () => {
            act(live, { type: "signedOff" });
            runCheck(live);
          });
          return send(res, 200, {});
        case "/api/stop": {
          act(live, { type: "stop" });
          const job = Object.values(live.jobs).find((j) => j.child);
          if (job) { job.status = "stopped"; job.child!.kill("SIGTERM"); }
          return send(res, 200, {});
        }
        case "/api/synced":
          act(live, { type: "markSynced" });
          clearManifest(root);
          broadcast(live, "files", {});
          return send(res, 200, {});
        default:
          return send(res, 404, { error: "not found" });
      }
    } catch (e) {
      if (!res.headersSent) send(res, e instanceof Refused ? 409 : 400, { error: (e as Error).message });
    }
  });

  const address = await new Promise<string>((resolve, reject) => {
    const tryPort = (p: number) => {
      server.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" && port !== 0 && p < port + 20 ? tryPort(p + 1) : reject(e)));
      server.listen(p, "127.0.0.1", () => resolve(`http://localhost:${(server.address() as { port: number }).port}`));
    };
    tryPort(port);
  });
  return {
    url: address,
    close: () => new Promise<void>((resolve) => {
      for (const live of lives.values()) {
        live.watcher?.close();
        clearTimeout(live.timer);
        for (const job of Object.values(live.jobs)) job.child?.kill("SIGTERM");
        for (const c of live.clients) c.end();
      }
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

/** `spec studio [<example-or-directory>] [--port <n>]`: select a project and open its page. */
export async function serve(repo: string, args: string[]) {
  repo = projectRoot(repo);
  const projects = projectsOf(repo);
  const target = args[0] === "--port" ? undefined : args[0];
  const at = args.indexOf("--port");
  const port = at < 0 ? undefined : Number(args[at + 1]);
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536)) throw new Error(`--port ${args[at + 1]}: not a port`);
  let open = ".";
  if (target !== undefined) {
    const example = projects.find((p) => p.id === `vibespec/examples/${target}`);
    const root = projectRoot(example?.root ?? target, repo);
    let selected = projects.find((p) => fs.realpathSync(p.root) === root);
    if (!selected) {
      const name = projectName(root);
      selected = { id: root, name: projects.some((p) => p.name === name) ? `${name} (${root})` : name, root };
      projects.push(selected);
    }
    open = selected.id;
  }
  const studio = await startStudio({ projects, open, port });
  const url = `${studio.url}/?project=${encodeURIComponent(open)}`;
  console.log(`studio: ${url}`);
  if (process.stdout.isTTY) spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  return studio;
}
