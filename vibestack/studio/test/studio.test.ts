// Journeys through the studio's real server, filesystem and checks. The session's and the outline's rules are proved
// by `npm run check`; these cover what the proofs cannot see: HTTP, the files written, the jobs run, and the page's
// modules as the browser loads them.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { acceptReviews, readSpecs, type Result } from "../../spec.ts";
import { nodesOf } from "../src/doc.ts";
import { serve, startStudio, type Agent } from "../src/server.ts";

const tools = path.join(import.meta.dirname, "..", "..");
const roots: string[] = [];
after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

/** A scratch project holding the given files. */
function scratch(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-test-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

/** A stand-in for an agent's command line, at its boundary: it keeps the prompt it was given and answers as Claude Code does. */
const fakeAgent: Agent = {
  label: "Fake",
  command: () => [process.execPath, ["-e", `let p = ""; process.stdin.on("data", (d) => (p += d)).on("end", () => { require("fs").writeFileSync("prompt.txt", p); console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "synced" }] } })); });`]],
};

/** The studio on one project, and how to talk to it as its page does. */
async function studioOn(root: string) {
  const studio = await startStudio({ projects: [{ id: ".", name: "Door", root }], port: 0, agents: {
    fake: fakeAgent,
    // Agents that write what only the tools may: the review ledger, and Studio's own state.
    ledgerEdit: { label: "Ledger writer", command: () => [process.execPath, ["-e", "require('node:fs').appendFileSync('spec/lock.json', '\\n')"]] },
    invalidState: { label: "State writer", command: () => [process.execPath, ["-e", "const fs = require('node:fs'); fs.rmSync('.studio', { recursive: true }); fs.writeFileSync('.studio', 'invalid')"]] },
  } });
  const url = studio.url.replace("localhost", "127.0.0.1");
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/api/${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const project = async () => (await fetch(`${url}/api/project`)).json();
  /** The project once no job runs. */
  const settled = async () => {
    for (let p = await project(); ; p = await project()) {
      if (p.session.job === "Idle") return p;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return { studio, url, post, project, settled };
}

// spec/index.md, "Story: Edit, then publish"; spec/index.md, "Story: Sync with an agent"; spec/index.md, "Story: Check"
test("a spec is published with its origins, checked, synced by an agent, and refused while a job runs", async () => {
  const root = scratch({ "spec/door.md": fs.readFileSync(path.join(tools, "fixtures/door.md"), "utf8") });
  const { studio, url, post, project, settled } = await studioOn(root);
  try {
    // The page and the modules it imports load; nothing else under the tools does.
    for (const file of ["/", "/style.css", "/vibestack/studio/src/page.js", "/vibestack/studio/src/markdown.js", "/vibestack/studio/gen/outline.js", "/vibestack/studio/gen/index.js", "/vibestack/scan.js"]) {
      const asset = await fetch(url + file);
      assert.equal(asset.status, 200, file);
      assert.ok((await asset.text()).length > 0, file);
    }
    assert.match(await (await fetch(`${url}/vibestack/studio/src/page.js`)).text(), /from "\.\.\/gen\/outline\.js"/);
    for (const file of ["/vibestack/spec.js", "/vibestack/studio/src/server.js", "/vibestack/studio/gen/index.conformance.js"]) assert.equal((await fetch(url + file)).status, 404, file);

    // Only this machine's pages may act.
    assert.equal((await post("check", {}, { origin: "https://untrusted.example" })).status, 403);
    const hostile = await new Promise<number>((resolve, reject) => {
      http.get(`${url}/api/project`, { headers: { host: "untrusted.example" } }, (response) => { response.resume(); resolve(response.statusCode!); }).on("error", reject);
    });
    assert.equal(hostile, 403);
    assert.equal((await post("check", {}, { "content-type": "text/plain" })).status, 415);

    // spec/index.md, "A new session has nothing to do"; spec/outline.md, "A story and its rules"
    const first = await project();
    assert.deepEqual(first.session, { unpublished: false, waiting: 0, job: "Idle", verdict: "Unknown" });
    assert.deepEqual(first.specs[0].outline.stories.map((s: { title: string }) => s.title), ["Domain", "Story: Use the door"]);

    // spec/index.md, "Only edits can be published, and not while a job runs"; spec/index.md, "Publishing always starts a check"
    const door = first.specs[0];
    const text = door.text + "\nThe door remains available.\n";
    const origins = nodesOf(door.file, text).map((n) => [n.id, n.id]);
    const body = { files: [{ file: door.file, base: door.hash, text }], origins };
    const published = await post("publish", body);
    assert.equal(published.status, 200, await published.clone().text());
    assert.ok((await published.json()).manifest.changes.some((c: { kind: string; what: string[] }) => c.kind === "rule" && c.what.includes("prose")));
    assert.equal(fs.readFileSync(path.join(root, door.file), "utf8"), text);
    const checking = await project();
    assert.deepEqual([checking.session.job, checking.session.waiting], ["Checking", 1]);
    for (const route of ["publish", "agent", "accept", "check"]) assert.equal((await post(route, route === "publish" ? body : { agent: "fake" })).status, 409, route);

    // spec/index.md, "A finished check gives its verdict": the door's rules are new, so only review is left.
    const checked = await settled();
    assert.equal(checked.session.verdict, "Reviewable");
    assert.match(checked.check.next, /npm run accept/);
    // spec/index.md, "Sign-off needs a check that left only review, nothing unpublished and nothing waiting"
    assert.equal((await post("accept", {})).status, 409);

    // spec/index.md, "A sync that ends well leaves nothing waiting and checks again"
    assert.equal((await post("agent", { agent: "fake" })).status, 200);
    const synced = await settled();
    assert.deepEqual([synced.jobs.agent.status, synced.jobs.agent.log, synced.session.waiting], ["passed", ["synced"], 0]);
    assert.match(fs.readFileSync(path.join(root, "prompt.txt"), "utf8"), /~ rule spec\/door\.md: .*\(prose\)/);
    assert.ok(!fs.existsSync(path.join(root, ".studio/manifest.json")));
    assert.equal(synced.session.verdict, "Reviewable");
  } finally {
    await studio.close();
  }
});

// spec/index.md, "Story: Edit, then publish"
test("new and nested specs are published, deleted specs leave their ledger for review, and paths stay inside spec/", async () => {
  const root = scratch({ "spec/index.md": "# Home\n", "outside.md": "" });
  const { studio, post, project, settled } = await studioOn(root);
  try {
    // A new spec is a file published with no base; its parent links to it.
    const linked = await post("publish", { files: [
      { file: "spec/index.md", base: (await project()).specs[0].hash, text: "# Home\n\n[Child](./nested/child/)\n" },
      { file: "spec/nested/child/index.md", base: null, text: "# Child\n" },
    ], origins: [] });
    assert.equal(linked.status, 200, await linked.clone().text());
    assert.ok((await linked.json()).manifest.changes.some((c: { action: string; spec: string }) => c.action === "added" && c.spec === "spec/nested/child/index.md"));
    const nested = await settled();
    assert.deepEqual(nested.specs.map((s: { file: string }) => s.file), ["spec/index.md", "spec/nested/child/index.md"]);
    // spec/index.md, "What is waiting can be marked as synced by hand"
    assert.equal(nested.session.waiting, 2);
    assert.equal((await post("synced", {})).status, 200);
    assert.equal((await project()).session.waiting, 0);
    assert.equal((await post("synced", {})).status, 409);

    // Paths that would leave spec/, or follow a link out of it, are refused.
    const escaped = await post("publish", { files: [{ file: "spec/../outside.md", base: null, text: "x" }], origins: [] });
    assert.equal(escaped.status, 400);
    fs.symlinkSync(path.join(root, "outside.md"), path.join(root, "spec/escape.md"));
    assert.equal((await post("publish", { files: [{ file: "spec/escape.md", base: null, text: "x" }], origins: [], force: true })).status, 400);
    assert.equal(fs.readFileSync(path.join(root, "outside.md"), "utf8"), "");
    // The page still loads, and says what is wrong.
    assert.match((await project()).problem, /symbolic links/);
    fs.unlinkSync(path.join(root, "spec/escape.md")); // fs.rmSync leaves a dangling link in place on Node 24.5
    // A prose line that would become a heading is refused.
    const index = (await project()).specs[0];
    const stray = await post("publish", { files: [{ file: index.file, base: index.hash, text: `${index.text}\n## Not meant as a heading\n` }], origins: [] });
    assert.match((await stray.json()).error, /"Not meant as a heading" would be a heading/);

    // A deleted spec takes its proof file with it and leaves the review ledger, so its removal is reviewed.
    const child = readSpecs(root).find((s) => s.file === "spec/nested/child/index.md")!;
    acceptReviews(root, child);
    const ledger = fs.readFileSync(path.join(root, "spec/lock.json"), "utf8");
    const before = await settled();
    const deleted = await post("publish", { files: [
      { file: "spec/index.md", base: before.specs[0].hash, text: "# Home\n" },
      { file: child.file, base: before.specs[1].hash, text: null },
    ], origins: [] });
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.ok(!fs.existsSync(path.join(root, child.file)));
    assert.equal(fs.readFileSync(path.join(root, "spec/lock.json"), "utf8"), ledger);
    const final = await settled();
    assert.ok(final.check.results.some((r: Result) => r.stage === "review" && /removed spec/.test(r.summary)));
    assert.equal(final.session.waiting, 2);

    // spec/index.md, "A sync that ends well leaves nothing waiting and checks again": a sync that wrote the review
    // ledger, or broke Studio's state, does not end well, and what was waiting still waits.
    assert.equal((await post("agent", { agent: "ledgerEdit" })).status, 200);
    const ledgerEdited = await settled();
    assert.equal(ledgerEdited.jobs.agent.status, "failed");
    assert.match(ledgerEdited.jobs.agent.log.join("\n"), /spec\/lock.json: not marked synced/);
    assert.ok(fs.existsSync(path.join(root, ".studio/manifest.json")));
    assert.deepEqual([ledgerEdited.session.waiting, ledgerEdited.session.verdict], [2, "Unknown"]);
    assert.equal((await post("agent", { agent: "invalidState" })).status, 200);
    const broken = await settled();
    assert.equal(broken.jobs.agent.status, "failed");
    assert.match(broken.jobs.agent.log.join("\n"), /ENOTDIR/);

  } finally {
    await studio.close();
  }
});

test("the studio opens only the current project or the requested project path", async () => {
  const script = path.join(tools, "spec.ts");
  const repo = scratch({ "spec/index.md": "", "vibestack/examples/order/spec/index.md": "# Order\n" });
  const outside = scratch({ "a project/spec/index.md": "# Outside\n", "a project/package.json": '{"name":"order"}' });
  const example = path.join(repo, "vibestack/examples/order");
  const external = path.join(outside, "a project");
  const cases: [string, string | undefined, string][] = [
    [repo, undefined, repo], [repo, ".", repo], [repo, "vibestack/examples/order", example], [repo, example, example],
    [repo, external, external], [repo, path.relative(repo, external), external], [path.join(tools, ".."), "vibestack/studio", path.join(tools, "studio")],
  ];
  for (const [cwd, target, expected] of cases) {
    const child = spawn(process.execPath, [script, "studio", ...(target === undefined ? [] : [target]), "--port", "0"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let output = "", error = "";
    child.stderr.on("data", (chunk) => { error += chunk; });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`studio did not start: ${output}${error}`)), 60_000);
        child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`studio exited ${code}: ${error}`)); });
        child.stdout.on("data", (chunk) => {
          output += chunk;
          const address = output.match(/studio: (http:\/\/localhost:\d+)/)?.[1];
          if (address) { clearTimeout(timer); resolve(address.replace("localhost", "127.0.0.1")); }
        });
      });
      const root = fs.realpathSync(expected);
      const name = fs.existsSync(path.join(root, "package.json")) ? JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name : path.basename(root);
      assert.deepEqual(await (await fetch(`${url}/api/projects`)).json(), { projects: [{ id: ".", name }], open: "." });
      const current = await (await fetch(`${url}/api/project`)).json();
      assert.deepEqual(current.project, { id: ".", name, root });
      assert.deepEqual(current.specs.map((s: { file: string; text: string }) => [s.file, s.text]).sort(),
        readSpecs(root).filter((s) => s.file.startsWith("spec/")).map((s) => [s.file, fs.readFileSync(path.join(root, s.file), "utf8")]).sort());
      assert.equal((await fetch(`${url}/api/project?project=vibestack/examples/order`)).status, 404);
    } finally {
      child.kill("SIGTERM");
      await closed;
    }
  }
  await assert.rejects(serve(repo, ["missing", "--port", "0"]), /not an existing project directory/);
  await assert.rejects(serve(repo, ["spec/index.md", "--port", "0"]), /not an existing project directory/);
  const invalid = scratch({ "plain.txt": "not a project", "file-spec/spec": "not a directory" });
  for (const target of [invalid, path.join(invalid, "file-spec")]) await assert.rejects(serve(repo, [target, "--port", "0"]), /no spec\/ directory/);
});
