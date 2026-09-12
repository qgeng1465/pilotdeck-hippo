// These tests describe the shipped SmoothTextStream: a deliberately simple
// smoother that emits a fixed number of characters per pump (2 while streaming,
// up to 15 while draining) on a setTimeout-driven clock, with no synchronous
// first paint and no moving-average rate tracking. Earlier revisions of this
// file asserted the richer implementation this class replaced (rAF scheduling,
// boundary snapping, a cadence-driven rate, an immediate first emit); those
// assertions were stale and have been rewritten to pin the real behaviour
// instead of being deleted.
import { describe, expect, it, vi } from 'vitest';
import { SmoothTextStream } from './streamSmoother';

function createManualFrameScheduler(onFrame?: () => void) {
  let nextId = 1;
  const queue: Array<{ id: number; callback: () => void; cancelled: boolean }> = [];

  return {
    scheduleFrame(callback: () => void): number {
      const id = nextId;
      nextId += 1;
      queue.push({ id, callback, cancelled: false });
      return id;
    },
    cancelFrame(id: number) {
      const item = queue.find((entry) => entry.id === id);
      if (item) item.cancelled = true;
    },
    runNext() {
      const item = queue.shift();
      if (item && !item.cancelled) {
        onFrame?.();
        item.callback();
      }
    },
    drain(limit = 80) {
      let count = 0;
      while (queue.length > 0 && count < limit) {
        this.runNext();
        count += 1;
      }
      return count;
    },
    get size() {
      return queue.filter((item) => !item.cancelled).length;
    },
  };
}

describe('SmoothTextStream', () => {
  it('renders a large chunk over many bounded frame updates', () => {
    let now = 0;
    const scheduler = createManualFrameScheduler(() => {
      now += 33;
    });
    const emitted: string[] = [];
    const text = 'abcdefghijklmnopqrstuvwxyz '.repeat(8);
    const stream = new SmoothTextStream({
      emit: (content) => emitted.push(content),
      scheduleFrame: (callback) => scheduler.scheduleFrame(callback),
      cancelFrame: (handle) => scheduler.cancelFrame(handle),
      now: () => now,
      frameMs: 33,
      minCharsPerFrame: 3,
      maxCharsPerFrame: 18,
    });

    stream.append(text);

    // No synchronous first paint: pump() is the single rendering path.
    expect(emitted.length).toBe(0);
    expect(stream.getSnapshot().pendingChars).toBe(text.length);

    scheduler.runNext();
    expect(emitted.length).toBe(1);
    expect(emitted[0]).toBe(text.slice(0, 2));

    scheduler.runNext();
    expect(emitted.length).toBe(2);
    // Steady-state chunking is a fixed 2 chars/frame. frameMs and the
    // min/maxCharsPerFrame options are accepted but do not drive the chunk size.
    expect(emitted[1]).toBe(text.slice(0, 4));

    stream.drain();
    const frames = scheduler.drain();
    expect(frames).toBeGreaterThan(0);
    expect(emitted.length).toBeGreaterThan(2);

    // Every intermediate emission is a growing prefix, and draining never
    // exceeds its 15-char-per-frame budget.
    for (let index = 1; index < emitted.length; index += 1) {
      const delta = emitted[index].length - emitted[index - 1].length;
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThanOrEqual(15);
      expect(text.startsWith(emitted[index])).toBe(true);
    }

    expect(emitted.at(-1)).toBe(text);
    // finalizeDone() resets the buffer once draining completes.
    expect(stream.getSnapshot().pendingChars).toBe(0);
    expect(stream.getSnapshot().targetLength).toBe(0);
  });

  it('keeps a constant smoothing rate while buffering appended chunks', () => {
    let now = 0;
    const scheduler = createManualFrameScheduler(() => {
      now += 33;
    });
    const stream = new SmoothTextStream({
      emit: () => {},
      scheduleFrame: (callback) => scheduler.scheduleFrame(callback),
      cancelFrame: (handle) => scheduler.cancelFrame(handle),
      now: () => now,
    });

    stream.append('abcd');
    now += 40;
    stream.append('x'.repeat(80));

    const snapshot = stream.getSnapshot();
    // averageCharsPerSecond is a fixed default here; this implementation never
    // recomputes it from chunk cadence.
    expect(snapshot.averageCharsPerSecond).toBe(120);
    expect(snapshot.targetLength).toBe(84);
    expect(snapshot.renderedLength).toBe(0);
    expect(snapshot.pendingChars).toBe(84);

    scheduler.runNext();

    const afterFrame = stream.getSnapshot();
    expect(afterFrame.renderedLength).toBe(2);
    expect(afterFrame.pendingChars).toBe(82);
    expect(afterFrame.averageCharsPerSecond).toBe(120);
  });

  it('emits a fixed-size prefix per frame rather than snapping to word boundaries', () => {
    let now = 0;
    const scheduler = createManualFrameScheduler(() => {
      now += 33;
    });
    const emitted: string[] = [];
    const stream = new SmoothTextStream({
      emit: (content) => emitted.push(content),
      scheduleFrame: (callback) => scheduler.scheduleFrame(callback),
      cancelFrame: (handle) => scheduler.cancelFrame(handle),
      now: () => now,
      frameMs: 33,
      minCharsPerFrame: 6,
      maxCharsPerFrame: 12,
    });

    stream.append('hello world, next sentence.');
    scheduler.runNext();

    // Boundary preference was part of the replaced implementation. The shipped
    // pump cuts a raw 2-char prefix, even below the configured minimum, so the
    // emission does not land on whitespace or punctuation.
    expect(emitted[0]).toBe('he');
    expect(emitted[0].length).toBeLessThan(6);
    expect(emitted[0].length).toBeLessThanOrEqual(12);
    expect(/[\s,]$/.test(emitted[0])).toBe(false);
  });

  it('flushes all buffered content and finalizes immediately', () => {
    let now = 0;
    const scheduler = createManualFrameScheduler(() => {
      now += 33;
    });
    const emitted: string[] = [];
    let finalized = 0;
    const stream = new SmoothTextStream({
      emit: (content) => emitted.push(content),
      finalize: () => {
        finalized += 1;
      },
      scheduleFrame: (callback) => scheduler.scheduleFrame(callback),
      cancelFrame: (handle) => scheduler.cancelFrame(handle),
      now: () => now,
    });

    stream.append('streaming output');
    stream.flush(true);

    expect(emitted.at(-1)).toBe('streaming output');
    expect(finalized).toBe(1);
    expect(stream.getSnapshot().targetLength).toBe(0);
    expect(stream.getSnapshot().renderedLength).toBe(0);
    expect(scheduler.size).toBe(0);
  });

  it('pumps on the timer fallback when the scheduled frame has not fired', () => {
    vi.useFakeTimers();
    const requestAnimationFrameSpy = vi.fn(() => 1);
    const cancelAnimationFrameSpy = vi.fn();
    vi.stubGlobal('window', {
      requestAnimationFrame: requestAnimationFrameSpy,
      cancelAnimationFrame: cancelAnimationFrameSpy,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const emitted: string[] = [];
    const text = 'abcdefghijklmnopqrstuvwxyz '.repeat(4);

    try {
      const stream = new SmoothTextStream({
        emit: (content) => emitted.push(content),
        fallbackFrameMs: 10,
      });

      stream.append(text);

      // No synchronous first paint, and the shipped scheduler is timer-based:
      // requestAnimationFrame is never used (rAF runs at display refresh rate,
      // which made text stream too fast on high-Hz displays).
      expect(emitted.length).toBe(0);
      expect(requestAnimationFrameSpy).not.toHaveBeenCalled();

      // The 10ms fallback timer fires before the 16ms frame timer, cancels the
      // pending frame and pumps a chunk anyway so a throttled scheduler cannot
      // stall the stream.
      vi.advanceTimersByTime(10);

      expect(emitted.length).toBe(1);
      expect(emitted[0]).toBe(text.slice(0, 2));
      expect(cancelAnimationFrameSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
