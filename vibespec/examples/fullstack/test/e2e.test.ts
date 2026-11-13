// spec/server.md, "Story: Change the list over HTTP"; spec/system.md, "Story: Edit together, online or not"; spec/system.md, "Story: Editing alone is never refused"
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { type TestContext, test } from "node:test";
import { view } from "../gen/client.ts";
import type { Answer, Snapshot } from "../src/protocol.ts";
import { createServer, TodoStore } from "../src/server.ts";
import { Tab } from "../src/web/sync.ts";

async function serve(t: TestContext) {
  const store = new TodoStore();
  const server = createServer(store);
  await new Promise<void>((done) => server.listen(0, done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const post = async (body: unknown) => {
    const res = await fetch(`${base}/api/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Answer };
  };
  const tab = () => {
    const x = new Tab(base);
    t.after(() => x.close());
    return x;
  };
  return { base, store, post, tab };
}

async function until(ok: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("Story: Change the list over HTTP", async (t) => {
  const { base, store, post } = await serve(t);

  // spec/server.md, "A request is answered only once"
  const create = { type: "create", client: "ann", seq: 1, id: "ann-1", title: "milk" };
  const first = await post(create);
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.version, 1);
  const again = await post(create);
  assert.equal(again.body.ok, true);
  assert.equal(again.body.version, 1);
  assert.equal(again.body.todos.length, 1);

  // spec/server.md, "A new request can be refused, which is logged with its edit and changes nothing else"
  const tick = { type: "setDone", client: "ann", seq: 2, id: "nobody", done: true };
  const refused = await post(tick);
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.version, 1);
  assert.equal((await post(tick)).body.ok, false);
  assert.equal(store.state.log.length, 2);

  // spec/server.md, "A to-do is never taken out of the list; removing it leaves a tombstone"
  assert.equal((await post({ type: "remove", client: "ben", seq: 1, id: "ann-1" })).body.ok, true);
  const reused = await post({ type: "create", client: "ben", seq: 2, id: "ann-1", title: "milk" });
  assert.equal(reused.body.ok, false);
  assert.deepEqual(reused.body.todos.map((t) => [t.id, t.deleted]), [["ann-1", true]]);

  // spec/server.md, "A request is answered only once"
  assert.equal((await post({ type: "create", client: "dan", seq: 1, id: "dan-x", title: "forged" })).body.ok, true);
  const real = await post({ type: "create", client: "dan", seq: 1, id: "dan-1", title: "milk" });
  assert.equal(real.body.ok, false);
  assert.ok(!real.body.todos.some((t) => t.id === "dan-1"));
  assert.equal((await post({ type: "create", client: "dan", seq: 1, id: "dan-x", title: "forged" })).body.ok, true);

  // spec/server.md, "A new request can be refused, which is logged with its edit and changes nothing else"
  const refuse = { type: "refuse", client: "eve", seq: 1, op: { kind: "create", id: "eve-1", title: "milk", done: false } };
  assert.equal((await post(refuse)).status, 400);
  assert.equal((await post({ type: "create", client: "eve", seq: 1, id: "eve-1", title: "milk" })).body.ok, true);

  assert.equal((await post({ type: "create", client: "ann", seq: 1.5, id: "x", title: "y" })).status, 400);
  assert.equal((await post({ type: "explode" })).status, 400);
  assert.equal((await fetch(`${base}/api/events`, { method: "POST", body: "{not json" })).status, 400);

  const stream = (await fetch(`${base}/api/stream`)).body!.pipeThrough(new TextDecoderStream()).getReader();
  const s = JSON.parse((await stream.read()).value!.slice("data: ".length)) as Snapshot;
  await stream.cancel();
  assert.equal(s.version, store.state.version);
  assert.equal(s.todos.length, 3);

  // spec/client.md, "Story: Edit the list in the browser"
  const res = await fetch(`${base}/src/web/app.ts`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /javascript/);
  assert.doesNotMatch(await res.text(), /interface ReactLike/);
  assert.equal((await fetch(`${base}/src/../package.json`)).status, 404);
  assert.match(await (await fetch(`${base}/`)).text(), /importmap/);
});

test("Story: Edit together, online or not", async (t) => {
  const { store, tab } = await serve(t);
  const a = tab();
  const b = tab();
  a.listen();
  b.listen();

  const milk = a.newId();
  await a.edit({ type: "create", id: milk, title: "milk" });
  await until(() => b.state.seen === 1);

  // spec/system.md, "A user edit is queued in the tab, and sent at once if the tab is online and has nothing else queued"
  a.goOffline();
  const eggs = a.newId();
  await a.edit({ type: "create", id: eggs, title: "eggs" });
  await a.edit({ type: "rename", id: milk, title: "oat milk" });
  assert.equal(a.state.pending.length, 2);
  await b.edit({ type: "setDone", id: milk, done: true });
  assert.equal(store.state.version, 2);

  // spec/system.md, "The server takes any request off the network and answers it"
  await a.send(a.state.pending[0]!);
  await a.send({ seq: 2, op: { kind: "create", id: eggs, title: "eggs", done: false } });
  assert.equal(store.state.version, 3);

  // spec/system.md, "A tab can go offline, and sends its oldest queued edit when it comes back"
  await a.goOnline();
  await until(() => b.state.seen === store.state.version);

  // spec/system.md, "Both tabs can finish their edits and agree with the server"
  assert.equal(a.state.pending.length, 0);
  assert.equal(b.state.pending.length, 0);
  assert.equal(a.state.seen, store.state.version);
  assert.equal(b.state.seen, store.state.version);
  assert.deepEqual(view(a.state), view(b.state));
  assert.deepEqual(view(a.state), store.state.todos);
  assert.deepEqual(view(a.state).map((t) => [t.title, t.done]), [["oat milk", true], ["eggs", false]]);
});

test("Story: Editing alone is never refused", async (t) => {
  const { tab } = await serve(t);
  const a = tab();
  a.goOffline();
  const milk = a.newId();
  await a.edit({ type: "create", id: milk, title: "milk" });
  await a.edit({ type: "setDone", id: milk, done: true });
  await a.edit({ type: "rename", id: milk, title: "oat milk" });
  await a.goOnline();
  // spec/system.md, "A lone user's edit is never refused"
  assert.equal(a.state.pending.length, 0);
  assert.equal(a.state.refusals, 0);
  assert.deepEqual(view(a.state).map((t) => [t.title, t.done]), [["oat milk", true]]);
});
