/**
 * True when `marker` occurs in `text` as a whole marker, not as a prefix of a
 * longer one.
 *
 * Markers are `FACT1` .. `FACT20`, so a plain `text.includes(marker)` also
 * matches `FACT10`..`FACT19` when testing `FACT1`, and `FACT20` when testing
 * `FACT2`. That is not hypothetical: on the demo case (`seed 20260911`, N=160)
 * the post-compaction context contained the substring `FACT1` ten times and the
 * literal `FACT1:` **zero** times — every one of those hits was the prefix of a
 * different fact that happened to be kept, and the same held for `FACT2` inside
 * `FACT20`. Every fact-presence count in `benchmarks/` reads through here so the
 * collision cannot come back one script at a time.
 */
export function factPresent(text: string, marker: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(marker, from);
    if (at === -1) return false;
    const next = text[at + marker.length];
    if (next === undefined || next < "0" || next > "9") return true;
    from = at + 1;
  }
}
