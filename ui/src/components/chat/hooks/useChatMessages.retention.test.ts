import { describe, expect, it } from 'vitest';

import { readCompactRetention } from './useChatMessages';

// The retention badge is fed from `NormalizedMessage.compactMetadata`, which is
// typed `unknown` because it comes off the wire. This mapper runs inside the
// message list for every message, so the property that matters is not just
// "reads a well-formed payload" but "never throws on a malformed one" — a throw
// here would take out the whole conversation view.

describe('readCompactRetention', () => {
  it('reads a well-formed retention payload', () => {
    expect(
      readCompactRetention({
        retention: {
          policyId: 'ebbinghaus-pagerank',
          retainedMessages: 3,
          retainedTokens: 1204,
          budgetTokens: 2048,
          weights: { wSim: 0.85, wTime: 0.15, wRank: 0 },
        },
      }),
    ).toEqual({
      policyId: 'ebbinghaus-pagerank',
      retainedMessages: 3,
      retainedTokens: 1204,
      budgetTokens: 2048,
      weights: { wSim: 0.85, wTime: 0.15, wRank: 0 },
    });
  });

  it('returns undefined when nothing was retained, so no badge is rendered', () => {
    expect(readCompactRetention({ retention: { retainedMessages: 0 } })).toBeUndefined();
  });

  it('returns undefined when the key is absent', () => {
    expect(readCompactRetention({})).toBeUndefined();
    expect(readCompactRetention({ compactStage: 'done' })).toBeUndefined();
  });

  it('drops fields with the wrong type instead of coercing them', () => {
    expect(
      readCompactRetention({
        retention: { retainedMessages: 2, retainedTokens: '1204', budgetTokens: null, weights: 'nope' },
      }),
    ).toEqual({
      policyId: undefined,
      retainedMessages: 2,
      retainedTokens: undefined,
      budgetTokens: undefined,
      weights: undefined,
    });
  });

  it('rejects a partially-numeric weights object', () => {
    // Half a weights triple would render a mis-scaled row, so treat it as absent.
    expect(
      readCompactRetention({ retention: { retainedMessages: 1, weights: { wSim: 0.85, wTime: 0.15 } } })?.weights,
    ).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'retention'],
    ['a number', 7],
    ['an array', [1, 2, 3]],
  ])('never throws on %s metadata', (_label, metadata) => {
    expect(() => readCompactRetention(metadata)).not.toThrow();
    expect(readCompactRetention(metadata)).toBeUndefined();
  });

  it.each([
    ['a string', 'nope'],
    ['a number', 3],
    ['an array', []],
    ['null', null],
  ])('never throws when retention itself is %s', (_label, retention) => {
    expect(() => readCompactRetention({ retention })).not.toThrow();
    expect(readCompactRetention({ retention })).toBeUndefined();
  });
});
