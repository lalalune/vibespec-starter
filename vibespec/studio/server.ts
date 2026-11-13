// The spec studio: a local web page to read, edit, reorder and regroup the stories and rules of spec/*.md, publish
// them with a manifest of what changed, and run the check, an agent's sync, and the user's sign-off.
// README, "The studio".
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { badSpecName, newSpec, parseSpec, pending, readSpecs, type Result } from "../spec.ts";
import { manifestOf, nodesOf, parseDoc, promptFor, type Ids, type Manifest } from "./doc.ts";

/** The `spec` command beside this file, as source or as built. */
const SPEC = path.join(import.meta.dirname, "..", `spec${path.extname(import.meta.filename)}`);
const PUBLIC = path.join(import.meta.dirname, "public");
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

/** One thing running in a project: a check, an agent or a sign-off. Only one at a time, since all of them take the spec lock or write specs. */
interface Job { kind: "check" | "agent" | "accept"; label: string; status: "running" | "passed" | "failed" | "stopped"; started: number; finished?: number; log: string[]; child?: ChildProcess }
interface State { baseline: Record<string, string>; ids: Ids }
interface Live {
  project: Project;
  /** The last job of each kind, so that an agent's report stays in view while the check after it runs. */
  jobs: Partial<Record<Job["kind"], Job>>;
  check?: { ok: boolean; results: Result[]; next: string; finished: number };
  clients: Set<http.ServerResponse>;
  watcher?: fs.FSWatcher;
  jobTimer?: NodeJS.Timeout;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const studioDir = (root: string) => path.join(root, ".studio");
const readJson = <T>(file: string): T | undefined => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined);
const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};
const stateFile = (root: string) => path.join(studioDir(root), "state.json");
const manifestFile = (root: string) => path.join(studioDir(root), "manifest.json");

/** Every spec/*.md, by its path from the project root. */
function specTexts(root: string): Record<string, string> {
  const dir = path.join(root, "spec");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
  return Object.fromEntries(files.map((f) => [`spec/${f}`, fs.readFileSync(path.join(dir, f), "utf8")]));
}

/** The examples that come with the tools, beside them (vibespec/examples/); the built package has none. */
const EXAMPLES = path.join(import.meta.dirname, "..", "examples");

/** The project at `repo`, then each example that has specs. */
export function projectsOf(repo: string): Project[] {
  const found = fs.existsSync(EXAMPLES) ? fs.readdirSync(EXAMPLES).sort().filter((d) => fs.existsSync(path.join(EXAMPLES, d, "spec"))) : [];
  const name = (dir: string) => readJson<{ name?: string }>(path.join(dir, "package.json"))?.name ?? path.basename(dir);
  const examples = found.map((d) => path.join(EXAMPLES, d)).filter((root) => root !== path.resolve(repo));
  return [{ id: ".", name: name(repo), root: repo }, ...examples.map((root) => ({ id: `examples/${path.basename(root)}`, name: path.basename(root), root }))];
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

/** Everything the page shows for a project. */
function snapshot(live: Live, agents: Record<string, Agent>) {
  const { root } = live.project;
  const texts = specTexts(root);
  // What the review ledger says of each story and rule; nothing if the specs do not parse.
  let review: Record<string, Record<string, string>> = {};
  let problem: string | undefined;
  try {
    const specs = readSpecs(root);
    review = Object.fromEntries(specs.map((s) => [s.file, Object.fromEntries(pending(root, s, specs).map((p) => [
      p.story ? `## ${p.story.title}` : p.rule?.key ?? p.where.split("  ")[1], p.status + (p.note ?? "")]))]));
  } catch (e) {
    problem = (e as Error).message;
  }
  const manifest = readJson<Manifest>(manifestFile(root));
  const context = { skill: skillPath(root), check: checkCommand(root) };
  const prompt = promptFor(manifest, context);
  const short = promptFor(manifest, context, DEEPLINK_LIMIT);
  return {
    project: live.project,
    specs: Object.entries(texts).map(([file, text]) => ({ file, name: path.basename(file, ".md"), hash: hash(text), text, doc: parseDoc(text), review: review[file] ?? {} })),
    problem,
    manifest,
    prompt,
    check: live.check,
    jobs: jobsView(live),
    agents: Object.entries(agents).map(([id, a]) => ({ id, label: a.label, available: onPath(a.command({ root, check: context.check })[0]), link: a.link?.({ root, prompt: short }) })),
  };
}
const jobsView = (live: Live) => Object.fromEntries(Object.values(live.jobs).map((j) => [j.kind, { label: j.label, status: j.status, started: j.started, finished: j.finished, log: j.log.slice(-400) }]));
const running = (live: Live) => Object.values(live.jobs).find((j) => j.status === "running");

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

/** The studio's HTTP server. `open` is the project shown first. */
export async function startStudio({ projects, open = projects[0].id, port = 4321, agents = AGENTS }: { projects: Project[]; open?: string; port?: number; agents?: Record<string, Agent> }) {
  const lives = new Map<string, Live>(projects.map((p) => [p.id, { project: p, jobs: {}, clients: new Set() }]));

  const broadcast = (live: Live, event: string, data: unknown) => {
    for (const res of live.clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  /** Changes to the specs reach every page, whoever made them: the studio, an agent or an editor. */
  const watch = (live: Live) => {
    if (live.watcher || !fs.existsSync(path.join(live.project.root, "spec"))) return;
    let timer: NodeJS.Timeout | undefined;
    live.watcher = fs.watch(path.join(live.project.root, "spec"), () => {
      clearTimeout(timer);
      timer = setTimeout(() => broadcast(live, "files", {}), 150);
    });
  };
  const jobChanged = (live: Live) => {
    clearTimeout(live.jobTimer);
    live.jobTimer = setTimeout(() => broadcast(live, "job", { jobs: jobsView(live), check: live.check }), 100);
  };

  /** Start a program in the project as its one job; `done` hears how it ended. */
  const startJob = (live: Live, kind: Job["kind"], label: string, [program, args]: [string, string[]], input: string | undefined, read: (line: string) => string | undefined, done: (job: Job, out: string) => void) => {
    const busy = running(live);
    if (busy) throw new Error(`${busy.label} is still running`);
    const job: Job = { kind, label, status: "running", started: Date.now(), log: [] };
    live.jobs[kind] = job;
    let out = "";
    const child = spawn(program, args, { cwd: live.project.root, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    job.child = child;
    if (input !== undefined) child.stdin!.end(input);
    const lines = (stream: NodeJS.ReadableStream, keep: boolean) => {
      let rest = "";
      stream.on("data", (chunk: Buffer) => {
        const text = rest + chunk.toString();
        if (keep) out += chunk.toString();
        const parts = text.split("\n");
        rest = parts.pop()!;
        for (const l of parts) { const r = read(l); if (r !== undefined && r.trim()) job.log.push(r); }
        jobChanged(live);
      });
      stream.on("end", () => { if (rest.trim()) { const r = read(rest); if (r) job.log.push(r); } });
    };
    lines(child.stdout!, true);
    lines(child.stderr!, false);
    child.on("error", (e) => { job.log.push(`✗ ${e.message}`); });
    child.on("close", (code) => {
      job.finished = Date.now();
      if (job.status === "running") job.status = code === 0 ? "passed" : "failed";
      job.child = undefined;
      try { done(job, out); } catch (e) { job.log.push(`✗ ${(e as Error).message}`); }
      jobChanged(live);
    });
    jobChanged(live);
  };

  const runCheck = (live: Live) => startJob(live, "check", "check", [process.execPath, [SPEC, "check", "--json"]], undefined, () => undefined, (job, out) => {
    try {
      const r = JSON.parse(out) as { ok: boolean; results: Result[]; next: string };
      live.check = { ...r, finished: Date.now() };
      job.status = r.ok ? "passed" : "failed";
      job.log.push(r.next);
    } catch {
      job.status = job.status === "stopped" ? "stopped" : "failed";
      job.log.push(out.trim() || "the check did not finish");
    }
  });

  /** The agent synced what was published: the specs as they are now are the new baseline. */
  const markSynced = (root: string) => {
    fs.rmSync(stateFile(root), { force: true });
    fs.rmSync(manifestFile(root), { force: true });
  };

  const publish = (live: Live, body: { files: { file: string; base: string | null; text: string | null }[]; origins: [string, string | null][]; force?: boolean }) => {
    const { root } = live.project;
    const disk = specTexts(root);
    const conflicts = body.force ? [] : body.files.filter((f) => (f.file in disk ? hash(disk[f.file]) : null) !== f.base).map((f) => f.file);
    if (conflicts.length) return { status: 409, body: { error: "changed on disk since you loaded it", conflicts } };
    const next = { ...disk };
    for (const f of body.files) {
      if (!/^spec\/[^/]+\.md$/.test(f.file)) return { status: 400, body: { error: `${f.file} is not a spec` } };
      const bad = badSpecName(path.basename(f.file, ".md"));
      if (bad) return { status: 400, body: { error: bad } };
      if (f.text === null) delete next[f.file];
      else {
        try { parseSpec(root, f.file, f.text); } catch (e) { return { status: 400, body: { error: (e as Error).message } }; }
        next[f.file] = f.text;
      }
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
      if (f.text === null) for (const ext of [".md", ".lock.json", ".proof.dfy"]) fs.rmSync(target.replace(/\.md$/, ext), { force: true });
      else if (disk[f.file] !== f.text) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, f.text); }
    }
    const manifest = manifestOf(root, state.baseline, next, ids);
    if (!manifest.changes.length) markSynced(root);
    else {
      writeJson(stateFile(root), { baseline: state.baseline, ids });
      writeJson(manifestFile(root), manifest);
    }
    if (!running(live)) runCheck(live);
    return { status: 200, body: { manifest: manifest.changes.length ? manifest : undefined } };
  };

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Only this machine's pages: another site cannot reach it by a rebound name, nor post to it without a preflight it would fail.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? "")) return send(res, 403, { error: "forbidden" });
    if (req.method === "POST" && !req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "send JSON" });
    try {
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
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      switch (url.pathname) {
        case "/api/publish": {
          const r = publish(live, body);
          return send(res, r.status, r.body);
        }
        case "/api/spec":
          return send(res, 200, { file: newSpec(root, String(body.name ?? "")) });
        case "/api/check":
          runCheck(live);
          return send(res, 200, {});
        case "/api/agent": {
          const agent = agents[body.agent];
          if (!agent) return send(res, 400, { error: `no agent ${body.agent}` });
          const check = checkCommand(root);
          startJob(live, "agent", agent.label, agent.command({ root, check }), promptFor(readJson<Manifest>(manifestFile(root)), { skill: skillPath(root), check }), readable, (job) => {
            // What the agent did is the new baseline; the check then shows what is left.
            if (job.status !== "passed") return;
            markSynced(root);
            setImmediate(() => { try { runCheck(live); } catch { /* another job started */ } });
          });
          return send(res, 200, {});
        }
        case "/api/accept":
          startJob(live, "accept", "sign-off", [process.execPath, [SPEC, "accept"]], undefined, (l) => l, () => setImmediate(() => { try { runCheck(live); } catch { /* another job started */ } }));
          return send(res, 200, {});
        case "/api/stop":
          const job = running(live);
          if (job?.child) { job.status = "stopped"; job.child.kill("SIGTERM"); }
          return send(res, 200, {});
        case "/api/synced":
          markSynced(root);
          broadcast(live, "files", {});
          return send(res, 200, {});
        default:
          return send(res, 404, { error: "not found" });
      }
    } catch (e) {
      if (!res.headersSent) send(res, 400, { error: (e as Error).message });
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
        for (const job of Object.values(live.jobs)) job.child?.kill("SIGTERM");
        for (const c of live.clients) c.end();
      }
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}


/** `spec studio [<example>] [--port <n>]`: serve the projects under `repo`, show the example if one is named, and open the page. */
export async function serve(repo: string, args: string[]) {
  const projects = projectsOf(repo);
  const example = args[0] === "--port" ? undefined : args[0];
  const at = args.indexOf("--port");
  const port = at < 0 ? undefined : Number(args[at + 1]);
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536)) throw new Error(`--port ${args[at + 1]}: not a port`);
  const open = example === undefined ? "." : projects.find((p, i) => i > 0 && p.name === example)?.id;
  if (!open) throw new Error(`no example ${example}; there are: ${projects.slice(1).map((p) => p.name).join(", ") || "none"}`);
  const studio = await startStudio({ projects, open, port });
  const url = `${studio.url}/?project=${encodeURIComponent(open)}`;
  console.log(`studio: ${url}`);
  if (process.stdout.isTTY) spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
