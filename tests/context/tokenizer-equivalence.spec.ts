import assert from "node:assert/strict";
import test from "node:test";

import { countTokens, countTokensFast, getTokenizer } from "../../src/context/budget/tokenizer.js";

// `countTokens` replaced js-tiktoken's quadratic merge with a heap-based one.
// A faster counter is only useful if it agrees, so these tests pin the two
// implementations together: same answer on every input we can think of, and
// demonstrably better scaling on the inputs that motivated the change.

const reference = (text: string): number => getTokenizer().encode(text).length;

const ALPHABETS = [
  "x",
  "ab",
  "abcdefghijklmnopqrstuvwxyz",
  " \n\t",
  "0123456789",
  "=+/-_",
  "一二三四五",
  "\u{1F600}\u{1F389}\u{1F680}",
  "éüß",
  "qwertyuiopasdfghjkl",
];

/** Deterministic LCG so a failure is reproducible from the seed alone. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function assertSame(text: string, label: string): void {
  assert.equal(
    countTokensFast(text),
    reference(text),
    `countTokensFast disagreed with Tiktoken.encode on ${label} (len=${text.length})`,
  );
}

// Corpus sizes are deliberately modest: the reference implementation is the
// slow one, so every `assertSame` pays its cost. Equivalence is a property of
// input *shape*, not size, and the shapes below are all represented.
const RUN_LENGTHS = [1, 2, 3, 5, 17, 64, 257];

test("agrees with the reference on runs of a single repeated character", () => {
  // A long run of one byte is a single pre-token — the shape that made the
  // original merge quadratic.
  for (const alphabet of ALPHABETS) {
    for (const length of RUN_LENGTHS) {
      assertSame(alphabet.repeat(length), `run ${JSON.stringify(alphabet.slice(0, 6))} x ${length}`);
    }
  }
});

test("agrees with the reference on repeated units", () => {
  for (const unit of ["ab", "abc", "hello ", "http://", "中文", "==="]) {
    for (const times of [1, 2, 7, 100, 257]) {
      assertSame(unit.repeat(times), `repeat ${JSON.stringify(unit)} x ${times}`);
    }
  }
});

test("agrees with the reference on random text over every alphabet", () => {
  const random = makeRandom(12345);
  for (const alphabet of ALPHABETS) {
    for (let trial = 0; trial < 60; trial += 1) {
      let text = "";
      const length = Math.floor(random() * 400);
      for (let i = 0; i < length; i += 1) {
        text += alphabet[Math.floor(random() * alphabet.length)];
      }
      assertSame(text, `random over ${JSON.stringify(alphabet.slice(0, 6))}`);
    }
  }
});

test("agrees with the reference on mixed-alphabet text", () => {
  const random = makeRandom(987654);
  for (let trial = 0; trial < 200; trial += 1) {
    let text = "";
    const length = Math.floor(random() * 600);
    for (let i = 0; i < length; i += 1) {
      const alphabet = ALPHABETS[Math.floor(random() * ALPHABETS.length)]!;
      text += alphabet[Math.floor(random() * alphabet.length)];
    }
    assertSame(text, "mixed alphabets");
  }
});

test("agrees with the reference on empty and near-empty input", () => {
  assert.equal(countTokens(""), 0);
  assertSame("", "empty");
  assertSame(" ", "single space");
  assertSame("\n", "single newline");
  assertSame("\u{1F600}", "single emoji");
});

test("still rejects special tokens the way the reference does", () => {
  // `Tiktoken.encode` throws on a disallowed special token; delegating keeps
  // `countTokens` from silently inventing a number where the reference refuses.
  assert.throws(() => reference("<|endoftext|>"));
  assert.throws(() => countTokens("<|endoftext|>"));
  // A near-miss must NOT take the delegation path and must still count.
  assertSame("a <| b", "unterminated angle pipe");
  assertSame("<|not_a_special_token|>", "unknown special-looking token");
});

test("counts a long repeated run in linear-ish time, not quadratic", () => {
  // The regression this guards: 8k repeated chars took ~8.8s with the old
  // merge, which made `read_file` on a persisted tool result take ~79s and
  // time out. `reference()` on 2000 chars (the largest size the equivalence
  // tests above still run through the slow path) pins the count; the 20000-char
  // run is only timed, because asking the reference for it would cost ~55s.
  assert.equal(countTokens("x".repeat(2000)), reference("x".repeat(2000)));

  const text = "x".repeat(20_000);
  const start = performance.now();
  const tokens = countTokens(text);
  const elapsed = performance.now() - start;
  // 8 chars per token for a pure "x" run; verified against the reference at
  // 2000 chars above, where the ratio is already settled.
  assert.equal(tokens, 2_500);
  assert.ok(
    elapsed < 500,
    `20000 repeated chars took ${elapsed.toFixed(0)}ms; the quadratic merge is back`,
  );
});
