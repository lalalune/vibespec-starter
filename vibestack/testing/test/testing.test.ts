// The testing library on itself: the Effect driver, the schema and contract properties, and the generator on
// copies of test/fixture, whose generated tests a second Vitest runs as a package's `pnpm test` would.
import { assert, describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Schema, SchemaTransformation } from "effect";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { deterministic, effectDriver, encodesStably, fuzz, holds, idempotent, invariant, inverse, roundTrips } from "../index.ts";
import { generateTests } from "../generate.ts";
import { Lamps, lamps } from "./fixture/good/src/lamps.ts";
import { Shape, Tree, User, UserId } from "./fixture/good/src/user.schema.ts";

const defect = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "";

describe("Effect drivers", () => {
  it("an Effect driver builds its layer again on every reset and releases the last", async () => {
    let built = 0, released = 0;
    const counted = Layer.merge(lamps, Layer.effectDiscard(Effect.acquireRelease(Effect.sync(() => built++), () => Effect.sync(() => released++))));
    const driver = effectDriver(counted, { dispatch: () => Effect.succeed("accepted" as const), observe: (key) => Lamps.use((all) => all.get(key)) });
    for (const step of [driver.observe, driver.reset, driver.observe]) await step("a");
    await driver[Symbol.asyncDispose]();
    expect([built, released]).toEqual([2, 2]);
  });
});

describe("properties", () => {
  for (const [name, schema] of Object.entries({ UserId, Shape, Tree, User }) as [string, Schema.Codec<unknown, unknown>][])
    it.effect(`${name}, a branded, tagged, recursive or transforming schema, round-trips to a stable encoding`, () =>
      Effect.andThen(holds(schema, roundTrips(schema)), holds(schema, encodesStably(schema))));

  /** Loses the sign on the way in. */
  const Lossy = Schema.Int.pipe(Schema.decodeTo(Schema.Int, SchemaTransformation.transform({ decode: Math.abs, encode: (n) => n })));
  let calls = 0;
  for (const [name, wrong] of Object.entries({
    roundTrips: roundTrips(Lossy), encodesStably: encodesStably(Lossy), deterministic: deterministic(() => calls++),
    idempotent: idempotent((n: number) => n + 1), inverse: inverse((n: number) => n * 2, (twice) => twice),
  }))
    it.effect(`${name} is falsified by what breaks it`, () => Effect.gen(function* () {
      assert.match(defect(yield* Effect.exit(holds(Schema.Int, wrong))), /Shrunk input: /);
    }));

  it.effect("a property sees FUZZ_RUNS values of seed FUZZ_SEED, except as its options say", () => Effect.gen(function* () {
    const seen = (options?: { runs?: number; seed?: number }) => Effect.gen(function* () {
      const values: number[] = [];
      yield* holds(Schema.Int, (n) => values.push(n) > 0, options);
      return values;
    });
    const [all, some] = [yield* seen(), yield* seen({ runs: 50 })];
    assert.deepStrictEqual([all.length, some.length, new Set(all).size > 10], [fuzz.runs, 50, true]);
    assert.deepStrictEqual([yield* seen(fuzz), yield* seen({ runs: 50, seed: fuzz.seed })], [all, some]);
    assert.notDeepEqual(yield* seen({ seed: fuzz.seed + 1 }), all);
    assert.match(defect(yield* Effect.exit(holds(Schema.Int, (n) => n < 50, { runs: 200 }))), new RegExp(`Seed: ${fuzz.seed}\nRerun: node -e `));
  }));

  it.prop("a property is an it.prop callback under the FUZZ budget", [Schema.Int], ([n]) => idempotent(Math.abs)(n), { arbitrary: fuzz });

  it.effect("a falsified property names the seed, the shrunk counterexample and the rerun command", () => Effect.gen(function* () {
    const exit = yield* Effect.exit(holds(Schema.Int, invariant((n: number) => n, (_, out) => out < 50), { runs: 200, seed: 7 }));
    assert.match(defect(exit), /Shrunk input: 50\n[^]*Seed: 7\nRerun: node -e /);
  }));
});

const root = path.resolve(import.meta.dirname, "../../..");
/** A fresh copy of the fixture package, with `overlay` over it. */
function fixture(name: string, overlay?: string) {
  const dir = path.join(import.meta.dirname, ".cache", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(import.meta.dirname, "fixture/good"), dir, { recursive: true });
  if (overlay) fs.cpSync(path.join(import.meta.dirname, "fixture", overlay), dir, { recursive: true });
  return dir;
}
const tree = (dir: string) => Object.fromEntries(fs.globSync("**/*", { cwd: dir, withFileTypes: true }).filter((f) => f.isFile())
  .map((f) => path.join(f.parentPath, f.name)).sort().map((f) => [path.relative(dir, f), fs.readFileSync(f, "utf8")]));
/** The package's own test run: `vitest run` on its vitest.config.ts. */
const vitest = (dir: string, env: Record<string, string> = {}, rerun?: string) => new Promise<{ status: number | null; said: string }>((resolve) => {
  const options = { env: { ...process.env, FUZZ_SEED: "1", FUZZ_RUNS: "100", NO_COLOR: "1", ...env } };
  const child = rerun
    ? spawn(rerun, { ...options, cwd: dir, shell: true })
    : spawn(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--root", dir], options);
  let said = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { said += data; });
  child.on("close", (status) => resolve({ status, said }));
});

describe.concurrent("generated tests", () => {
  it("are the same bytes on every run, follow their sources, and pass for a package that keeps its contracts", async () => {
    const dir = fixture("good"), out = path.join(dir, ".cache/generated/tests");
    // src/point.schema.vibe is VibeLang, which the generator loads through vibelang/register.
    const files = ["src/math.contract.test.ts", "src/point.schema.test.ts", "src/user.schema.test.ts"];
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
    expect(run.said).toMatch(/Tests {2}14 passed \(14\)/);
    expect(run.status).toBe(0);
    expect((await vitest(dir, { FUZZ_RUNS: "0" })).said).toContain(`FUZZ_RUNS must be a whole number, 1 or more, but is "0"`);

    // A header carries the hash of what its source says.
    fs.appendFileSync(path.join(dir, "src/math.contract.ts"), "// edited\n");
    expect(await generateTests(dir)).toEqual({ written: files.slice(0, 1), unchanged: files.slice(1), removed: [], skipped });

    fs.rmSync(path.join(dir, "src/math.contract.ts"));
    expect(await generateTests(dir)).toEqual({ written: [], unchanged: files.slice(1), removed: files.slice(0, 1), skipped: skipped.slice(1) });
    expect(Object.keys(tree(out))).toEqual(["manifest.json", ...files.slice(1)]);
    expect(Object.keys(JSON.parse(tree(out)["manifest.json"]).files)).toEqual(files.slice(1));
  });

  it("fail the package's run before any test when a module gets none, and say why", async () => {
    const dir = fixture("skipping", "broken");
    expect((await generateTests(dir)).skipped).toContainEqual({ file: "src/throws.schema.ts", export: "*", reason: "the module does not load: no schema here" });
    const { status, said } = await vitest(dir);
    expect(status).toBe(1);
    expect(said).toContain("generated tests: 1 module gets no test");
    expect(said).toContain("  src/throws.schema.ts: the module does not load: no schema here");
    expect(said).not.toMatch(/Tests {2}\d/);
  });

  it("fail with the seed and the shrunk counterexample", async () => {
    const dir = fixture("broken path's", "broken");
    fs.rmSync(path.join(dir, "src/throws.schema.ts"));
    const { status, said } = await vitest(dir);
    expect(status).toBe(1);
    expect(said).toMatch(/absolute is invariant[^]*Shrunk input: -1\n[^]*Seed: 1\n\s*Rerun: node -e /);
    expect(said).toMatch(/Tests {2}1 failed \| 14 passed \(15\)/);
    const command = said.match(/^\s*Rerun: (.+)$/m)?.[1];
    expect(command).toBeDefined();
    const rerun = await vitest(dir, {}, command);
    expect(rerun.status).toBe(1);
    expect(rerun.said).toContain("Shrunk input: -1");
  });
});
