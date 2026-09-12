<p align="center">
  <img src="assets/banner.png" alt="PilotDeck-Hippo" width="680"/>
</p>

<p align="center">
  <a href="https://github.com/qgeng1465/pilotdeck-hippo/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/qgeng1465/pilotdeck-hippo/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="https://github.com/qgeng1465/pilotdeck-hippo/actions/workflows/docker-build.yml"><img src="https://img.shields.io/github/actions/workflow/status/qgeng1465/pilotdeck-hippo/docker-build.yml?branch=main&label=docker%20build" alt="Docker Build"></a>
  <a href="https://github.com/qgeng1465/pilotdeck-hippo/blob/main/LICENSE"><img src="https://img.shields.io/github/license/qgeng1465/pilotdeck-hippo" alt="License"></a>
</p>

# PilotDeck-Hippo: keeping early facts quotable after compaction

> PilotDeck Creation Program · Track 3 (Harness / Memory / Architecture) · [中文](README.md) · **Live demo: <https://qgeng1465.github.io/pilotdeck-hippo/>**

<a href="https://qgeng1465.github.io/pilotdeck-hippo/assets/demo.mp4">
  <img src="https://qgeng1465.github.io/pilotdeck-hippo/assets/demo-poster.png" alt="The Hippo retention badge on a compaction boundary in a real session" width="760">
</a>

**60-second recording (click to play)**: the first half is the real terminal output of `benchmark:demo` — same input, upstream keeps 0 of 20 early facts verbatim, Hippo 18 of 20. The second half is the real Web UI, where one **continuing** task is compacted **twice** and both compaction boundaries carry the `Hippo kept N msgs verbatim` badge. Only the 2-second title card is synthetic; every compaction moment plays at 1×.

**In one sentence.** When PilotDeck's context grows, it compacts: the recent tail is kept verbatim and everything older is summarised. A summary keeps the gist but drops the things that have to be exact — file names, numbers, checkpoints, decisions. Hippo scores the messages that are about to be summarised, picks a small batch of the most relevant ones, and lets their **original text** skip summarisation and stay in the compacted context.

## What problem it solves

After a few dozen turns you ask "what was that service's p99 again?". Post-compaction, the upstream answer tends to be "based on the earlier summary, roughly…". With Hippo the agent can still reach the original number.

| | Upstream (summarise only) | With Hippo |
|---|---|---|
| Early facts still **verbatim** in the compacted context (out of 20) | 0 | **6–18** (table below) |
| Compacted tokens | baseline | **1.11–1.20×** |

The cost is out in the open: that extra 11–20% of tokens is not saved anywhere, it is what the fidelity costs.

## Results

**Main result.** Re-run on 10 seeds that **never took part in any tuning** (each seed paired against its own upstream run). The metric is how many of 20 injected facts are still present *verbatim* after compaction:

| Scenario | Upstream | Hippo | W / T / L |
|---|---:|---:|---|
| English, N=160 | 0 / 20 | **17.9 / 20** | 10 / 0 / 0 |
| Chinese, N=160 | 0 / 20 | **10.0 / 20** | 10 / 0 / 0 |
| English, N=80 | 0 / 20 | **9.4 / 20** | 10 / 0 / 0 |
| Chinese, N=80 | 0 / 20 | **6.0 / 20** | 10 / 0 / 0 |

All four cells won (two-sided exact sign test p = 0.002). The upstream 0 comes from a fake summariser that never emits the fact text — it is the structural "lossy summary vs verbatim retention" contrast, **not** the ceiling of a real summariser. For a real model, see below.

**With a real summariser (DeepSeek-V4-Flash) the advantage becomes conditional:**
- One task across several compactions (tight budget, 1,500 tok): **10/16 → 16/16** on questions about the current task.
- Chinese tasks: Hippo wins 4 of 4 cells across two independently recorded rounds.
- English tasks: no measurable difference when the summary budget is generous; the gap only opens when it is tight.

**One task across several compactions (structural benchmark, `corepack pnpm benchmark:long-horizon`):** one continuing task is compacted 3 times in a row, each round taking the **actual output** of the previous one as its input (not a re-simulation), with facts injected throughout. Facts still present verbatim afterwards, mean over 80 seeds:

| Injected | Upstream | Hippo |
|---|---:|---:|
| Oldest 5 (before round 1) | 1.0 | 1.0 |
| Middle 5 (before round 2) | 0.0 | **1.8** |
| Newest 5 (before round 3) | 1.0 | **5.0** |
| Total / 15 | 2.0 | **7.8** |

The boundary belongs in the same breath: both sides keep only 1 of the oldest 5. **Retention is not memory** — once a fact has been through several compactions, it goes away however old the block is. Hippo does not fix that and does not claim to.

**What changed for the cross-compaction case.** Retention used to be recomputed from scratch on every compaction: a message kept verbatim in round 1 got no credit in round 2, re-entered the summary bucket, and was re-scored against a request that had drifted. Messages a previous compaction kept verbatim now get a small **capped allowance** of their own (25% of the retention budget) to be re-selected first. Nothing is re-weighted — candidate order is untouched, so an old message cannot displace one the current request needs. Paired over 80 seeds: the middle bracket 1.36 → **1.80** (27 W / 53 T / 0 L), total 7.38 → **7.78** (25 / 54 / 1), newest 5.00 → 4.98 (2 seeds of 80 lose one fact each). It does **not** hold the oldest bracket (1.01 → 1.00), which was the point of the change — we measured that it fails, and say so. `PILOTDECK_CARRYOVER=off` turns it off so both arms can be compared directly.

**Does it dump irrelevant history back in?** No. Counting message by message against the engine's own reported retention list, **89–100%** of what is retained is relevant to the current question (2.7–11× the random baseline).

> The source, protocol, seed range and aggregation for every number above live in [docs/evaluation.en.md](docs/evaluation.en.md) ([中文](docs/evaluation.md)), each traced to a committed `benchmarks/results/*.json`. You can audit any figure there.

## How it works

Before compaction, messages that are about to be summarised are scored individually; the top few that fit a **hard token budget** are kept verbatim alongside the summary:

```text
S(m) = 0.85 × sim(q, m)          # relevance to the pending request (BM25; optional local embedding)
     + 0.15 × position_decay(m)  # nearer in the transcript is likelier to matter
     + 0.00 × idf_pagerank(m)    # entity co-occurrence PageRank; default weight 0, code and config kept
```

Three design constraints — this is what separates it from "tweak the summarisation prompt again":

- **The budget is hard**: the retention block may spend at most 20% of the tail budget (floor 256 tokens). The compacted context cannot balloon because the model "wanted to remember more".
- **The output is the original text**: retained messages enter the context verbatim, immune to swings in summariser quality.
- **Failure yields**: a scoring error, a missing model or an embedding timeout falls back to the plain upstream summary path and never blocks the turn.

Omit `scorePolicy` and you get the pure upstream path, byte-identical (guarded by a golden fixture). This fork's app layer enables it by default; `agent.compaction.retention: off` turns it back off.

Design detail, architecture diagram and where to read the code: [docs/design.en.md](docs/design.en.md) ([中文](docs/design.md)).

## Verify it yourself in 30 seconds

The repo is public — no access needed:

```bash
git clone https://github.com/qgeng1465/pilotdeck-hippo && cd pilotdeck-hippo
corepack pnpm install --frozen-lockfile
corepack pnpm benchmark:demo        # ~2 s; English N=160: upstream 0/20 → Hippo 18/20
corepack pnpm benchmark:no-regression   # with retention off, output must match the upstream baseline byte for byte
```

Prefer looking at pictures: <https://qgeng1465.github.io/pilotdeck-hippo/> has a screen recording and the full numbers.

## Running it

Requirements: Node.js `22.13+ <23`, Python 3, `make`, a C/C++ compiler, `ripgrep`.

```bash
corepack enable
corepack pnpm install --frozen-lockfile
node scripts/bootstrap-pilotdeck-config.mjs   # writes ~/.pilotdeck/pilotdeck.yaml
```

Configure a model in `~/.pilotdeck/pilotdeck.yaml` or the Web UI (never commit a real API key):

```yaml
schemaVersion: 1
agent:
  model: custom/<model-id>
  compaction:
    retention: hippo   # the default in this fork; set to off for pure upstream compaction
model:
  providers:
    custom:
      protocol: openai
      url: https://<endpoint>/v1
      apiKey: ${PILOTDECK_API_KEY}
```

Start the Web UI:

```bash
cd ui && npm run start       # production (runs vite build first), http://localhost:3001
# dev: npm run dev           # http://localhost:5173
```

If you only care about Hippo, these are enough:

```bash
corepack pnpm benchmark:no-regression   # with scorePolicy off, must equal the upstream baseline
corepack pnpm benchmark:smoke           # small smoke run
corepack pnpm benchmark                 # full A/B (N=40/80/160)
corepack pnpm benchmark:extraction      # message-level precision / recall
corepack pnpm benchmark:long-horizon    # one task compacted 3 times in a row
corepack pnpm benchmark:tokenizer       # the two tokenizer implementations, timed
```

Real-LLM evaluation needs network. Endpoint resolution order: ① `PILOTDECK_EVAL_URL` + `PILOTDECK_EVAL_KEY` → ② `poliet_deck.txt` at the repo root (optional self-hosted gateway; the key is not committed) → ③ `~/deepseek_key.txt`.

```bash
corepack pnpm benchmark:real-llm                # single-topic loop
corepack pnpm benchmark:real-llm-topic-switch   # one task across several compactions
```

Other installation paths, including the desktop app, are in [Appendix A](#appendix-a-upstream-pilotdeck-project).

## Known limits

- **The gain is fidelity to the *current task*, not memory of abandoned topics.** The old-topic column turned out to be an artefact of shared phrasing in the test harness; it goes to zero under decorrelated wording. Do not claim "Hippo remembers old topics".
- **With a real summariser the advantage is conditional.** With a generous summary budget there is no measurable difference (repeats of the same configuration swing by 3–4 questions); it only separates when the budget is tight.
- **The default weights changed, but we do not call that an improvement.** They changed to match the tuning argmax with one fewer term; on the holdout set the rank term's effect is far smaller than the noise (7 W / 33 T / 0 L, nothing significant). The real effect is "verbatim retention vs none".
- **The evaluation is mostly synthetic dialogue**, with facts skewed early and the question at the tail. Real temporal structure, noise and multi-turn questions may move the optimal weights.
- **The real-LLM sample is small** (16 questions per cell, 2 seeds) and the summariser and the judge are the same model, so we state direction only, never "an X-point gain".
- **Hippo increases post-compaction tokens** (~+5–24% in the recorded real-LLM runs). Present accuracy and cost together.

## Four upstream bugs fixed along the way

None of these is related to Hippo, but all four hit real users, so they are fixed here — each with a test that fails before the fix:

1. **Three timeout timers that were `unref()`'d**: they exist to settle a promise that is being `await`ed, but `unref()` lets the event loop drain first, so the caller gets a promise that never settles instead of a timeout error. Affects `fetch.ts` (the base of every model/MCP network call), the background-task `wait()`, and the streaming idle timeout.
2. **The tokenizer degrades to O(n²) on long repeated strings**: `countTokens` now uses a heap implementation of the same greedy merge — 8,000 characters 8,999 ms → 9.1 ms (993×), and `read_file` on a 300-line tool result 79.2 s → 1.2 s. Equivalence is verified by 906 comparisons with 0 mismatches.
3. **Startup recovery ordered "newest transaction" by mixing logical time with file mtime**: mtime granularity is 1 ms here, so two transactions inside the same millisecond tie, and recovery picks the wrong one — that was the true identity of a long-standing flaky test. Ordering by the transaction's own timestamp turned the flake into a deterministic assertion.
4. **When a summary fails, the compaction boundary marker is fed to the next summariser as a user message**: boundaries are paired positionally with the summary that follows them, and a failed summary leaves nothing behind — so the marker stays in the live messages. The summariser is asked "what did the user just ask?" and reads a `<compact-boundary/>`; if the kept tail covers it, it is re-emitted verbatim on every round. The marker carries no content, so dropping it costs nothing.

Full evidence and reproduction commands: [docs/upstream-fixes.en.md](docs/upstream-fixes.en.md) ([中文](docs/upstream-fixes.md)).

## Repository and provenance

- Upstream baseline: [OpenBMB/PilotDeck](https://github.com/OpenBMB/PilotDeck) `85be774`; the fork point is byte-comparable (see `NOTICE`).
- This fork's changes are confined to `src/context/compaction/` (policy and wiring), `benchmarks/` (evaluation scripts) and `tests/context/` (dedicated tests).
- The repository has always been publicly readable, cloneable without any access grant. Every public number comes from the committed `benchmarks/results/*.json`; no third-party review.
- Current test and typecheck state: root suite `pnpm test` 529 items / 527 passed / 0 failed (2 skipped); UI `npx vitest run` 118 files / 922 tests / 0 failed; `ui`'s `tsc --noEmit` exits 0.

## License and credits

AGPL-3.0 (inherited from upstream). Upstream PilotDeck's copyright notice and licence are in [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Appendix A: upstream PilotDeck project

This project is a fork of [OpenBMB/PilotDeck](https://github.com/OpenBMB/PilotDeck), an open-source local AI agent workbench with custom model endpoints, tool calls, MCP, long-running tasks and both Web and desktop front ends. Hippo changes only its context-compaction path; everything else matches upstream. For installation, feature documentation and version history, see the upstream repository.
