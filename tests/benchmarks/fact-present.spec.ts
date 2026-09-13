import assert from "node:assert/strict";
import test from "node:test";

import { factPresent } from "../../benchmarks/factPresent.js";

// Every synthetic benchmark asks "is fact N still verbatim after compaction?"
// by looking for that fact's marker in the compacted context. The obvious
// implementation — `text.includes(marker)` — is wrong whenever one marker is a
// prefix of another, and ours are: facts are numbered 1..20, so `FACT1` also
// matches `FACT10`..`FACT19` and `FACT2` also matches `FACT20`. The bias is
// one-directional (it can only invent a hit, never lose one) and it lands
// hardest exactly where the headline numbers are read, because the protocol
// always asks about facts #1 and #10.
//
// It went unnoticed for a whole round of measurement: every cell read up to 2
// too high and nothing failed loudly, because a plausible result is not a
// failing test. This pins the boundary instead of trusting it.
//
// Fail-before-fix: with `includes` these assertions report the fact as present.

const MARKERS = ["FACT1", "FACT2", "FACT10", "FACT20", "A-FACT1", "B-FACT10"];

test("a longer marker does not satisfy a shorter one", () => {
  assert.equal(factPresent("kept FACT10: KRAS", "FACT1"), false, "FACT10 must not count as FACT1");
  assert.equal(factPresent("kept FACT20: KRAS", "FACT2"), false, "FACT20 must not count as FACT2");
  assert.equal(factPresent("A-FACT10: KRAS", "A-FACT1"), false, "A-FACT10 must not count as A-FACT1");
  assert.equal(factPresent("B-FACT10: KRAS", "B-FACT1"), false, "B-FACT10 must not count as B-FACT1");
});

test("the exact marker is found wherever it sits", () => {
  assert.equal(factPresent("FACT1: KRAS", "FACT1"), true, "at the start");
  assert.equal(factPresent("kept FACT1: KRAS", "FACT1"), true, "mid-text");
  assert.equal(factPresent("kept FACT1", "FACT1"), true, "at the end of the text");
  assert.equal(factPresent("kept FACT1: KRAS", "FACT10"), false, "the reverse lookup stays false");
  assert.equal(factPresent("kept A-FACT1: KRAS", "A-FACT1"), true, "topic-prefixed marker");
});

test("a false start earlier in the text does not hide a later true hit", () => {
  // The scan must keep going after rejecting a prefix hit, or a text that
  // mentions FACT10 before FACT1 would report the fact as lost.
  assert.equal(factPresent("FACT10 was folded; FACT1 was kept", "FACT1"), true);
  assert.equal(factPresent("A-FACT10 folded; A-FACT1 kept", "A-FACT1"), true);
  assert.equal(factPresent("FACT11 FACT12", "FACT1"), false, "all candidate hits rejected");
});

test("markers that cannot collide are unaffected", () => {
  for (const marker of MARKERS) {
    assert.equal(factPresent(`${marker}: present`, marker), true, marker);
    assert.equal(factPresent("nothing here", marker), false, marker);
  }
});
