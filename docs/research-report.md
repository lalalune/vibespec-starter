# Research report: onespec, branch review-improvements

This pass covers every file in the `review-improvements` worktree. Specialist reviews read each area line by line, a separate pass verified each finding, and a final pass looked across areas. Findings that the main checkout's uncommitted work (main WIP) already fixes are marked as such. Findings that build on `docs/roadmap.md` say "extends roadmap". Line numbers refer to the worktree unless a finding says otherwise. Timings were taken on a 16-core machine that other sessions were also using (load average 17-76), so compare them with each other, not as absolutes.

## 1. Summary: ten highest-value actions (impact/effort)

1. **U1** Get every example back to a green `check`: the user re-accepts the root, dashboard and fullstack ledgers and commits the missing `src.lock.json` files. Today all three are red on a fresh clone. `spec/order.lock.json:1`
2. **U2** Port main WIP's selftest fixes to this branch, which fails 2 of its own selftest cases. `tools/selftest.ts:446`, `tools/prove.ts:322`
3. **K1** Write `gen/package.json` `{"type":"module"}` after gen/ is wiped. Without it, every spec fails the model stage in a consumer whose package.json has `"type":"commonjs"`, which is npm 11's default. `tools/spec.ts:785`
4. **B7** Qualify imported enum variants in the harness with `D_<module>`. Today a transition parameter whose type is an imported enum produces a harness Quint rejects. `tools/gen/harness.ts:22`
5. **B8** Hide match binders inside lambda parameters. Today `x.f` in a lambda inside a match arm is silently rewritten to the subject's field. `tools/gen/print.ts:82`
6. **B18** Pin z3 and put its version in the cache key. Resource counts differ 6.7x between the two z3 installs on this machine. `tools/prove.ts:24`, `tools/spec.ts:381`
7. **P14** Sample list parameters with independent picks instead of materialising every pair: 15 traces/s becomes 1942. `tools/gen/harness.ts:24`
8. **P1** Cache the `quint typecheck` IR, keyed on meaning, and stop running it synchronously. It is most of every warm check (fullstack 5.3 s of 6.85 s). `tools/spec.ts:425`
9. **P3** Run the guard-coverage searches concurrently and give the refuses side a smaller budget: 43 s becomes about 12 s on a toy spec. `tools/spec.ts:874`
10. **P7** Verify without `--isolate-assertions` first and isolate only the definitions that fail. Tracker proof work drops 4.5-5x with the same verdict. `tools/prove.ts:34`

Next in line: O1 (sync skill names 4 of the 12 review statuses), T1 (`Promise.all` in the two slowest selftest cases, 330 s critical path), E14 (fullstack server re-checks `inv` on every request, O(n²) per request), B1 (an imported definition shadowed by a local name is never a review dependency), B23 (`runAsync` has no timeout, no output cap, no Windows support and leaks a slot when spawn throws).

## 2. Findings by theme

Each item gives the title, the location as file:line, then what is wrong, the proposal, the evidence, and impact/effort.

### Soundness & bugs

**B1. Review dependencies ignore `Alias::name`, so a local name shadows the imported one**
`tools/spec.ts:226` (also 93, 190). Impact high, effort M.
- What: `mentions` splits `L::initial` into `L` and `initial`. `dependencies` resolves `initial` locally first, so in tools/fixtures/room.md lamp's `initial` is never a dependency. parseSpec records only the module name of an import, not the alias or whether it is a `.*` import. In the same way, `S::x` in fullstack system.md depends on both server's and client's `x`.
- Proposal: parse each import as `{module, alias?, star}`. Have `mentions` return qualified pairs `(\w+)::(\w+)` first. Resolve `A::n` only in the spec imported as A, and a bare `n` locally and then only in `.*` imports. Add a selftest case.
- Evidence: lamp's `initial` moved into its own rule and then changed. `pending()` flags lamp's rule, and room returns `[]` although its rule "starts dark" is now false.

**B2. Local `val` bindings inside a def are recorded as rule definitions**
`tools/spec.ts:91`. Impact medium, effort S.
- What: the regex `^\s*(?:pure\s+)?(?:def|val|type)\s+(\w+)` captures indented locals. tracker.md has `old`, `id`, `found` and `p` at lines 162, 182, 364 and 370. Every rule that mentions `.id` or `p =>` then "relies on" `create` or `fix`, so 13 and 3 rules are flagged when those change.
- Proposal: record only definitions at brace depth 0. Add a selftest case.
- Evidence: the dashboard review lists "through … id (… A new task gets a number …)" on unrelated rules. Not changed by main WIP.

**B3. Two `##` stories with the same title can never be accepted**
`tools/spec.ts:101`. Impact medium, effort S.
- What: duplicate rule keys are refused at line 107, but duplicate story titles are not. Both stories get the key `## <title>`, JSON keeps only the last one, and the first story shows "story changed" forever. `rulesOf` (187) also gives the first story the second story's rules.
- Proposal: throw `duplicate story "<title>"` at the `## ` branch. Drop the `r.line > s.line` filter in rulesOf, which is then dead.
- Evidence: the lock file has the key `"## Story: A"` twice, and a second accept does not clear it.

**B4. `contractOf` counts any line that contains `//@`, prose comments included**
`tools/spec.ts:329`. Impact low, effort S.
- What: `l.includes("//@")` treats src/ledger.ts:3, a prose comment that mentions `//@ ensures`, as part of the contract, so rewording that comment needs a sign-off.
- Proposal: `l.trim().startsWith("//@")`, plus a selftest case. Main WIP has the same code at line 294.
- Evidence: the check output's "The contracts, in full" prints that comment line.

**B5. A src contract is not tied to its function**
`tools/spec.ts:329`. Impact low, effort M.
- What: the contract is a flat, ordered list of `//@` lines, so moving a `requires` from `f` to `g` keeps the same hash and needs no sign-off.
- Proposal: prefix each annotation with the name of its enclosing declaration, taken from the TS AST that checkVerifiedSource already builds. Every src.lock.json then needs one re-accept.
- Evidence: `pendingContracts()` returns `[]` after the line is moved.

**B6. A truncated `.spec-cache` entry crashes every later check**
`tools/spec.ts:406` (write at 410, cleanup at 1022). Impact medium, effort S. Merges two findings.
- What: entries are written with a plain `writeFileSync` and read with an unguarded `JSON.parse`. A Ctrl-C in watch, a kill or a full disk leaves a partial file. The result is a bare `Unterminated string in JSON`, with no file name, on every later run. `gen/run-*` is left behind because its `rmSync` is not in a `finally`.
- Proposal: write to `${file}.${pid}.tmp` and `renameSync` it into place. On a parse failure, delete the entry and treat it as a miss. Move `rmSync(loaded)` into `finally`. Main WIP has the same code.
- Evidence: entries truncated to 40-50 bytes, then `check` exits 1 after the first `✓ model` line.

**B7. An imported enum type used as a parameter produces an unresolvable harness**
`tools/gen/harness.ts:22`. Impact high, effort S.
- What: `byType` writes the variants as `M::<variant>` regardless of which module defines the type. qType (types.ts:76) already picks `M` or `D_<module>`.
- Proposal: look up the typedef and prefix with `d.module === module ? "M" : "D_"+d.module`. Add a selftest case.
- Evidence: with `import lib.*` or `import lib as L`, `quint run gen/app.run.qnt` fails with `[QNT404] Name 'M::Small' not found`.

**B8. A lambda parameter named like a match binder is translated as the matched value**
`tools/gen/print.ts:82` (field case 143, binders 191). Impact high, effort S.
- What: `arrow()` does not hide the `renamed`/`matchedAs` entries for its own parameters. Inside `Packed(x) => s.items.every(x => x.w > 2)` the output is `q.w`. It typechecks whenever the field names coincide, and the proof is then about the wrong code.
- Proposal: in `arrow`, save and delete those entries for each parameter, then restore them using main WIP's `restore`. Add a fixture.
- Evidence: the generated code is `s.items.every((x: Item) => q.w > 2)`, and replay reports "TypeScript gives true, Quint gives false". Main WIP fixes only the match arms.

**B9. Two record types with the same fields are confused**
`tools/gen/types.ts:40`. Impact medium, effort S.
- What: `named()` takes the first typedef whose shape matches. Casts and lambda types can then name the wrong type. TypeScript accepts this because it is structural, but Dafny is nominal and rejects it.
- Proposal: when more than one distinct typedef matches, refuse with a message saying which two types share fields.
- Evidence: `Meters`/`Feet` `{v:int}` gives `({ v: n } as Meters)` pushed into `s.feet`, and Dafny reports "expected Feet -> bool, found Meters -> bool".

**B10. `Set.map` that returns records gets past the "simple values only" rule**
`tools/gen/print.ts:211` (also 208, 215; types.ts:52). Impact medium, effort S.
- What: only the input element and `Set(...)` literals are checked. The output of `map` is not, and the result deduplicates by reference (`includes`).
- Proposal: refuse `set` of non-scalar once in `tsType`/`declaration` and delete the two copies in print.ts.
- Evidence: replay shows TypeScript `rs:[{w:1},{w:1}]` where Quint has `[{w:1}]`. This contradicts CONTRIBUTING.md:121.

**B11. `0 * -n` gives -0, and replay reports two identical-looking states as a generator bug**
`tools/gen/types.ts:134` (print.ts:7, spec.ts:518/521). Impact medium, effort S.
- Proposal: `canon` returns `v + 0` for ints. Also normalise the definition-result comparison at spec.ts:518, which does not go through canon.
- Evidence: the message reads `TypeScript reached {"v":0}, Quint reached {"v":0}`, and `isDeepStrictEqual({a:-0},{a:0}) === false`.

**B12. `decode` silently rounds trace integers above 2^53, or turns them into NaN**
`tools/gen/types.ts:122`. Impact low, effort S.
- Proposal: parse with `BigInt`. If the value is not safe or not a string or number, fail with "beyond 2^53; bound it with a guard" so it is reported as a spec problem.
- Evidence: the trace ends in `{"v":null}`, while Quint's own state shows a big-number object.

**B13. A zero-parameter `pure def` crashes the generator**
`tools/gen.ts:136`. Impact low, effort S.
- Proposal: refuse `puredef` whose expression is not a lambda, with "write `pure val lim = …`".
- Evidence: `pure def lim = 3` gives `Cannot read properties of undefined (reading 'map')`.

**B14. A spec with a state and no transitions emits an empty `export type Event =`** (extends roadmap Correctness 2)
`tools/gen/classify.ts:45` (cause at gen/typescript.ts:29-30). Impact low, effort S.
- What: the harness copes with zero events. The failure comes from the TypeScript emitter, and the message is a location-free "Expected '{', got 'ident'".
- Proposal: in classify, fail when there is a state type but no transitions, saying "defines `initial` but no transition".
- Evidence: `gen/notrans.run.qnt` runs `[ok]`, and gen/notrans.ts contains `export type Event =` followed directly by the next declaration.

**B15. A definition with three or more state parameters is neither evaluated nor listed as uncompared**
`tools/gen/harness.ts:43`. Impact low, effort S.
- Proposal: push it to `uncompared` before `return []`.
- Evidence: `sum3(a,b,c: T)` appears in neither list, and replay claims "2 definitions evaluated".

**B16. A `<param>Values` set is used for every parameter of that name, whatever its type**
`tools/gen/harness.ts:19`. Impact medium, effort S.
- What: name clashes such as `n`, `id` or `t` produce a Quint unification error inside gen/*.run.qnt. An unused `<x>Values` (a typo) is silently ignored.
- Proposal: pass the inferred element types (gen.ts:103) to harness(). On a mismatch, fail naming the set, the parameter and the spec line. Fail on any sample set that nothing used.
- Evidence: `nValues: Set(1,2)` with `label(n: str)` gives `QNT000 Couldn't unify str and int at gen/clash.run.qnt:13:146`.

**B17. A law that is false on a reachable state passes simulation**
`tools/gen/harness.ts:67-74`. Impact medium, effort S-M. Merges two findings.
- What: `lawAction` samples state parameters only from hand-written `<param>Values`. `evalAction` evaluates the same law on every probed state but writes only `out`, never `lawsHold`. Affected examples: server.md:171 (2 states), client.md:198 (2) and projects.md:117 (4 registries).
- Proposal: in evalAction, when the definition is a law, also set `lawsHold' = M::<law>(state, …)`. Have `firstBreak` treat a false law result as a break, and source state-typed law parameters from `state`/`prev`. `<param>Values` then become optional extras.
- Evidence: `lawSmall(t) = t.c < 3` passes `always` and replay, then fails in `proof`. gen/projects.run.qnt:33 computes the law and drops the result. Today this makes `accept -- unproved` describe such obligations as "held in simulation", which is false.

**B18. The solver is whatever z3 comes first on PATH, and it is not in the cache key**
`tools/prove.ts:24` (toolchainId spec.ts:381). Impact high, effort S.
- What: Homebrew Dafny ships no z3. Here PATH resolves to miniconda's Z3 4.12.5 before Homebrew's 4.15.4. RESOURCE_LIMIT verdicts depend on the solver, and cached verdicts are reused across solvers.
- Proposal: resolve the solver once (Dafny's bundled one, else `which z3`), warn on versions Dafny 4.11 does not support, pass `--solver-path` in DAFNY_FLAGS, and add `z3@<ver>` to toolchainId. Optionally log `--log-format csv` and report any batch above RESOURCE_LIMIT/2.
- Evidence: `create_ensures` maximum ResourceCount is 1.28M on 4.12.5 and 8.54M on 4.15.4. `step_ensures` is 15.5M/19.8M, against the "14.2M" in the comment (main WIP drops that comment).

**B19. `recheck` silently skips definitions it cannot find**
`tools/prove.ts:451` (continue at 453, 459). Impact low, effort S.
- What: the regex covers only `lemma|method`. Functions such as LemmaScript's prelude `StringFromCharCode` (2 ensures), and headers with attributes, are skipped, so a postcondition proved by assuming a failed one counts as proved.
- Proposal: reuse DEFINITION. When the per-postcondition copies cannot be built for a failing definition, fail closed by marking its other ensures unproved.
- Evidence: a Dafny reproduction where `ensures x>5` fails and `ensures x>4` reports verified.

**B20. Obligation totals count LemmaScript's prelude helpers**
`tools/prove.ts:605`. Impact low, effort S.
- Proposal: count only the ensures of definitions that come from the unit. Report prelude failures as errors, not as obligations a user can accept.
- Evidence: `src-columns.ts: all 4 obligations proved`, where 2 of the 4 belong to StringFromCharCode.

**B21. A unit that depends on unproved obligations is reported as "Dafny could not check it"**
`tools/spec.ts:973`. Impact low, effort S.
- Proposal: report "not checked on its own: relies on order.ts obligations that are not proved", or count loop-invariant errors as obligations.
- Evidence: with an order rule deleted, order.ts reports 4 of 62 not proved, src-ledger.ts reports "could not check", and the log shows 2 invariant errors. Main has the same code at spec.ts:878.

**B22. A fully proved unit with outdated ledger entries never shows the "tighten" hint**
`tools/spec.ts:960-978`. Impact medium, effort S.
- What: `stale` is computed only from `valid`, which is empty when the fingerprint differs, as it does for every legacy entry. kernel.ts and projects.ts print "all proved" while the ledger still lists 2 and 12 of their obligations.
- Proposal: when `was` exists and either its text differs or `stale` is non-empty, append "unproved.lock.json still lists N … run `npm run accept -- unproved`". Add a selftest case. Main WIP has the same code at 873-894.

**B23. `runAsync` duplicates `run()` but drops its timeout, output cap, Windows handling and slot safety**
`tools/prove.ts:86` (run 64-78; tests stage spec.ts:1013). Impact high, effort M. Merges three findings.
- What: every heavy process (quint run, lsc, dafny, tsc) goes through `spawn(exe, args, {cwd})`. That has no TOOL_TIMEOUT, so a hung tool blocks `check` forever. Output accumulates without a cap. On Windows, `.cmd` shims without a shell throw EINVAL, and because that happens after `acquire()` the slot is never released. Simulations print nothing for up to about 20 minutes on a 200,000-sample search. The tests stage copies the limits as literals (`1 << 28`, `60*60*1000`).
- Proposal: create tools/run.ts with a shared `tool()` (bin lookup and Windows quoting) and a `runAsync(cmd,args,cwd,{env})` that kills the child after TOOL_TIMEOUT, caps output, and releases the slot in `finally` (including when spawn throws). Make run() a thin sync wrapper. Run the tests stage through runAsync without NODE_TEST_CONTEXT. Log "simulating <spec> …" for long runs.
- Evidence: an `lsc check` and Dafny child sat at 0% CPU for 29 minutes with the parent still waiting. prove.ts:90 is `spawn(exe, args, { cwd })`. Not fixed by main WIP.

**B24. Simulation budgets are module globals that each check overwrites**
`tools/spec.ts:768` (globals 29-33, key 817, reads 485/830/874). Impact low, effort S.
- What: concurrent in-process checks (the selftest runs them with `concurrency: true`) can store results computed with one budget under another budget's key, and an `accept` can be simulated with the QUICK budget.
- Proposal: compute a `budget` object in checkLocked and pass it to simulate(), the key and the messages, then delete the globals. This is also what makes T2 possible.

**B25. Quint error columns point past the user's text after list-helper expansion**
`tools/spec.ts:432`. Impact low, effort S.
- Proposal: have expandListHelpers return its column edits per line and map columns back through them, or drop the column on rewritten lines.
- Evidence: an error is reported at `col.md:6:101` for a name at column 61.

**B26. A same-line trailing `//@` is refused for a false reason**
`tools/spec.ts:656`. Impact low, effort S.
- Proposal: also collect `getTrailingCommentRanges` and refuse those with "a `//@` must start its own line". The refusal is right, because LemmaScript reads only leading comments. The message currently blames a block comment or string.

**B27. Line-break and NUL refusals are copied per reader, and verified src/*.ts gets only the NUL half**
`tools/spec.ts:630` (76, 633; prove.ts:129, 135, 193). Impact low, effort S.
- What: checkVerifiedSource allows `\r`, U+2028 and U+2029, which TypeScript treats as line ends, while contractOf splits on `\n`. A reviewer can therefore see contract lines that differ from what the compiler reads.
- Proposal: one `plainText(file, text)` in tools/util.ts, called from all three readers.

**B28. `spec watch` loses tsconfig.json after an atomic save and never sees src/ or test/ created later**
`tools/spec.ts:1240`. Impact low, effort S.
- Proposal: watch the root non-recursively and attach recursive watchers as spec/, src/ and test/ appear.
- Evidence: `fs.watch(file)` followed by three temp-and-rename saves fires 1 event.

**B29. `accept unproved` prints the ledger summary before the unit lines**
`tools/spec.ts:989`. Impact low, effort S. Proposal: route it through `said(...)` like the other lines. `--json` order is wrong too.

**B30. A sample set used by name in a definition passes the model stage**
`tools/gen/print.ts:95` (check only at 222). Impact medium, effort S.
- Proposal: refuse `sampleSets.has(e.name)` in the `name` case, with the existing message.
- Evidence: `kValues.contains(k)` in a guard becomes `kValues.includes(k)`, with `kValues` undefined, and fails as "✗ always the simulator could not run".

### Unfinished features

**U1. All three example projects are red on a fresh clone** (extends roadmap Correctness 4 and Language 3)
`spec/order.lock.json:1`, `examples/dashboard/spec/*.lock.json`, `examples/fullstack/spec/`. Impact high, effort S. Merges five findings.
- What:
  - Root: the lock was written before story, dependency and contract review existed. Every entry has 2 elements, so check reports 31 items, mostly "model changed (what it relies on was not recorded before)". `spec/src.lock.json` was never committed.
  - Dashboard: 14 rules are keyed by old story titles ("Edit through the app", …). There are no story keys and no dependency fingerprints, 2 rules are missing, and there is no src.lock.json. `unproved.lock.json` is in the legacy array format with 81 dead entries. In reality 3 of 307 obligations are unproved, and main WIP's tracker.proof.dfy proves all 3 (`2717 verified, 0 errors`).
  - Fullstack: no lock files are committed, which gives 69 review items plus 1 contract.
  - The selftest cannot notice any of this, because `copyOfProject` auto-accepts (selftest.ts:54-55).
- Proposal: the user reviews and runs `npm run accept` in each project, and `accept -- unproved` in the dashboard once main WIP's proof lands. Agents must not run accept (AGENTS.md). Then commit the locks. Fix the README "How much is proved" text and the "81" in the roadmap. Add a CI or selftest step that runs `check --json` on each committed project, with no copy and no auto-accept, and asserts no failures (see T12).
- Evidence: root `✗ review spec/order.md: 31 item(s)`, `✗ review src/: 1 contract(s)`. Dashboard 8/10/48 items and `tracker.ts: 3 of 282 … the 67 accepted earlier … no longer count`. Fullstack 15/17/17/20 items. `git log --all -- spec/src.lock.json` returns nothing.

**U2. The committed branch fails its own selftest**
`tools/selftest.ts:446`, `:451`; `tools/prove.ts:322`. Impact high, effort M.
- What: `checkNames` runs before the duplicate-name loop, so `lemma ProofLib()` is refused with a different message than the test expects. `twins.ts` now reports 3 of 4 not proved (step rests on bump), not 2 of 4. Main WIP fixes both, but against 1713136, and it conflicts with the 7 later commits (+123 selftest lines). The branch's checkVerifiedSource and Dafny-message hardening has no selftest case.
- Proposal: port main WIP onto this branch: move checkNames after the loop, change the regex to `3 of 4` with `[rests on bump:`, and bring the magic.md/forbidden.md cases (checkVerifiedSource, readVerdict, Std.*, rests-on). Do this before any other selftest change.
- Evidence: two failing tests, with the messages quoted in the finding. `grep -c checkVerifiedSource tools/selftest.ts` returns 0.

### Performance & caching

**P1. `quint typecheck` runs uncached, serially and synchronously on every check**
`tools/spec.ts:425` (loop 801). Impact high, effort S. Merges four findings; extends roadmap Speed 4.
- What: the IR depends only on `meaning` (prose is tangled into comments with lines kept, and `origins` come from the parsed spec), yet each check spawns one typecheck per spec, in sequence, through spawnSync. That blocks the event loop the runAsync pool needs. In the concurrent selftest, 91 typechecks stalled everything for 69 s of a 262 s run, and pure in-memory cases took 20 s.
- Proposal: (a) cache the error-free IR through `remembered(["ir", closure(imports) meanings, spec.meaning])` and keep writing gen/<name>.qnt. (b) On a miss, typecheck through runAsync, all specs concurrently, then call generate() in import order. Keep a sync `gen` for direct callers.
- Evidence: fullstack warm check 6.85 s, of which typechecks were 0.86 + 1.37 + 1.47 + 1.62 s. Concurrent typechecks take 2.36 s. Dashboard typechecks 0.4-1.9 s per spec. IR parse 2-11 ms.

**P2. Specs are simulated one at a time, and each spec's first run waits alone**
`tools/spec.ts:791/817/824-828`. Impact high, effort M. Merges three findings.
- What: the loop awaits each spec's whole simulation. Within a spec, the main `inv` run goes alone to avoid a race to install the Quint evaluator, which can only happen once per machine (`~/.quint/rust-evaluator-v0.7.1`).
- Proposal: phase 1 runs gen and imports each domain in import order. Phase 2 starts every spec's `remembered(simulate)` together and reports in spec order. Replace the per-spec gate with a once-per-process `evaluatorReady` promise, or call quint's `getRustEvaluatorPath()`.
- Evidence: fullstack cold simulations, in sequence: todo 0.46-2.13 s, client 2.62-7.63 s, server 8.21-23.79 s, system 24.57-31.74 s. The phase would be bounded by server, about 15.5 s, or about 7 s with P4. The gate's follow-up wave costs 1.1 s on root and 6.2 s on fullstack.

**P3. Guard-coverage searches run serially, each with the 200,000-sample budget**
`tools/spec.ts:874` (loop 868-881). Impact high, effort S.
- What: a guard that is never refused (common, and only informational) always uses the full WITNESS_SAMPLES.
- Proposal: collect the missing (guard, side) pairs, run them with `Promise.allSettled` through the pool, merge in guard order. Give the `refuses` side SAMPLES, and skip it under SPEC_QUICK.
- Evidence: a toy spec with 4 never-refused guards took 47.6 s, of which 43 s was these 4 serial searches. Concurrently it would take about 12 s.

**P4. Shard the main `inv` and `probe` runs across processes**
`tools/spec.ts:485`. Impact high, effort M.
- What: one `quint run` is CPU-bound on a single core (user time ≈ wall time even at `--n-threads 16`).
- Proposal: K = min(4, free slots) shards, each with SAMPLES/K samples, `--n-threads 1`, a per-shard seed from seedFor(…, k) and its own `--out-itf` directory. Merge the traces, and report `again` with the seed of the shard that broke. Total coverage and determinism stay the same.
- Evidence: server at 10,000 samples: real 17.05 s, user 17.08 s. Four shards of 2,500: 9.5 s wall under the same load. Fixed overhead about 1.4 CPU-s per shard.

**P5. Proof units with a proof file wait for every imported unit**
`tools/spec.ts:931`. Impact high, effort M.
- What: the units form a serial chain, todo → {client, server} → system, only to decide which laws to offer.
- Proposal: start all units at once, offering all imported laws. Keep a result when every offered law actually proved (the cache key `laws.join(" ")` is identical). Otherwise re-prove with the proved subset. Sound, because a result is reported only when its premises proved in this run.
- Evidence: fullstack cold proof stage takes 46.6 s in three levels (32.0-40.7, 40.7-54.7, 55.1-78.6 s). The floor is system's 23.4 s.

**P6. The proof stage starts only after every simulation** (extends roadmap Speed 1)
`tools/spec.ts:904`. Impact medium, effort M.
- Proposal: start a spec's proof unit when its own simulation result arrives, and start tsc right after phase-1 gen. Hold results in order, and discard them if an earlier spec fails.
- Evidence: fullstack cold, 309 s run: todo's simulation done at 7.9 s, first `lsc gen` at 152 s, proving from 152 to 308 s. Projected about 165 s, together with P2.

**P7. `--isolate-assertions` on every run costs 4.5-5x for the same verdict**
`tools/prove.ts:34` (used at 620). Impact high, effort M. Merges two findings.
- What: isolation only matters for attributing failures. Boogie verifies definitions independently, and recheck/restingOn already handle dependencies.
- Proposal: phase 1 runs `lsc check` without isolation. If there are 0 errors, done. Phase 2 re-verifies only failing or exhausted definitions with `--isolate-assertions --filter-symbol=<def>.`, through the pool, then runs readVerdict, recheck and restingOn as today. Update the comments at 7-12 and on RESOURCE_LIMIT. Add a selftest case where a non-isolated batch fails.
- Evidence: tracker with the review proof: isolated 121.5 s real (2493 verified, 2 errors), non-isolated 26-30 s (213 verified, the same 2 errors), phase 2 for one definition 11.1 s. With main WIP's proof: 519M → 99.7M resource units, 125.6 → 32.5 s user, largest batch 10.9M (under 30M). step_ensures 140.5M → 11.3M.

**P8. Every Dafny call on a Std-using unit pays about 4-6 s for Dafny's standard library**
`tools/prove.ts:593` (437, 520). Impact high, effort M.
- What: the generated code uses only `Std.Collections.Seq.{All,Filter,FoldLeft}`, but resolve and audit process all 18,500 library lines, and audit then reports 81 findings that are filtered out.
- Proposal: write `"dafny-library": "local"` in the generated lemmascript.json (LemmaScript 0.6.8 supports it and emits SeqFilter/SeqAll/SeqFoldLeft). Bridge ProofLib.Filter to the local helper, update checkNames, and re-check the example proof files. A cheaper first step is to remap Std only for `audit`.
- Evidence: todo.dfy verify 7.6 s wall with Std, 2.5-3.4 s local. Audit 6.6 s with Std, 0.85 s local. Resolve 4.37 CPU-s with Std, 0.38 without.

**P9. The whole ProofLib is re-verified in every unit that has a proof file**
`tools/prove.ts:611`. Impact medium, effort S.
- What: 318 batches and 8.2M resource units per unit. kernel uses one lemma, which is 97% of its resource units. todo uses no lemma at all.
- Proposal: splice only the closure of the `ProofLib.X` names the proof file reaches (checkNames already extracts them). Splice nothing when the file names none. (Main WIP already deletes the two unused lemmas.)
- Evidence: about 57M resource units of repeated library verification across the 7 proof-file units on a cold check.

**P10. The generated `step_ensures` should hide definitions it does not need**
`tools/prove.ts:579` (stepBody 571-583). Impact medium, effort S.
- Proposal: begin the generated body with `hide *; reveal step, inv;`. Hiding only removes facts, so it stays sound.
- Evidence: system 50 VCs / 18.1M → 2 / 0.2M (19% of that unit). client 2.1M → 0.2M, order 1.6M → 0.1M. Audit findings unchanged.

**P11. Per-definition proof caching: a concrete design** (extends roadmap Speed 2)
`tools/prove.ts:311` (267, 347, 490-498). Impact medium, effort L.
- What: only the last `--filter-symbol` takes effect, a filtered run has a fixed cost of about 4 s, and DEFINITION gives `datatype`/`type`/`const` no region of their own, so a closure built from mentions would miss datatype edits.
- Proposal: start a region at every DECLARATION. Key each generated definition on sha(toolchain incl. z3, flags, the lsc options header, its region and its mention-closure regions). Store verdicts in `.spec-cache/dafny/`. Run up to about 8 missing definitions one filter each, and otherwise a full phase-1 run. Then merge, recheck and run restingOn as today.
- Evidence: the filter test (A, C → only C verified), a 3.8-4.05 s filtered no-op, and the full isolated run at 121.5 s.

**P12. `recheck` copies postconditions that cannot have relied on the failure**
`tools/prove.ts:461`. Impact low, effort S.
- Proposal: when every failure is on an ensures line, copy only the ensures after the first failed one. Skip definitions that `restingOn` will mark unproved anyway, which means calling restingOn first; it gives the same result.
- Evidence: tracker 26 copies → 6. The recheck run took 21.9 s.

**P13. The pool counts each Dafny process as one slot, but Dafny uses 8 cores by default**
`tools/prove.ts:81` (34, 437). Impact low, effort S. Merges two findings.
- Proposal: a weighted `acquire(n)`. Each Dafny verify takes k slots and runs with `--cores k`.
- Evidence: during a selftest run, 13 Dafny and 22 z3 processes were live at load 54-76 on 16 cores.

**P14. List parameters are sampled from a fully built set of all pairs**
`tools/gen/harness.ts:24`. Impact high, effort S.
- What: |E|² lists are built for every pick (65,536 for `List[Set[int]]`). Lists never exceed length 2, and P(empty) is about 1.5e-5.
- Proposal: independent picks `p__0`, `p__1`, `p__2` (add `__\d+$` to GENERATED), then `nondet xs = Set(List(), List(p__0), …).oneOf()`. The pick is still recorded as `xs`, so readTrace is unchanged.
- Evidence: 15 → 1942 traces/s. One witness search goes from about 3.7 h to minutes.

**P15. Failing simulation results are never cached**
`tools/spec.ts:895`. Impact medium, effort S.
- Proposal: keep every result except "the simulator could not run". The seed is deterministic and part of the key.
- Evidence: an unreachable goal, unchanged inputs: 72.1 s then 92.6 s. A passing spec re-checks in about 1 s. This matters most when saving src/ or test/ in watch.

**P16. Cache GC deletes the other budget's entries, so QUICK and full runs thrash**
`tools/spec.ts:1019`. Impact medium, effort S. Merges two findings.
- Proposal: age-based GC (touch on hit, evict entries unused for about 7 days), or evict only entries with this profile's prefix.
- Evidence: full warm check 5.05 s (0 quint runs) → QUICK 15.7 s → full again 63.1 s with 17 quint runs. Main WIP drops the SPEC_SEED half of the key, but not the QUICK half.

**P17. One toolchain id keys everything: Dafny, LemmaScript, lib.dfy and prove.ts changes invalidate simulations**
`tools/spec.ts:380-388`. Impact medium, effort S. Merges three findings.
- What: editing lib.dfy, which CONTRIBUTING invites, re-simulates every spec (dashboard 4 min 33 s). A synchronous `dafny --version` (0.1-0.94 s) runs before any cache read on every check.
- Proposal: `toolchainId(stage)`. "simulate" covers quint, spec.ts, gen.ts and gen/**. "prove" adds lsc, dafny, z3, prove.ts and the lib closure, and the lib text goes into the prove key only for units with a proof file. Cache the dafny version by `{realpath, size, mtime}`, or start it concurrently.

**P18. Comments inside quint blocks are part of `meaning`; three comment strippers disagree**
`tools/spec.ts:89` (128, 190, 195). Impact low, effort S.
- Proposal: `codeOnly(text)` built on `scan()` (blank out non-code, keep newlines). Use it for `meaning`, `mentions` and `defines`, and keep the review fingerprint as it is. This also fixes `defines`' handling of `//` inside strings and of `/* */`.
- Evidence: a comment-only edit costs about 30 s of re-simulation on the order example (33 s cold, about 3 s warm).

**P19. The types stage runs a full `tsc --noEmit` on every check**
`tools/spec.ts:999`. Impact low, effort S.
- Proposal: `--incremental --tsBuildInfoFile .spec-cache/tsbuildinfo` (add it to `used`), or skip tsc when the hashes of `--listFiles` are unchanged. In watch, keep a builder program in the process.
- Evidence: 0.61-0.97 s of a 1.2-1.7 s warm root check. Incremental: 1.8 → 1.0 CPU-s.

**P20. The root tsconfig puts tools/ in the user-facing types stage**
`tsconfig.json:12`. Impact low, effort S.
- What: the stage typechecks the tools and the TypeScript compiler's declarations, which differs from what `spec init` installs, and a tool type error is reported as "application does not fit".
- Proposal: use the same include as init, plus `tsconfig.tools.json` and a `typecheck:tools` script in the selftest job.
- Evidence: 4.9/4.0 s → 1.9/2.2 s (193 → 183 files).

**P21. Generated modules are imported even on a cache hit, and watch never frees them**
`tools/spec.ts:804`. Impact low, effort S.
- Proposal: a lazy, memoised `loadDomain()` inside produce().
- Evidence: RSS 46 → 130 MB after 100 watch-style reloads. About 210 ms of ESM loading per warm check.

**P22. One check reads `spec/order.lock.json` 51 times and walks src/ 5 times**
`tools/spec.ts:292`. Impact low, effort S. Proposal: memoise locks per check and compute `srcUnits` once in checkLocked.

**P23. Every CLI invocation loads TypeScript (about 0.5 s)**
`tools/spec.ts:23`. Impact low, effort S.
- Proposal: lazy `await import("typescript")` inside the src-unit checks, and optionally a `dist/cli.js` that enables Node's compile cache.
- Evidence: `spec help` takes 0.55-0.70 s against 0.03 s for bare node, and 0.26 s with the compile cache. `prepare` pays this on every `npm install`.

**P24. `append`/`concat` chains print as nested spreads**
`tools/gen/print.ts:152`. Impact low, effort S.
- Proposal: flatten the chain to one literal `[...a, ...b, x]`, as `flat()` already does for and/or.
- Evidence: 6 levels deep in tracker `problemsOf`. 249 ms → 177 ms in a micro-benchmark.

**P25. CI (main WIP) restores neither `.spec-cache` nor `~/.quint`**
`.github/workflows/check.yml:13` (main tree). Impact medium, effort S.
- What: every run is cold, and every run downloads Quint's evaluator through an unauthenticated GitHub API call (60 per hour per IP, shared between runners).
- Proposal: `actions/cache` for `~/.quint`, keyed on the quint version, and for `**/.spec-cache` with restore-keys. Entries are content-addressed, so a partial restore is safe.
- Evidence: root cold 36.5 s, warm 12.0 s. binaryManager.js:182 calls the API with no token.

### Simplification & deduplication

**D0. Proposed module layout** (extends roadmap Correctness 1, with concrete boundaries)
`tools/spec.ts:766` (checkLocked runs from 766 to 1048, and the body of `provingAll` at 907-997 is mis-indented). Impact low, effort M. Merges split-checklocked and util-module-layout.

```
tools/
  util.ts       filesUnder(root, dir, test), resolveDep(name, root) -> {dir, version},
                readJson, writeLedgerFile(file, entries) (deletes when empty),
                plainText (B27), codeOnly/scan (P18), indent, sha/short, fail
  run.ts        tool(), runAsync (timeout, cap, finally-release), run() wrapper, slot pool (B23, P13)
  simulate.ts   readTrace, simulate, replay, firstBreak, showTrace,
                simulateSpec(root, spec, model, loadDomain, cite, budget), guardCoverage()
  units.ts      proofUnits, checkVerifiedSource, strayProofFiles, ledger,
                proveAll(root, models, accept, used)
  review.ts     parse-side review: pending, dependencies, accept*, contracts, reviewStage()
  init.ts       init, starter, newSpec
  spec.ts       parseSpec, gen, CLI, checkLocked ≈ 60 lines:
                gen all → simulate all → (types ∥ proofs) → tests → GC → review
  prove.ts      Dafny-specific only
```

- `resolveDep` fixes a real divergence. `bin()` (prove.ts:49) also searches the project root, while `version()` (spec.ts:371-377) searches only from tools/. A project-resolved quint or lsc therefore enters the cache key with no version.
- The roadmap counts 2 ledger writers and 3 listings. There are 3 writers (313, 348-350, 682-685), 3 readers (266, 335, 674) and 4 recursive listings (325, 380, 661, 1009).
- Several items above (B24, P2, P6, P21) only become clean changes after this split, because they share checkLocked's locals.

**D1. Five regexes read Dafny declarations, the output tail is copied 4 times, the base args twice** (extends roadmap)
`tools/prove.ts:267` (253, 311, 353/608, 451; tails 478/525/602/624; args 437/520). Impact low, effort S.
- Proposal: one `declarations(dfy) -> {kind,name,line,attrs}[]`, plus `tail(out, fallback)` and `baseArgs(dfy)`. Latent bug: checkNames' regex at 253 does not skip `{:attr}`, so an attributed lib lemma would be refused.

**D2. A unit's proof paths are derived in three places**
`tools/spec.ts:950` (prove.ts:585-586, 611; spec.ts:973, 975). Impact low, effort S. Proposal: an exported `proofPaths(unit)`.

**D3. `Model` restates `Roles`, has two stacked stale JSDoc blocks, and re-spells ProofLib**
`tools/gen.ts:18` (21-22, 37-38, TAKEN 64). Impact low, effort S.
- Proposal: `interface Model extends Roles`, delete the stale comments, import LIB_MODULE, and print `path.relative(pkgRoot, LIB_FILE)`.

**D4. Exports with no importer, and two fields computed but never read**
`tools/prove.ts:290` and others. Impact low, effort S.
- What: Additions, LIB_MODULE, RESOURCE_LIMIT, declaredNames, lawAxiom, stepBody, badSpecName, fingerprint, nextStep, newSpec, Scope and Source have no importer. `Unit.src` and `Proof.resting` are produced but only main WIP reads them.
- Proposal: drop the exports, and merge main WIP's consumers of the two fields.

**D5. Every generated module carries the JSON-clone try/catch twice**
`tools/gen/typescript.ts:89` (and 108). Impact low, effort S. Proposal: one `//@ skip` `plain()` helper, added to TAKEN.

**D6. `expandListHelpers`' JSDoc is attached to `scan`**
`tools/spec.ts:122`. Impact low, effort S. Proposal: move lines 122-126 above line 145.

**D7. The same compilerOptions are written in four places**
`tsconfig.build.json:1` (spec.ts:1121, both examples). Impact low, effort S.
- Proposal: make the build config `extends` tsconfig.json. Export init's tsconfig as a constant and assert in the selftest that both examples equal it.

### Capability for larger apps

**C1. The probe compares each definition only 1-51 times**
`tools/gen/harness.ts:91`. Impact medium, effort L.
- What: `any { step, any { eval_* } }` gives each of N definitions 1/(2N) of the steps. For tracker (N=72), `eval_relate` is evaluated once, and 3 of the eval actions are never evaluated.
- Proposal: a single `eval_all` action that sets `outAll' = { d1: OSome(...), x: if (canX) OSome(...) else ONone, … }`, with per-definition parameter names. The witness invariants read `outAll.g`. This also removes the per-definition Out sum type.
- Evidence: a prototype typechecks. Cost per trace is 4.1x for 72x the evaluations of each definition.

**C2. Record and tagged-union parameters have no default sampler**
`tools/gen/harness.ts:28`; example side `examples/dashboard/spec/tracker.md:57`. Impact medium, effort M. Merges two findings.
- What: 8 central tracker helpers (problemsOf, notesFor, …) are never compared on their own, and fullstack hand-writes 7 record sample sets.
- Proposal: (1) when the parameter type is the element type of a state List/Set field, sample from the reachable state (`state.tasks.indices().map(…).oneOf()`). (2) Otherwise build the value from one nondet pick per field. Short term, the dashboard can add `tValues: Set[Task]` and Problem samples.
- Evidence: the replay line lists the 8 names. A prototype `eval_knownOwners2` runs at 986 traces/s.

**C3. Support Quint `slice` and `replaceAt`** (extends roadmap Language 7)
`tools/gen/print.ts:158`. Impact medium, effort S.
- Proposal: map them to `.slice(a,b)` and `.with(i,x)` (es2023). LemmaScript lowers these to `xs[a..b]` and `xs[i := x]`, so remove-the-i-th becomes `slice + concat` with no fold lemma.
- Evidence: hand-written equivalents pass lsc and Dafny ("7 verified, 0 errors").

**C4. `==` on sets of simple values is refused, and the error says "records or lists"** (extends roadmap Language 6)
`tools/gen/print.ts:110`. Impact low, effort S.
- Proposal: print `A.length === B.length && A.every(x => B.includes(x))`, and make the scalarOnly message name the actual kind.

**C5. `val` inside a lambda body is refused**
`tools/gen/print.ts:101`. Impact low, effort S.
- Proposal: emit a block-bodied arrow from `body()` (LemmaScript lowers it to `var y := …; e`). Evidence: "2 verified, 0 errors".

**C6. Generate the Seq.Filter → ProofLib.Filter bridge lemmas**
`tools/prove.ts:320`. Impact medium, effort M.
- What: 11 such lemmas are written by hand with empty bodies (server, client, projects, tracker), and they break whenever a lambda changes.
- Proposal: add a generated `<fn>_filter` lemma for every generated function whose body contains `Std.Collections.Seq.Filter(`, in a generated region and proved by Dafny. Update CONTRIBUTING.md:256-259.

**C7. Proof files repeat 370 generated `ensures` lines, and one new rule makes a unit uncheckable**
`tools/prove.ts:328`. Impact medium, effort S.
- Proposal: accept a signature-only `lemma x_ensures(params) { … }`, compare its parameters, and splice the body under the current header. Keep refusing explicit headers that differ.
- Evidence: tracker has 280 ensures lines (14% of the file). An old header fails with "refused as stale", and none of the 282 obligations are attempted.

**C8. Rules that hold in every state are invoked by hand in all 20 transition proofs**
`examples/dashboard/spec/tracker.proof.dfy:22`. Impact low, effort M.
- Proposal: a tools convention. A proof-file lemma `<rule>_holds(s)` with no requires is called automatically on the after-state of every generated transition body. It only adds a call, so it is sound.
- Evidence: TWarningList(s2) and TNoOneToldTwice(s2) are each called 20 times, TUniqueBridge 19 and 18 times.

**C9. Generate a `refusal(state, event)` that names the rule that refused**
`src/app.ts:20`. Impact medium, effort M.
- What: "submit is not allowed for a Draft order" is false for a non-empty draft, and "pay … Pending" is false for an overpayment.
- Proposal: a generated `refusal()` returns the heading of the first false rule-helper the guard calls, falling back to the guard's own heading. The shell becomes `const why = refusal(o,e); if (why) throw new Rejected(why)`.
- Evidence: `node src/demo.ts` output. Main WIP changes only the arrows.

### Examples

*Order (root)*

**E1. The step rule "No payment is taken while on hold" forbids refunds too**
`spec/order.md:240`. Impact low, effort S.
- Proposal: either weaken the Quint to `after.paid <= before.paid`, or retitle the rule to "Nothing paid changes while on hold".
- Evidence: allowing cancel from OnHold breaks this rule on a refund trace.

**E2. The Cancel story promises more than the guard allows: an order on hold cannot be cancelled**
`spec/order.md:121` (story at 115-116). Impact low, effort S.
- Proposal: ask the user which is intended. Either allow OnHold in `canCancel` (together with E1a), or add a prose line saying the shopper can neither pay nor cancel while an order is on hold.

**E3. `OrderBook` replays the whole log on every get or dispatch**
`src/app.ts:11`. Impact low, effort S.
- Proposal: store `{events, order}`, step once per dispatch, and keep `replay` for loading.
- Evidence: 2000/4000/8000 dispatches take 119/768/2866 ms. Main WIP halves this but it is still quadratic.

**E4. The shell never loads, so replay's skip path and `parseState` are never exercised**
`src/app.ts:7`. Impact low, effort M.
- Proposal: `OrderBook.load(stored)` runs each item through `parseEvent` and then `replay`, plus `save()`. Add a test with a forged `pay 1e6` and a malformed entry.

*Dashboard*

**E5. `renameOwner` leaves `updatedBy` on the old name, so a renamed editor is told about their own edit**
`examples/dashboard/spec/tracker.md:296`. Impact medium, effort S.
- Proposal: map `updatedBy` in renameOwner too. Add `by` to Note and the rule `alwaysNoOneIsToldOfTheirOwnEdit`, and check that it fails before the fix.
- Evidence: the generated-TypeScript run sends an Update to "ama", who was formerly ben.

**E6. Laws in 3 of 5 kernel stories (and projectFor's) are satisfied by a function that does nothing**
`examples/dashboard/spec/kernel.md:62`. Impact medium, effort S.
- Proposal: add completeness laws: a due reminder is sent, a settled edit is due, old versus recent requests for isFresh, and a sole claimant is found. Add `sometimesAHeadsUpGoesOut`.
- Evidence: with reminderFor = `NoReminder`, editIsDue = `false` and isFresh = `false`, model, always and replay all pass.

**E7. Two `always` rules hold in every state and are re-proved for every transition**
`examples/dashboard/spec/tracker.md:142` (437). Impact low, effort M.
- Proposal: turn them into laws (after B17, so the warning-list law is still simulated on reachable states), and tell the user which rules change kind. This saves about 41 obligations and 42 lemma calls.

**E8. The shell has no way to get one pass's notes, and paging, freshness, the registry and parseEvent are never used**
`examples/dashboard/test/notify.test.ts:18`. Impact medium, effort M.
- What: `send(s.sent, …)` resends the whole history after the first pass. Notes are recorded before they are posted, which makes delivery at-most-once and is not documented.
- Proposal: `dueNotes(s)` in the spec. `pass(s)` posts first and then persists. Add a second-pass test. Optionally add `src/command.ts` that uses parseEvent, enabled, projectFor, pageStart and isFresh, or else drop those stories. Main WIP keeps `send(s.sent, …)`.

**E9. `columnDigits`' proved contract is satisfied by `return [0]`, and nothing tests `columnName`**
`examples/dashboard/src/columns.ts:9`. Impact low, effort S.
- Proposal: test/columns.test.ts covering 0→A, 25→Z, 26→AA, 27→AB, 701→ZZ and 702→AAA. Strengthen the ensures where LemmaScript allows it.

**E10. The uniqueness-kept-by-append/filter/map proof is hand-written 8 times in 4 files**
`examples/fullstack/spec/server.proof.dfy:19`. Impact low, effort M.
- Proposal: add `FilterAppendFresh` and `FilterAppendOnly` (prototyped, verified) and `DistinctByPointwise` to ProofLib. OnceAppend shrinks from 26 to 14 lines.

**E11. Eight generic lemmas live in tracker.proof.dfy, and one subsumes a ProofLib lemma**
`examples/dashboard/spec/tracker.proof.dfy:906`. Impact low, effort S.
- Proposal: move them to lib.dfy, and make FilterOfFilterShorter and FilterLengthPointwise corollaries. Do this after P17, so it does not trigger a full re-simulation.

**E12. Three tracker helpers duplicate others in the same file**
`examples/dashboard/spec/tracker.proof.dfy:849` (1157, 744/1380, 863). Impact low, effort S. About 35 lines less.

*Fullstack*

**E13. The server re-checks `inv` on every request, which is O(n²) per request**
`examples/fullstack/src/server.ts:50`. Impact high, effort S. Merges two findings.
- Proposal: drop the check, run it only under a debug flag, or check once at startup. The proof already covers it (29/29 obligations). Optionally keep a shell Map keyed by client:seq for retries.
- Evidence: blocks of 1000 creates took 631 / 5728 / 17949 / 34386 ms with the check and 19 / 51 / 64 / 84 ms without. inv alone takes 97 ms at a log of 2000.

**E14. Retries are recognised by (client, seq) alone, so a forged request gets ok for an edit that was never applied** (extends roadmap Language 14)
`examples/fullstack/src/server.ts:38`. Impact high, effort M.
- What: the server returns the logged answer without comparing the edit. `Answered.version` is written but never read.
- Proposal: replace `version` with `op`, and treat a request as a retry only when the op is equal. Add `alwaysARetryIsTheSameEdit`, a `forge` adversary transition in system.md, and `alwaysAnAcknowledgedEditWasApplied`.
- Evidence: a squat on tab1/seq 1, then the real "milk" create returns `ok:true`, and milk is not in the list.

**E15. POST /api/events accepts the server-internal `refuse` event**
`examples/fullstack/src/server.ts:39` (protocol.ts:6). Impact medium, effort S.
- Proposal: `Request = Exclude<Event, {type:"refuse"}>`, answer 400 for it, and add a test.
- Evidence: a pre-sent refuse for b/seq 1 makes b's genuine create return `ok:false`.

**E16. The page sends its whole queue at once, so a lone user's edits can be reordered and refused**
`examples/fullstack/src/web/app.ts:51`. Impact high, effort M.
- Proposal: keep at most one request in flight, as Tab already does. Mirror that in system.md (lines 92, 105, 111-112) and add `alwaysALoneUsersEditIsNeverRefused`. The alternative is server-side ordering.
- Evidence: the witness `sometimesALoneUsersEditIsRefused` is reachable now. With head-only sending, the `always` version holds in 12,000 traces.

**E17. The push stream is never reopened**
`examples/fullstack/src/web/sync.ts:33`. Impact medium, effort S.
- Proposal: reconnect with backoff (500 ms up to 10 s), optionally with a server ping, and an e2e test using `closeAllConnections()`.
- Evidence: after a drop, the server is at version 1 and the tab still shows 0.

**E18. Server answers and pushes reach the client's `step` without `parseEvent`**
`examples/fullstack/src/web/sync.ts:19` (28-29, 46-48). Impact medium, effort S.
- Proposal: have the server send client events directly, and parse them with the client `parseEvent`, checking the seq. Derive the wire types from gen/client.ts. Make `fetchSnapshot` check `res.ok` and catch errors.
- Evidence: `receiveSnapshot` with `version:"9"` gives a string `seen`, and `inv` still returns true.

**E19. The page and the tested `Tab` each implement the sync policy, and the Op→event mapping is copied twice**
`examples/fullstack/src/web/sync.ts:84` (app.ts:47-65; protocol.ts:15-22; sync.ts:29/48). Impact medium, effort M. Merges two findings; extends roadmap Language 14.
- Proposal: one framework-free `Outbox` used by both app.ts and Tab, so the e2e test covers shipped code. Export `opEvent` and `snapshotEvent` from protocol.ts, and drop the unreachable `return undefined` and its guard.

**E20. The retry timer uses a stale `retry` value**
`examples/fullstack/src/web/app.ts:57`. Impact low, effort S. Proposal: `setRetry(r => r + 1)` and widen the setter type.

**E21. Drop the "spell records out, string kinds" workaround: `Todo`/`Op` and a `Kind` variant pass every stage**
`examples/fullstack/spec/todo.md:27`. Impact medium, effort S.
- Proposal: use `List[Todo]` and `op: Op` in server.md and client.md, and `type Kind = Create | SetDone | Rename | Remove`. Delete `isKind` and the extra branch. Patch 10 Dafny literal sites, src/test, and README:76-87.
- Evidence: both steps pass every stage (120 obligations). The generated `Kind` union makes protocol.ts's switch exhaustive.

**E22. One `commit(s, client, seq, op)` transition can replace the server's four**
`examples/fullstack/spec/server.md:70`. Impact medium, effort S.
- Proposal: build on E21, and add a `create x` sample to `opValues`.
- Evidence: 29 obligations become 14. server.md 190→172 lines, server.proof.dfy 216→178, protocol.ts 23→17. All stages pass.

**E23. Two system stories promise "nothing lost" and "applied once" but have no rules**
`examples/fullstack/spec/system.md:79` (119). Impact medium, effort M.
- Proposal: add `stepAnEditLeavesTheQueueOnlyOnceAnswered`, `alwaysEveryRequestWasNumberedByItsTab`, `alwaysTheServerAnsweredOnlyNumberedEdits` and `alwaysNoTabShowsAToDoTwice`, with outlined proofs. All four hold in 12,000 traces.

**E24. The system model pushes only to the other tab and has no snapshot fetch**
`examples/fullstack/spec/system.md:138`. Impact medium, effort M.
- Proposal: push to every tab and add a `fetch` transition. Simulation still holds. Update "How the halves fit" in the README.

**E25. `alwaysEachPartKeepsItsRules` lists 11 conjuncts that `rulesHold` already defines**
`examples/fullstack/spec/system.md:187`. Impact low, effort S.
- Proposal: `S::rulesHold(sys.server) and C::rulesHold(sys.a) and C::rulesHold(sys.b)`. The system proof is unchanged (34 obligations).

**E26. Replay never compares the shared edit semantics because parameter names do not match the sample sets**
`examples/fullstack/spec/todo.md:66`. Impact low, effort S.
- Proposal: rename `todos`→`xs` and `op`→`change` in todo.md. Directly compared definitions go from 4 to 9, with no proof changes.

### Tests

**T1. The two slowest cases await independent checks one after another**
`tools/selftest.ts:389` (253-280, 367, 203, 196, 484, 456). Impact high, effort S.
- Proposal: `Promise.all` over independent roots, or split them into separate `test()`s.
- Evidence: induction 329 s and shop 323 s, against a suite wall time of 340 s with 1302 s user (about 3.8 of 16 cores busy). The expected suite wall time is 150-200 s.

**T2. Negative-search cases spend the full 200,000-trace budget** (extends roadmap Speed 3)
`tools/selftest.ts:101` (106, 113). Impact medium, effort M.
- Proposal: after B24, pass `{quick:true}` to cases that assert unreachability or only assert later stages. These cases take 196, 172 and 156 s. Cold order: 30 s full, 21 s quick.

**T3. About 17 documented generator refusals have no test case**
`tools/selftest.ts:155`. Impact medium, effort S.
- Proposal: one table row per message, calling `gen()` inside `assert.throws` (about 1.5 s each). Fix B30 first; probing for this finding is what found it. A ready table is in the scratchpad: `/private/tmp/claude-501/-Users-shawwalters--claude-spares-spare-1yXWAd/90342b26-4c55-4db9-a666-537d42d7e1f5/scratchpad/probe/refusals.ts`.

**T4. Pipeline refusals and claims have no test case**
`tools/selftest.ts:196`. Impact medium, effort M.
- What: a misplaced or unclosed quint block, `import()` in verified code, two generated imports, a unit-name collision (`src/a-b.ts` against `src/a/b.ts`), a missing spec import, "no specs", the stale-ledger hint, and "accept ignores SPEC_QUICK" (run as child processes).
- Evidence: grep finds none of these messages in either tree's selftest.

**T5. The "broken on the way to a sometimes goal" case does not exercise the witness path, and line 193 is a tautology**
`tools/selftest.ts:188`. Impact medium, effort S.
- Proposal: delete line 193. Assert the generated `never_sometimesFour` and run it directly, or construct a break that only the witness search can reach.
- Evidence: the plain `inv` simulation finds the break within 33 traces.

**T6. Duplicate and review-only cases each pay for a cold check**
`tools/selftest.ts:243` (183, 248, 133, 473). Impact low, effort S.
- Proposal: delete 243 and 248, make 183 a parseSpec assertion, and move the status assertions into the pure `pending()` case at 526, adding the never-asserted statuses ("not formalized", "prose and model both changed", "new story"). Parts are already addressed in main WIP.

**T7. 40 cases anchor exact strings in the live demo project**
`tools/selftest.ts:49`. Impact medium, effort M.
- Proposal: freeze a copy at `tools/fixtures/order/`, and pass `{app:true}` only for cases that need test/ and tsconfig.json. That removes about 25 tsc and `node --test` runs. Main WIP is editing src/app.ts and test/app.test.ts right now, which shows how fragile the current setup is.

**T8. No case checks that a warm cache is invalidated by an import or proof-file change**
`tools/selftest.ts:272`. Impact medium, effort S.
- Proposal: reuse `plain`'s root with a wrong lib law and `proved`'s root with an `assume false` proof file, and assert the failures. This also saves two fresh roots.

**T9. No selftest exercises `recheck`**
`tools/prove.ts:444`. Impact medium, effort M.
- Proposal: extract `isolatedCopies(spliced, failing)` and unit-test it, including the B19 fail-closed cases. Add one end-to-end fixture where the second of two `always` rules follows from the first.

**T10. Nothing tests the packaged command**
`tools/selftest.ts:493`. Impact medium, effort M.
- Proposal: build, then run `dist/spec.js init/new/check --json` in a temp directory with `"type":"commonjs"`. Assert the scripts and stage results, and optionally the `npm pack --dry-run` file list. This would catch K1 and O4.

**T11. CI (main WIP) skips the selftest when its inputs change, and never checks fullstack**
`.github/workflows/check.yml:31` (main tree). Impact medium, effort S.
- Proposal: add `spec/**`, `src/**`, `test/**`, tsconfig.json, AGENTS.md, CONTRIBUTING.md and `.claude/skills/**` to the paths filter, or drop the filter. Run the check as a matrix over `.`, `examples/dashboard` and `examples/fullstack` once U1 lands.

**T12. The order shell tests mostly re-check proved behaviour**
`test/app.test.ts:5`. Impact low, effort S.
- Proposal: test independent ids, a table of rejections with an unchanged log and the message (after C9), hold → pay rejected → release, and unknown ids. Merge the tests of outcomes that `step` already guarantees.

### Docs

**O1. The sync skill names 4 of the 12 review statuses**
`.claude/skills/sync/SKILL.md:32` (table 48-70). Impact high, effort S.
- What: story, contract and "removed or renamed" statuses have no row, so an agent never satisfies step 3. "(what it relies on was not recorded before)" is explained nowhere, so agents rewrite prose that is still correct.
- Proposal: step 3 becomes "every review item other than `story has no rules` and `not formalized`". Add the rows (main WIP has most of them) and a "not recorded before" row: nothing changed, report it for accept. Fix README:85 and add spec/src.lock.json to the paths table.

**O2. Main WIP's AGENTS.md drops the onespec markers that `init()` requires**
`AGENTS.md:3` (spec.ts:1092-1093). Impact high, effort M.
- What: merged as it stands, `spec init` would throw. Moving it inside the markers would instead install repo-only "Writing code" and selftest rules into users' projects. Main WIP's README also regresses 12,000 to 10,000 traces and drops `npm run watch` and fullstack.
- Proposal: keep the markers, put the spec wording inside them and the repo rules after `onespec:end`, and add a selftest case that runs init() against the repo's own AGENTS.md.

**O3. The CONTRIBUTING.md that `init` installs points at repo-only files**
`CONTRIBUTING.md:232` (8, 9, 77, 82, 188, 224, 273, 309, 318, 406-425). Impact medium, effort M.
- Proposal: say where the library is from the reader's side ("the end of gen/proof/<unit>/<unit>.dfy"). Move "Changing the tools" and the walkthroughs to a repo-only docs/tools.md, or cut them when installing, using the AGENTS.md marker technique. Main WIP keeps the `tools/proof/lib.dfy` reference.

**O4. The AGENTS table documents `npm run watch`, but init adds only check, gen and accept; `spec new` is undocumented**
`tools/spec.ts:1130`; `AGENTS.md:36`. Impact medium, effort S. Merges two findings.
- Proposal: add `watch` and `new` scripts at spec.ts:1130 and to examples/dashboard/package.json, and assert them in the init selftest. Document `npm run new -- <name>` in AGENTS.md and SKILL.md:18. Fix CONTRIBUTING:358 (no design skill listed) and :420 (`{ok, results, next}`), and the spec.ts:12 header.

**O5. The definition of done cannot be met when an event needs more than 20 steps**
`AGENTS.md:70`. Impact low, effort S.
- Proposal: allow a "`sometimes … never happened` shown to need more than 20 events" line at stop, in both AGENTS.md and SKILL.md. Longer term, per-spec `steps` (extends roadmap Language 5).

**O6. Hard-coded example counts are wrong**
`README.md:119` (131); `examples/fullstack/README.md:50`. Impact medium, effort S. Merges two findings.
- What: the READMEs say 124 obligations where the check proves 120, and "15 always and step rules" where there are 17. Fullstack README:78-87 describes a fixed bug as a current workaround, README:104-105 explains a helper that E22 removes, and README:42-44 calls resending the queue harmless, which E16 shows it is not.
- Proposal: correct the numbers, or have a test assert them. Rewrite "Limits" to keep only the limits that still apply.

**O7. The roadmap lists SPEC_QUICK and `spec watch` as not done, and gives spec.ts as 750 lines (it is 1,280)**
`docs/roadmap.md:113-121`. Impact low, effort S. Merges three findings.
- Proposal: move both to Done, and reword Speed 4 to what is still missing (P1, P19). Date the speed table, or replace it with a `SPEC_TIMING=1` breakdown. Measured at low load: root 6.8 s cold and 1.2 s warm, fullstack 78.9 s cold and 6.9 s warm.

**O8. writeup.html is linked from nowhere and contradicts the tools in nine places**
`writeup.html:90`. Impact low, effort M.
- Examples: "1,400 lines in two files", 77 obligations, 31 cases, "one sequential state machine". Main WIP's rewrite addresses this, but its 10,000 should be 12,000. Then link it or move it to docs/.

**O9. The skill says to run the check from examples/dashboard, which fails without a separate install**
`.claude/skills/sync/SKILL.md:43`. Impact low, effort S.
- Proposal: use `node ../../tools/spec.ts` scripts, as fullstack does, or point to `npm run check:dashboard`. Write `npx --no-install spec init`.

**O10. "SPEC_NO_CACHE=1 … new random traces" is false on this branch**
`AGENTS.md:41` (CONTRIBUTING:388-389, README:164; seedFor at spec.ts:479). Impact low, effort S.
- Proposal: adopt main WIP's random seed under SPEC_NO_CACHE, or fix the three doc lines. Either way, document SPEC_SEED or remove it.

**O11. The same agent and caching explanations appear in 4-5 docs loaded into the same context**
`CONTRIBUTING.md:339`. Impact low, effort S.
- Proposal: one home per topic. Carry main WIP's removals over (parts (a) and (b) are addressed there). Collapse CONTRIBUTING:385-389 into one sentence.

### Packaging

**K1. In a consumer whose package.json has `"type":"commonjs"`, every spec fails the model stage**
`tools/spec.ts:785` (import at 804; init 1127-1136). Impact high, effort S.
- What: npm 11's `npm init -y` writes that type. The generated `.ts` file is then loaded as CommonJS: `✗ model spec/lamp.md is not a valid model / Unexpected token 'export'`.
- Proposal: write `gen/package.json` `{"type":"module"}` after the `rmSync`, and in `gen()`. Have init set `"type":"module"` when it is missing and warn when it is commonjs. Covered by T10.
- Evidence: patching dist to do this makes every stage pass. Not fixed by main WIP.

**K2. The tsconfig that init writes needs `@types/node`, which consumers get only by accident**
`tools/spec.ts:1121`. Impact medium, effort S.
- What: in the test consumer it arrived through quint → protobufjs as @types/node@26 on a Node 24 engine.
- Proposal: init adds `@types/node@^24` to the consumer's devDependencies when it is missing, or onespec lists it as a dependency.

**K3. examples/dashboard: the README's `npm install` fails on a fresh clone, and `check` runs a stale dist/**
`examples/dashboard/package.json:14`. Impact medium, effort S.
- Proposal: use `node ../../tools/spec.ts …` scripts like fullstack and drop `file:../..`. Otherwise add a root-install note and a `precheck` build.
- Evidence: `sh: tsc: command not found` (exit 127) from the root's `prepare`.

**K4. LemmaScript pulls in claimcheck (Anthropic, Bedrock and Vertex SDKs), more than half of node_modules**
`package.json:35`. Impact low, effort S.
- Proposal: an `overrides` stub for this repo, a documented override for consumers, and an upstream request to make it an optional or peer dependency.
- Evidence: 177 MB becomes 80 MB, and every stage still passes.

**K5. package-lock.json still describes "state-example" 1.0.0 with every dependency marked dev**
`package-lock.json:2`. Impact low, effort S.
- Proposal: `npm install --package-lock-only` and commit it. Decide whether the examples get their own lock files (the README says lock files are kept).

## 3. Item table

| id | theme | impact | effort |
|---|---|---|---|
| B1 | soundness | high | M |
| B2 | bug | medium | S |
| B3 | bug | medium | S |
| B4 | bug | low | S |
| B5 | soundness | low | M |
| B6 | bug | medium | S |
| B7 | bug | high | S |
| B8 | bug | high | S |
| B9 | bug | medium | S |
| B10 | bug | medium | S |
| B11 | bug | medium | S |
| B12 | soundness | low | S |
| B13 | bug | low | S |
| B14 | bug | low | S |
| B15 | bug | low | S |
| B16 | bug | medium | S |
| B17 | soundness | medium | S-M |
| B18 | soundness | high | S |
| B19 | soundness | low | S |
| B20 | bug | low | S |
| B21 | bug | low | S |
| B22 | bug | medium | S |
| B23 | bug | high | M |
| B24 | soundness | low | S |
| B25 | bug | low | S |
| B26 | bug | low | S |
| B27 | soundness | low | S |
| B28 | bug | low | S |
| B29 | bug | low | S |
| B30 | bug | medium | S |
| U1 | unfinished | high | S |
| U2 | unfinished | high | M |
| P1 | caching | high | S |
| P2 | performance | high | M |
| P3 | performance | high | S |
| P4 | performance | high | M |
| P5 | performance | high | M |
| P6 | performance | medium | M |
| P7 | performance | high | M |
| P8 | performance | high | M |
| P9 | performance | medium | S |
| P10 | performance | medium | S |
| P11 | caching | medium | L |
| P12 | performance | low | S |
| P13 | performance | low | S |
| P14 | performance | high | S |
| P15 | caching | medium | S |
| P16 | caching | medium | S |
| P17 | caching | medium | S |
| P18 | caching | low | S |
| P19 | caching | low | S |
| P20 | performance | low | S |
| P21 | performance | low | S |
| P22 | performance | low | S |
| P23 | performance | low | S |
| P24 | performance | low | S |
| P25 | caching | medium | S |
| D0 | simplify | low | M |
| D1 | dedupe | low | S |
| D2 | dedupe | low | S |
| D3 | simplify | low | S |
| D4 | simplify | low | S |
| D5 | dedupe | low | S |
| D6 | docs | low | S |
| D7 | dedupe | low | S |
| C1 | capability | medium | L |
| C2 | capability | medium | M |
| C3 | capability | medium | S |
| C4 | capability | low | S |
| C5 | capability | low | S |
| C6 | capability | medium | M |
| C7 | capability | medium | S |
| C8 | capability | low | M |
| C9 | capability | medium | M |
| E1 | example | low | S |
| E2 | example | low | S |
| E3 | example | low | S |
| E4 | example | low | M |
| E5 | example | medium | S |
| E6 | example | medium | S |
| E7 | example | low | M |
| E8 | example | medium | M |
| E9 | example | low | S |
| E10 | example | low | M |
| E11 | example | low | S |
| E12 | example | low | S |
| E13 | example | high | S |
| E14 | example | high | M |
| E15 | example | medium | S |
| E16 | example | high | M |
| E17 | example | medium | S |
| E18 | example | medium | S |
| E19 | example | medium | M |
| E20 | example | low | S |
| E21 | example | medium | S |
| E22 | example | medium | S |
| E23 | example | medium | M |
| E24 | example | medium | M |
| E25 | example | low | S |
| E26 | example | low | S |
| T1 | tests | high | S |
| T2 | tests | medium | M |
| T3 | tests | medium | S |
| T4 | tests | medium | M |
| T5 | tests | medium | S |
| T6 | tests | low | S |
| T7 | tests | medium | M |
| T8 | tests | medium | S |
| T9 | tests | medium | M |
| T10 | tests | medium | M |
| T11 | tests | medium | S |
| T12 | tests | low | S |
| O1 | docs | high | S |
| O2 | docs | high | M |
| O3 | docs | medium | M |
| O4 | docs | medium | S |
| O5 | docs | low | S |
| O6 | docs | medium | S |
| O7 | docs | low | S |
| O8 | docs | low | M |
| O9 | docs | low | S |
| O10 | docs | low | S |
| O11 | docs | low | S |
| K1 | packaging | high | S |
| K2 | packaging | medium | S |
| K3 | packaging | medium | S |
| K4 | packaging | low | S |
| K5 | packaging | low | S |

Merged duplicates: B6 (two cache-corruption findings), B17 (two law-sampling findings), B23 (simulate-unbounded-run, runasync-windows-timeout, runasync-diverges-from-run), P1 (four typecheck findings, including sync-typecheck-blocks-suite), P2 (two specs-serial findings, plus first-run-alone), P7 (two isolation findings), P13 (two `--cores` findings), P16 (two GC findings), P17 (toolchain-per-stage, lib-in-toolchain-id, dafny-version-every-run), U1 (five ledger findings), E13 (two inv-quadratic findings), E19 (two sync-duplication findings), C2 (with replay-skips-task-helpers), O4 (two init-scripts findings), O6 (two stale-count findings), O7 (three roadmap-staleness findings).

## 4. Appendix: checked and dropped

- **main-wip-drops-seed-from-key**: main WIP removes the whole SPEC_SEED feature, not just its key term. The hazard is a hypothetical merge that would conflict visibly anyway.
- **json-output** (read Dafny diagnostics as JSON): `--json-output` exists, but the gain depends on P7, lsc's text output still has to be scraped, and no misparse was shown.
- **step-ensures-resource-peak**: main WIP drops the stale 14.2M comment. The hint proposal only helps together with P7 and raises isolated cost.
- **balance-belongs-in-spec**: `balance` is the deliberate `//@ pure` + `//@ requires` teaching case, and the selftest depends on it.
- **spec-consistency** (order.md naming and layout): style nits, nothing incorrect.
- **docs/dafny-version** ("Dafny 4+"): addressed in main WIP (its README says 4.11).
- **packaging-config/readme-dafny-version**: same as the previous item. Main WIP's README already pins 4.11.
- **dashboard-columnname-dead**: columnName is cited by examples/dashboard/README.md:39 as the showcase for a precondition the proof caught. The remaining test gap is covered by E9.
