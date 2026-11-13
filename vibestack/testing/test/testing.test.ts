// The testing library on itself: the Effect helpers, the schema and contract properties, and the generator on
// copies of test/fixture, whose generated tests a second Vitest runs as a package's `pnpm test` would.
import { assert, describe, expect, it } from "@effect/vitest";
import { Cause, Data, Effect, Exit, Layer, Schema } from "effect";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { advance, effectDriver, failFirst, failed, fuzz, holds, idempotent, interrupted, invariant, roundTrips, succeeded, validates } from "../index.ts";
import { generateTests } from "../generate.ts";
import * as lamp from "./fixture/good/machine/lamp.conformance.ts";
import { Lamps, lamps } from "./fixture/good/src/lamps.ts";
import { Shape, Tree, User, UserId } from "./fixture/good/src/user.schema.ts";

class Unavailable extends Data.TaggedError("Unavailable")<{ attempt: number }> {}
const defect = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "";

describe("Effect helpers", () => {
  it.effect("advance moves the TestClock past a timeout", () => Effect.gen(function* () {
    const slow = Effect.sleep("10 seconds").pipe(Effect.as("done"));
    assert.isTrue(Cause.isTimeoutError(failed(yield* Effect.exit(advance(Effect.timeout(slow, "5 seconds"), "5 seconds")))));
    assert.strictEqual(yield* advance(slow, "10 seconds").pipe(Effect.timeout("11 seconds")), "done");
  }));

  it.effect("interrupted returns after the finalizers ran", () => Effect.gen(function* () {
    const log: string[] = [];
    const held = Effect.acquireUseRelease(Effect.sync(() => log.push("open")), () => Effect.never, () => Effect.sync(() => log.push("closed")));
    yield* interrupted(held, "1 hour");
    assert.deepStrictEqual(log, ["open", "closed"]);
    assert.match(defect(yield* Effect.exit(interrupted(Effect.succeed(1)))), /it had succeeded with 1/);
  }));

  it.effect("failFirst fails the first runs only, and a mock layer serves the rest", () => Effect.gen(function* () {
    const flaky = failFirst(2, new Unavailable({ attempt: 0 }))(Lamps.use((all) => all.get("a")));
    assert.deepStrictEqual(failed(yield* Effect.exit(flaky)), new Unavailable({ attempt: 0 }));
    assert.deepStrictEqual(yield* Effect.retry(flaky, { times: 1 }), { mode: "On", flips: 1 });
  }).pipe(Effect.provide(Layer.mock(Lamps, { get: () => Effect.succeed({ mode: "On", flips: 1 }) }))));

  it.effect("failed and succeeded keep the whole cause in their message", () => Effect.gen(function* () {
    const typed = Effect.fail(new Unavailable({ attempt: 3 }));
    assert.deepStrictEqual(failed(yield* Effect.exit(typed)), new Unavailable({ attempt: 3 }));
    // Effect 4 turns a typed failure into a defect once a finalizer dies beside it, so neither helper may hide either.
    const both = yield* Effect.exit(Effect.ensuring(typed, Effect.die(new Error("the finalizer broke"))));
    assert.throws(() => failed(both), /expected a typed failure, but got\n[^]*Unavailable[^]*the finalizer broke/);
    assert.throws(() => succeeded(both), /expected a success, but got\n[^]*Unavailable[^]*the finalizer broke/);
    assert.strictEqual(succeeded(Exit.succeed(1)), 1);
  }));

  it("an Effect driver builds its layer again on every reset and releases the last", async () => {
    let built = 0, released = 0;
    const counted = Layer.merge(lamps, Layer.effectDiscard(Effect.acquireRelease(Effect.sync(() => built++), () => Effect.sync(() => released++))));
    const driver = effectDriver(counted, { dispatch: () => Effect.succeed("accepted" as const), observe: (key) => Lamps.use((all) => all.get(key)) });
    for (const step of [driver.observe, driver.reset, driver.observe]) expect(await step("a") ?? lamp.found.events.length).toBeTruthy();
    await driver[Symbol.asyncDispose]();
    expect([built, released]).toEqual([2, 2]);
  });
});

describe("properties", () => {
  for (const [name, schema] of Object.entries({ UserId, Shape, Tree, User }) as [string, Schema.Codec<unknown, unknown>][])
    it.effect(`${name}, a branded, tagged, recursive or transforming schema, validates and round-trips`, () =>
      Effect.andThen(holds(schema, validates(schema)), holds(schema, roundTrips(schema))));

  it.prop("a property is an it.prop callback under the FUZZ budget", [Schema.Int], ([n]) => idempotent(Math.abs)(n), { arbitrary: fuzz });

  it.effect("a falsified property names the seed, the shrunk counterexample and the rerun command", () => Effect.gen(function* () {
    const exit = yield* Effect.exit(holds(Schema.Int, invariant((n: number) => n, (_, out) => out < 50), { runs: 200, seed: 7 }));
    assert.match(defect(exit), /Shrunk input: 50\n[^]*Seed: 7\nRerun: FUZZ_SEED=7 FUZZ_RUNS=200 pnpm vitest run .*testing\.test\.ts/);
  }));
});

const root = path.resolve(import.meta.dirname, "../../..");
/** A fresh copy of the fixture package, with the hand-written oracle where `spec gen` writes one and `overlay` over it. */
function fixture(name: string, overlay?: string) {
  const dir = path.join(import.meta.dirname, ".cache", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(import.meta.dirname, "fixture/good"), dir, { recursive: true });
  fs.renameSync(path.join(dir, "machine"), path.join(dir, "gen"));
  if (overlay) fs.cpSync(path.join(import.meta.dirname, "fixture", overlay), dir, { recursive: true });
  return dir;
}
const tree = (dir: string) => Object.fromEntries(fs.globSync("**/*", { cwd: dir, withFileTypes: true }).filter((f) => f.isFile())
  .map((f) => path.join(f.parentPath, f.name)).sort().map((f) => [path.relative(dir, f), fs.readFileSync(f, "utf8")]));
/** The package's own test run: `vitest run` on its vitest.config.ts. */
const vitest = (dir: string) => new Promise<{ status: number | null; said: string }>((resolve) => {
  const child = spawn(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--root", dir], { env: { ...process.env, FUZZ_SEED: "1", FUZZ_RUNS: "100", NO_COLOR: "1" } });
  let said = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { said += data; });
  child.on("close", (status) => resolve({ status, said }));
});

describe.concurrent("generated tests", () => {
  it("are the same bytes on every run, follow their sources, and pass for a package that keeps its contracts", async () => {
    const dir = fixture("good"), out = path.join(dir, ".cache/generated/tests");
    const files = ["conformance/lamp.test.ts", "src/math.contract.test.ts", "src/user.schema.test.ts"];
    const skipped = [
      { file: "src/math.contract.ts", export: "undeclared", reason: expect.stringContaining("declares no property") },
      { file: "src/user.schema.ts", export: "Opaque", reason: expect.stringContaining("no value can be generated") },
    ];
    expect(await generateTests(dir)).toEqual({ written: files, unchanged: [], removed: [], skipped });
    const first = tree(out);
    expect(Object.keys(first)).toEqual([...files, "manifest.json"].sort());
    expect(first["src/math.contract.test.ts"]).toMatch(/^\/\/ Generated by vibestack\/testing\/generate\.ts v1 from src\/math\.contract\.ts \(sha256 [0-9a-f]{16}\); do not edit\.\n/);
    expect(first["src/math.contract.test.ts"].match(/contractTest\(.*/g)).toEqual([
      `contractTest("clamped", subject["clamped"], "deterministic");`, `contractTest("clamped", subject["clamped"], "idempotent");`,
      `contractTest("clamped", subject["clamped"], "invariant");`, `contractTest("halved", subject["halved"], "inverse");`,
    ]);
    expect(await generateTests(dir)).toEqual({ written: [], unchanged: files, removed: [], skipped });
    expect(tree(out)).toEqual(first);

    const run = await vitest(dir);
    expect(run.said).toMatch(/Tests {2}17 passed \(17\)/);
    expect(run.status).toBe(0);

    fs.rmSync(path.join(dir, "src/math.contract.ts"));
    fs.rmSync(path.join(dir, "test/drivers/lamp.ts"));
    expect(await generateTests(dir)).toEqual({ written: [], unchanged: ["src/user.schema.test.ts"], removed: files.slice(0, 2), skipped: skipped.slice(1) });
    expect(Object.keys(tree(out))).toEqual(["manifest.json", "src/user.schema.test.ts"]);
    expect(Object.keys(JSON.parse(tree(out)["manifest.json"]).files)).toEqual(["src/user.schema.test.ts"]);
  });

  it("fail with the seed and the shrunk counterexample, and save a conformance counterexample that is replayed first", async () => {
    const dir = fixture("broken", "broken"), saved = path.join(dir, "test/counterexamples/lamp");
    await generateTests(dir);
    const { status, said } = await vitest(dir);
    expect(status).toBe(1);
    expect(said).toMatch(/absolute is invariant[^]*Shrunk input: -1\n[^]*Seed: 1\n\s*Rerun: FUZZ_SEED=1 FUZZ_RUNS=100 pnpm vitest run .*src\/abs\.contract\.test\.ts/);
    expect(said).toMatch(/Tests {2}2 failed \| 16 passed \(18\)/);

    const [file, ...others] = fs.readdirSync(saved);
    expect(others).toEqual([]);
    expect(file).toMatch(/^[0-9a-f]{12}\.json$/);
    expect(said).toContain(`Saved as ${path.join(saved, file)}`);
    expect(JSON.parse(fs.readFileSync(path.join(saved, file), "utf8"))).toEqual({ origin: expect.stringMatching(/^(journey|walk)/), seed: 1, trace: [[expect.any(String), { type: "toggle" }]] });

    const repeated = (await vitest(dir)).said;
    expect(repeated).toMatch(new RegExp(`counterexample ${file}[^]*a replayed trace of 1 events`));
    expect(repeated).toMatch(/Tests {2}3 failed \| 16 passed \(19\)/);
    expect(fs.readdirSync(saved)).toEqual([file]);
  });
});
