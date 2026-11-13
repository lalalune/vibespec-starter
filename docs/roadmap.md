# Review and roadmap

Findings of a review of the whole project (the tools' code, the spec language,
and the speed of the check), with what has been done about each. Items are
ranked by value within each section.

## Done

**Soundness**

- The probe run (evaluating definitions) and the `sometimes` witness searches
  ignored a broken rule. Every run now reports one: a witness search stops at
  its goal *or* at a broken rule (`never_w = inv and not w`), and the shortest
  break across all runs is shown.
- A rule written as a `pure val` (`pure val alwaysX = false`) became a
  constant and was never checked. It is refused. A guard that does not return
  `bool` is refused.
- `export … from` in verified `src/` code escaped the import check. It goes
  through the same check as `import`.
- Hand-written code can make its contract vacuous with `//@ requires false`.
  The proof line now says how many preconditions a unit's proof assumes, so a
  reader knows unverified callers must meet them.
- `dafny audit` runs on every unit, not only those with a proof file.
- The `tests` stage always passed when `check` ran inside another `node --test`
  run (as the selftest does): the child inherited `NODE_TEST_CONTEXT` and
  reported to the parent. The selftest never exercised `types` or `tests` at
  all; it now does, with cases for both.
- `types` reported ✓ "skipped" when `src/` or `test/` existed without a
  `tsconfig.json`. It fails and says to run `spec init`.
- A story "A" counted as having rules if a story "A / B" had some (prefix
  match). Rules now carry their story.
- Markdown parsing now follows what a viewer shows: a code fence closes only
  on a bare fence of the same character at least as long, `~~~` fences work,
  fences may be indented (a list item at any depth), and a line break other
  than `\n` (which Quint and a viewer may read differently, letting prose end a
  comment early) is refused. A spec whose prose contains `~~~` fences shows
  "prose changed" once and needs one `npm run accept` after review.
- `accept` is all or nothing across specs, and `accept -- <typo>` or
  `check <anything>` is refused instead of signing off reviews. New rules
  (including every "Discovered by…" rule) are shown with both halves before
  sign-off, like changed ones.

- Importing a machine under a name failed when its state used a type it had
  imported itself (`unknown type C::Op`), found by building
  `examples/fullstack`. Imported types now come along, however deep.

**Speed** (order example, this machine, same load)

| | before | after |
|---|---|---|
| cold check (`SPEC_NO_CACHE=1`) | 16.5–19.8 s | 8.3 s |
| prose-only edit | re-ran simulation and every proof | 1.4 s, nothing re-run |
| warm check, nothing changed | 1.3 s | 1.3 s |

- Cache keys use what a spec *means*, exactly: the Quint lines as written with
  only the prose lines blank, and the generated TypeScript rendered without
  the comments that cite spec lines (hand-written code is taken verbatim). A
  quint block may not end inside a comment or string, so a prose line can
  never be code. Editing prose no longer re-simulates and re-proves
  everything below it.
- The probe and witness simulations overlap (after a first run on its own,
  which installs Quint's evaluator); proof units run at the same time, each
  once the units whose laws it may use are done; `dafny audit` runs beside
  LemmaScript's check; `tsc` runs beside the proofs. Every overlapping
  process goes through one pool of at most one per core, so the selftest's
  concurrent cases no longer start a hundred simulators at once.
- `toolchainId` cached its string but still ran `dafny --version` and hashed
  every tool file on each call.

**Agent systems** (from a review of Grace and elizaOS core; `examples/assistant`)

- `by`, who sent an event, is a transition parameter the generated code keeps
  out of the event: `step(s, e, by)`, so a message cannot claim a sender.
- `stepX(before, via, after)`: step rules see which transition was taken.
- A guard takes only the parameters it uses.
- Witness searches that find nothing in 20 events try 40, then 100.
- Counterexamples show each event with only what it changed.
- Errors about unsupported Quint point to CONTRIBUTING.md, not the tools.

**Agents**

- Claude Code reads `AGENTS.md` only when there is no `CLAUDE.md`, and only
  from v2.1.277 (docs: code.claude.com/docs/en/memory, "AGENTS.md"). So
  `spec init` makes `CLAUDE.md` import it (`@AGENTS.md`) instead of copying
  it: one source, loaded once in every version, also in projects that already
  have a `CLAUDE.md`. This repository has the same one-line `CLAUDE.md`.
- `spec init` silently skipped `AGENTS.md` when a project already had one,
  which is common, so the agent never learned the procedure. It now inserts a
  marked section into an existing `AGENTS.md` and refreshes it on re-run.
- `AGENTS.md` is split into that installable section (with a command table and
  where logs live) and a part about this repository's tools.
- The sync skill now starts from a request for new behaviour (write the story
  first), says what to read once per session, explains caching, and covers the
  failure lines it did not: stale accepted obligations, newly provable ones,
  preconditions, a missing `tsconfig.json`.

## Not done yet, by priority

### Correctness and maintainability

1. **Split `tools/spec.ts`** (about 750 lines, eight concerns) into
   `util.ts` (`run`, `findUp`, `sha`, `indent`, `fail`, `filesUnder`),
   `parse.ts`, `review.ts`, `cache.ts`, `simulate.ts` and `units.ts`, leaving
   `check` orchestration, `init` and the CLI. Deduplicate on the way: `fail`
   (spec.ts, types.ts), `typeOf` (gen.ts, print.ts), the walk up for
   `node_modules` (prove.ts `bin`, spec.ts `version`, selftest), recursive
   listing (three places), rule-by-definition lookup (`cite`, `origins`),
   dependency closure (three places), lock-file writing (two), the list-helper
   names (three regexes), Dafny base arguments and output tails in prove.ts.
2. A spec with a state and no transitions fails with a Quint parse error
   from the generated harness instead of a message.
3. `gen.ts`: the `<module>_` prefix check covers direct imports only; proof
   bundles contain transitive ones (fails closed, with a confusing Dafny
   error). Refuse a record field named `__proto__`.
4. The unproved ledger's fingerprint is the unit's full text, so any prose
   edit voids what the user accepted (the dashboard example is in this state
   now). Fingerprinting what the unit means, as the cache does, would keep
   acceptance across prose edits; it is a change to what the user signed, so
   it is the user's call.

### Speed

1. Start typechecking and proving a spec as soon as its own simulation
   passes, instead of after every spec's (results discarded if a later spec
   breaks).
2. Cache proofs per obligation (hash each `_ensures` lemma with what it
   reaches) and verify only changed ones with `--filter-symbol`.
3. A quick simulation profile for iterating (`SPEC_QUICK=1`, a tenth of the
   samples), never used by `accept` or CI.
4. `spec watch`: one process that keeps the compiler and IR loaded and
   re-runs only what changed.
5. Selftest: a shared content-addressed cache directory for cases that only
   change prose or review state.

### Language, for larger and client/server applications

Cheap, in the existing code:

1. **Reuse what imported machines proved** (about 80 lines): offer each
   imported transition's proved `_ensures` as an axiom, as laws already are,
   so a system spec need not re-prove its components' rules.
2. **Translate `every` / `some` / `includes` to Dafny quantifiers**, not folds:
   most of the dashboard's 81 simulated-only obligations are this shape.
3. Built-in `m.getOr(k, d)` and `xs.nthOr(i, d)` for guarded lookups.
4. `weight_<event>` values for the simulator, so deep interleavings (lose,
   duplicate, reorder across two clients) are reached more often.
5. Structural `==` on records and lists (generated `eq_<Type>`). The
   fullstack example had to write list equality as a fold and prove it
   reflexive by induction.
6. Remove the i-th element of a list (the fullstack example's network needed
   a fold with its own induction proof), and `<param>Values` honoured from an
   imported spec.
7. `.listMap` on the result of another call (`xs.append(x).listMap(f)`)
   fails at Dafny generation.
8. **Integers past 2^53**: TypeScript loses precision where Quint and Dafny do
   not. Refuse a step whose result outgrows a safe integer, or emit `bigint`.

Larger:

9. **Transitions that return output** (`{ state, out: List[Effect] }`) so a
   server's reply is not faked as an outbox field; `replay` compares outputs,
   and rules order effects (Grace persists an expectation before it acts).
10. **Keyed tables** that can be iterated (`m.keys().forall`), emitted as Dafny
   `map` with native quantifiers: uniqueness becomes structural.
11. **Refinement** (`refines`): a concrete server or client spec maps onto an
   abstract one, transition by transition, so the abstract rules carry over.
12. **Instances**: `clients: str -> C::Client` with lifted transitions and
    rules, proved by frame lemmas instead of again.
13. **Environment library** (`std/net.md`): lossy, duplicating, reordering
    delivery, and bounded liveness (`eventually` within N steps).
14. **Liveness under fairness**: `leadsTo` rules and fair events, found by
    lasso search (Grace's TLA+ models and Eliza's task scheduler need them).
15. **Opaque functions**: bodiless definitions with laws (a hash, `sameSite`,
    a model's output), simulated as consistent random tables and bound to
    proved `src/` code.
16. **Secrecy as labels**: fields, parameters and effects marked secret, and
    a flow check that none reaches speech, a log or a page; today a spec tags
    effects by hand.
17. **Traces from the running program** (JSONL) replayed against the spec, and
    a JSON step driver so Android Java and `.mjs` code can be checked the same way.
18. Exhaustive bounded checking from `check` (Apalache), with pinned state
    counts as regression evidence. Generated HTTP and React adapters outside
    the trusted core.
