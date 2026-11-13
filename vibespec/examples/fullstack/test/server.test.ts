// spec/server.md, "Story: Change the list over HTTP"
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createServer, TodoStore } from "../src/server.ts";

type Answer = { ok: boolean; seq: number; version: number; todos: { id: string; done: boolean; deleted: boolean }[] };

test("Story: Change the list over HTTP", async () => {
  const store = new TodoStore();
  const server = createServer(store);
  await new Promise<void>((done) => server.listen(0, done));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const send = (body: string, type = "application/json") =>
    fetch(`${base}/api/events`, { method: "POST", headers: { "content-type": type }, body });
  const post = async (body: unknown) => {
    const res = await send(JSON.stringify(body));
    return { status: res.status, body: (await res.json()) as Answer };
  };
  try {
    // spec/server.md, "A new request whose edit makes sense is applied, raising the version by one"; spec/server.md, "A request is answered only once"
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
    const recreate = await post({ type: "create", client: "ben", seq: 2, id: "ann-1", title: "milk" });
    assert.equal(recreate.body.ok, false);
    assert.deepEqual(recreate.body.todos.map((t) => [t.id, t.deleted]), [["ann-1", true]]);

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
    assert.equal((await send("{not json")).status, 400);
    const version = store.state.version;
    assert.equal((await send(JSON.stringify({ type: "remove", client: "zed", seq: 1, id: "eve-1" }), "text/plain")).status, 415);
    assert.equal(store.state.version, version);

    const s = (await (await fetch(`${base}/api/snapshot`)).json()) as { version: number; todos: unknown[] };
    assert.equal(s.version, store.state.version);
    assert.equal(s.todos.length, 3);

    const res = await fetch(`${base}/src/web/app.ts`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    assert.doesNotMatch(await res.text(), /interface ReactLike/);
    assert.equal((await fetch(`${base}/src/../package.json`)).status, 404);
    assert.match(await (await fetch(`${base}/`)).text(), /importmap/);
  } finally {
    server.close();
  }
});
