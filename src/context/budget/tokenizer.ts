import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

let _instance: Tiktoken | null = null;

export function getTokenizer(): Tiktoken {
  if (!_instance) {
    _instance = new Tiktoken(o200k_base);
  }
  return _instance;
}

/**
 * `js-tiktoken`'s `bytePairMerge` rescans every candidate pair on each pass and
 * merges exactly one pair per pass, which is O(n^2) in the length of a single
 * pre-token. A long run of one repeated byte (a separator line, a base64 blob,
 * a column of identical values) is normally a *single* pre-token, so a few
 * hundred KB of such text can take minutes to count. Python and Rust tiktoken
 * use a heap and do not have this problem.
 *
 * `countTokens` therefore runs the same greedy merge here with a heap. The
 * merge choice is identical — minimum rank among currently adjacent pairs,
 * leftmost on ties — so the returned count is exactly the same. See
 * tests/context/tokenizer-equivalence.spec.ts, which fuzzes this against
 * `Tiktoken.encode` over runs, repeats, CJK, emoji and random text.
 */

type EncoderInternals = {
  patStr: string;
  rankMap: Map<string, number>;
  specialTokens: Record<string, number>;
};

function internalsOf(tokenizer: Tiktoken): EncoderInternals {
  // js-tiktoken marks these `@internal`; one narrow cast beats re-deriving the
  // 200k-entry rank table (and the pre-token regex) from scratch.
  return tokenizer as unknown as EncoderInternals;
}

let _specialTokenPattern: RegExp | null = null;

function specialTokenPattern(internals: EncoderInternals): RegExp {
  if (!_specialTokenPattern) {
    const escaped = Object.keys(internals.specialTokens)
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    _specialTokenPattern = new RegExp(escaped);
  }
  return _specialTokenPattern;
}

const textEncoder = new TextEncoder();

/**
 * Number of tokens a pre-token's UTF-8 bytes encode to. Mirrors the tail of
 * `Tiktoken.encode`: a piece that is itself a rank is one token, otherwise the
 * greedy merge decides.
 */
function countPieceTokens(piece: Uint8Array, rankMap: Map<string, number>): number {
  const length = piece.length;
  if (length === 0) return 0;
  const whole = rankMap.get(piece.join(","));
  if (whole != null) return 1;
  // Matches the library, which pushes a single (possibly undefined) entry and
  // counts it for a one-byte piece that has no rank of its own.
  if (length === 1) return 1;

  const prev = new Int32Array(length);
  const next = new Int32Array(length);
  // Comma-joined byte key of the span each node currently covers. Merging two
  // adjacent spans concatenates their keys, so a merge never re-slices bytes.
  const key: Array<string | null> = new Array(length);
  for (let i = 0; i < length; i += 1) {
    prev[i] = i - 1;
    next[i] = i + 1 < length ? i + 1 : -1;
    key[i] = String(piece[i]);
  }

  // Binary heap of [rank, leftIndex, keyAtPushTime]; leftIndex breaks ties so
  // the leftmost minimum wins, exactly as the library's left-to-right scan.
  const heap: Array<[number, number, string]> = [];
  const lessThan = (a: [number, number, string], b: [number, number, string]) =>
    a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1];
  const push = (entry: [number, number, string]) => {
    heap.push(entry);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (!lessThan(heap[child]!, heap[parent]!)) break;
      const swap = heap[child]!;
      heap[child] = heap[parent]!;
      heap[parent] = swap;
      child = parent;
    }
  };
  const pop = (): [number, number, string] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let parent = 0;
      for (;;) {
        const left = 2 * parent + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < heap.length && lessThan(heap[left]!, heap[smallest]!)) smallest = left;
        if (right < heap.length && lessThan(heap[right]!, heap[smallest]!)) smallest = right;
        if (smallest === parent) break;
        const swap = heap[parent]!;
        heap[parent] = heap[smallest]!;
        heap[smallest] = swap;
        parent = smallest;
      }
    }
    return top;
  };
  const consider = (left: number) => {
    const right = next[left]!;
    if (right < 0) return;
    const merged = `${key[left]},${key[right]}`;
    const rank = rankMap.get(merged);
    if (rank != null) push([rank, left, merged]);
  };

  for (let i = 0; i < length; i += 1) consider(i);

  let parts = length;
  while (heap.length > 0) {
    const entry = pop();
    const left = entry[1];
    const right = next[left]!;
    // Stale entry: this pair was invalidated by an earlier merge.
    if (right < 0 || `${key[left]},${key[right]}` !== entry[2]) continue;

    key[left] = entry[2];
    const afterRight = next[right]!;
    next[left] = afterRight;
    if (afterRight >= 0) prev[afterRight] = left;
    key[right] = null;
    next[right] = -1;
    prev[right] = -1;
    parts -= 1;

    consider(left);
    if (prev[left]! >= 0) consider(prev[left]!);
  }
  return parts;
}

/**
 * Heap-based BPE count. Equivalent to `getTokenizer().encode(text).length`, but
 * linear-ish instead of quadratic on long repeated runs.
 */
export function countTokensFast(text: string, tokenizer: Tiktoken = getTokenizer()): number {
  const internals = internalsOf(tokenizer);
  // Special tokens are the one input where `Tiktoken.encode` does something
  // other than pure BPE, and it throws on them by default. Delegate rather than
  // silently disagree about whether the call is even legal. Every special token
  // in the vocabulary contains "<|", so that substring is a sound pre-filter for
  // the (large) alternation.
  if (text.includes("<|") && specialTokenPattern(internals).test(text)) {
    return tokenizer.encode(text).length;
  }
  const preTokenPattern = new RegExp(internals.patStr, "ug");
  let total = 0;
  for (const match of text.matchAll(preTokenPattern)) {
    total += countPieceTokens(textEncoder.encode(match[0]), internals.rankMap);
  }
  return total;
}

/**
 * Count the number of tokens in a text string using o200k_base encoding.
 * Returns 0 for empty strings without invoking the tokenizer.
 */
export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return countTokensFast(text);
}
