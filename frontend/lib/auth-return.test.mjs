import assert from "node:assert/strict";
import { test } from "node:test";
import { authReturnPath } from "./auth-return.ts";

test("authentication returns players to a shared-site LumaBall page", () => {
  for (const path of [
    "/lumaball",
    "/lumaball/play",
    "/lumaball/room/0123456789abcdef0123456789abcdef",
  ])
    assert.equal(authReturnPath(path), path);
});

test("authentication rejects external, encoded and unrelated return destinations", () => {
  for (const value of [
    undefined,
    null,
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/lumaball//evil.example",
    "/lumaball?next=https://evil.example",
    "/lumaball%2f%2fevil.example",
    "/admin",
    "/lumaball/room/../../admin",
    "/lumaball/room/not-a-room",
  ])
    assert.equal(authReturnPath(value), "/dashboard");
});
