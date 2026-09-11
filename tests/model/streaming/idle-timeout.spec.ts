import assert from "node:assert/strict";
import test from "node:test";

import {
  StreamIdleTimeoutError,
  readWithIdleTimeout,
  withIdleTimeout,
} from "../../../src/model/streaming/streamModel.js";

// Regression tests for the idle-timeout safety net.
//
// The timeout timer used to be `unref()`d. `unref()` means "do not let this
// timer hold the process open" — so when the stalled source held no libuv
// handle of its own, the event loop drained before the timer could fire, and
// the caller's `await` never settled at all. A stream that hangs silently is
// exactly the case this timer exists to convert into an error, which made the
// unref a safety net that failed precisely when it was needed.
//
// Every one of these tests leaves the process with nothing else pending, which
// is what makes them fail without the fix rather than merely pass with it.

/** A reader whose `read()` never settles — a stalled upstream. */
function stalledReader(): ReadableStreamDefaultReader<Uint8Array> {
  return { read: () => new Promise(() => {}) } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

test("readWithIdleTimeout rejects instead of hanging when the stream stalls", async () => {
  await assert.rejects(
    () => readWithIdleTimeout(stalledReader(), 10),
    (error: unknown) => error instanceof StreamIdleTimeoutError,
  );
});

test("withIdleTimeout rejects with the configured idle interval", async () => {
  await assert.rejects(
    () => withIdleTimeout(() => new Promise(() => {}), 10),
    /Stream idle timeout: no data received for 10ms/,
  );
});

test("withIdleTimeout still resolves when the operation finishes first", async () => {
  assert.equal(await withIdleTimeout(() => Promise.resolve("done"), 5_000), "done");
});

test("withIdleTimeout still rejects when the operation fails first", async () => {
  await assert.rejects(
    () => withIdleTimeout(() => Promise.reject(new Error("upstream said no")), 5_000),
    /upstream said no/,
  );
});

test("withIdleTimeout still honours an abort signal", async () => {
  const controller = new AbortController();
  const pending = withIdleTimeout(() => new Promise(() => {}), 5_000, controller.signal);
  controller.abort();
  await assert.rejects(() => pending, (error: unknown) => error instanceof Error && error.name !== "StreamIdleTimeoutError");
});

test("the timeout fires even when it is the only pending work", async () => {
  // The precise shape of the bug: nothing else keeps the event loop alive, so
  // an unref'd timer never gets to run. Asserting on a real wall-clock wait
  // keeps this honest about what it is testing.
  const started = Date.now();
  await assert.rejects(
    () => withIdleTimeout(() => new Promise(() => {}), 25),
    (error: unknown) => error instanceof StreamIdleTimeoutError,
  );
  assert.ok(Date.now() - started < 5_000, "must settle by the idle interval, not block forever");
});
