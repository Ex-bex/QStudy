import assert from "node:assert/strict";
import { test } from "node:test";
import { ReadableStream } from "node:stream/web";
import { setImmediate } from "node:timers";
import {
  archiveSelectionError,
  boundedUploadBody,
  isSystemImport,
  MAX_SYSTEM_ARCHIVE_BYTES,
} from "./system-upload.ts";

test("only the exact administrator ZIP import receives the large streaming limit", () => {
  assert.equal(isSystemImport("POST", ["admin", "system", "imports"]), true);
  for (const [method, path] of [
    ["GET", ["admin", "system", "imports"]],
    ["PUT", ["admin", "system", "imports"]],
    ["POST", ["admin", "system", "imports", "anything"]],
    ["POST", ["admin", "system", "imports.zip"]],
    ["POST", ["admin", "backups"]],
    ["POST", ["syllabi"]],
  ])
    assert.equal(isSystemImport(method, path), false);
});

test("archive picker rejects empty, wrong-type and oversized files before transfer", () => {
  assert.equal(
    archiveSelectionError({
      name: "QStudy.ZIP",
      size: MAX_SYSTEM_ARCHIVE_BYTES,
    }),
    "",
  );
  for (const file of [
    { name: "a.pdf", size: 10 },
    { name: "a.zip", size: 0 },
    { name: "a.zip", size: MAX_SYSTEM_ARCHIVE_BYTES + 1 },
    { name: "a.zip", size: NaN },
  ]) {
    assert.ok(archiveSelectionError(file));
  }
});

test("stream passes a boundary-sized archive without buffering or copying chunks", async () => {
  const a = new Uint8Array([1, 2]);
  const b = new Uint8Array([3, 4]);
  const transfer = boundedUploadBody(
    new ReadableStream({
      start(c) {
        c.enqueue(a);
        c.enqueue(b);
        c.close();
      },
    }),
    4,
  );
  const reader = transfer.body.getReader();
  assert.equal((await reader.read()).value, a);
  assert.equal((await reader.read()).value, b);
  assert.equal((await reader.read()).done, true);
  assert.equal(transfer.tooLarge, false);
});

test("stream blocks a dishonest length mid-transfer and cancels its input", async () => {
  let cancelled = false;
  const transfer = boundedUploadBody(
    new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(3));
      },
      cancel() {
        cancelled = true;
      },
    }),
    5,
  );
  const reader = transfer.body.getReader();
  assert.equal((await reader.read()).value.length, 3);
  await assert.rejects(reader.read(), /size limit exceeded/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transfer.tooLarge, true);
  assert.equal(cancelled, true);
});

test("cancelling a browser transfer cancels its upstream source", async () => {
  let cancelled = false;
  const transfer = boundedUploadBody(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  );
  await transfer.body.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});
