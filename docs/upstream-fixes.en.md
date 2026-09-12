# Upstream Bug Fixes

This is reference detail supporting the main [README](../README.en.md): the full record behind the README section "Three upstream bugs fixed along the way" — the site lists, symptom tables, and reproduce-then-fix evidence for each of the three pre-existing upstream defects. None of them counts toward the Hippo innovation; the README keeps only a one-line summary and a pointer. 中文: [upstream-fixes.md](./upstream-fixes.md)

## Three upstream bugs fixed along the way

None of these three is introduced by this fork, none counts toward the Hippo innovation — but all are problems a real user hits, so we fix them and keep tests.

**Bug 1: `unref()`'d timeout timers (one root cause, three sites)**

`unref()` means "this timer doesn't keep the process alive". When that timer is exactly what settles an `await`ed promise, it's wrong: if no other libuv handle holds the loop, the event loop drains first, the timer never fires, and the caller gets a **never-settling promise** instead of the promised timeout error.

Classifying every `unref()` site in the repo by "does this timer settle an awaited promise?" hits three:

| Site | Symptom |
|---|---|
| `src/network/fetch.ts` | timeout silently fails, retries skipped; caller never sees `network_timeout` |
| `src/task/runtime/BackgroundTaskRuntime.ts` `wait()` | `wait(taskId, { timeoutMs })` never returns; and the timer is **never cleaned up** — every bounded wait leaves a dangling timer |
| `src/model/streaming/streamModel.ts` `withIdleTimeout()` | lazy timeout fails — a stalled stream should throw `StreamIdleTimeoutError`, but actually hangs forever |

The rest (heartbeats, idle sweep, telemetry, log rotation, etc.) **intentionally** don't keep the process alive — `unref()` stays, unchanged.

- Evidence: each site reproduced-then-fixed, and each fix ships a test that **must fail before the fix**:
  - `fetch.ts`: before the fix `tests/network/fetch.spec.ts` all 7 cancelled → after, 7/7;
  - `BackgroundTaskRuntime`: `tests/task/background-task-runtime.spec.ts` 5/6 before (item 6 "covers timeout, abort, unknown task and kill-all cleanup" gave up at only 10 ms) → 6/6 after;
  - `streamModel`: new `tests/model/streaming/idle-timeout.spec.ts` 6 cases; re-adding `unref()` and re-running → **all 6 cancelled**; with the fix back, 6/6.
- Blast radius: `fetch.ts` underlies every model provider / MCP network call; the other two are background tasks and streaming responses.

**Bug 2: tokenizer degrades to O(n²) on long repeated runs (`src/context/budget/tokenizer.ts`)**

This one was forced into the open by a test: `tests/tool/read-file-large.spec.ts` item 4 stably times out at 60 s. Not an environment issue — a real performance defect. A CPU profile showed 96% of the time in `js-tiktoken`'s `bytePairMerge`, not file IO:

| Input (a single repeated char) | js-tiktoken original | `countTokensFast` | Speedup |
|---:|---:|---:|---:|
| 500 chars | 60 ms | 3.5 ms | 17× |
| 1,000 chars | 133 ms | 4.8 ms | 28× |
| 2,000 chars | 533 ms | 2.6 ms | 209× |
| 4,000 chars | 2,177 ms | 9.5 ms | 230× |
| 8,000 chars | 8,999 ms | 9.1 ms | 993× |

Each doubling costs **2.2 / 4.0 / 4.1 / 4.1×** — **quadratic degradation** (the right column is only 2–10 ms, single-sample noise is obvious — read only the original's growth trend). Cause: its merge loop rescans every candidate pair each pass but merges only one, and BPE treats "a whole run of a repeated char" as a **single** pre-token, so this is the worst-case input. The Python/Rust tikToken uses a heap and doesn't have this problem.

This table is generated live by `pnpm benchmark:tokenizer` (result JSON: `benchmarks/results/tokenizer-scaling-2026-09-11T13-06-44-566Z.json`); before timing, the script asserts both implementations agree on every measured input, refusing to output the table otherwise — so it never compares times of two different functions.

The user-visible symptom: `read_file` reading a 300-line persisted tool result took **79 s** — enough to time out any tool call.

- Fix: in `countTokens` (the one bottleneck) swap to a **heap** implementation of the same greedy merging (pick the pair with the smallest rank of the current adjacent pairs, leftmost on ties — matching the library's per-item choice rule). Same merge-choice rule ⇒ same result.
- Evidence (same fixture):
  - **The reproducible one**: `pnpm benchmark:tokenizer` (table above) gives stepwise speedups, and the script carries a two-implementation agreement assertion.
  - End-to-end `read_file`: **79,238 ms → 1,214 ms** (65×) — a single-run measurement on the day of the fix, **not persisted**; re-measuring would require swapping `countTokens` back to the library original (that path no longer exists in current code), so treat it as an order-of-magnitude reference only.
  - The test file: before, item 4 hung and the whole file timed out at 60 s, 3/3 failing → after, **11/11 pass** (runs on every `pnpm test`, a standing regression gate for this defect).
  - Equivalence: `tests/context/tokenizer-equivalence.spec.ts` compares the heap vs the library original over **900 random inputs + 6 fixed boundaries (906 comparisons total)** (70 single-char repeated strings, 30 repeated units, 600 random text over a 10-letter alphabet, 200 mixed; fixed boundaries include CJK, emoji, empty strings, and special-token rejection paths), **0 mismatch**.
- Blast radius: `countTokens` is the common denominator of all budget decisions (`read_file` text budget, tool-result budget, micro-compaction, and Hippo's own `estimateMessagesTokens`) — one fix benefits all of them.

**Bug 3: "newest transaction" ordering key mixed logical time with file mtime (`src/web/server/replaceLastTurn.ts`)**

Startup recovery has to decide "which replacement transaction is newest". It wrote:

```ts
order: Math.max(preparedAt, backupMtime, journalMtime)   // before
```

`preparedAt` is the transaction's own logical timestamp; the two mtimes are the **filesystem's wall clock**. Taking `max` lets mtime override `preparedAt` in any real scenario, so ordering effectively degenerates to "whichever file was written last".

And the local filesystem's mtime granularity is **1 ms** — three consecutive writes measured the *same* `mtimeMs` (`...426.997`). Two transactions landing in the same millisecond **tie**, and the tie is decided by `readdirSync`'s return order, which is arbitrary. So recovery can pick the wrong transaction: a to-be-rolled-back report is treated as committed.

That is the true identity of the flaky failure in the full test run — `replace-last-turn.spec.ts`'s "startup recovery decides from the newest replacement transaction only" asserts `rolledBack` expected 1, got 0; run alone 5× it passed every time (measured locally, not persisted), and only failed under full concurrency, so it was long mistaken for "timing jitter".

- Fix: when `preparedAt` is parseable, **let it decide alone**; mtime only backs up when the journal is missing/unparseable:
  ```ts
  order: Number.isFinite(preparedAt)
    ? preparedAt
    : Math.max(backupMtime ?? 0, journalMtime ?? 0)
  ```
- Evidence: new case `recovery orders transactions by their journal timestamp, not by artifact mtime` — uses `utimes` to push the old transaction's file mtime arbitrarily 60 s into the future (no timing dependency), asserting recovery still selects the new transaction by `preparedAt`. Reverting to `Math.max` makes the case **fail deterministically** (1 fail); with the fix, 16/16. A flaky failure converted into an every-run deterministic assertion.
