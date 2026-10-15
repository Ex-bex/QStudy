import assert from "node:assert/strict";
import { test } from "node:test";
import { authReturnPath } from "./auth-return.ts";

test("authentication returns players to a shared-site QBall page", () => {
  for (const path of [
    "/qball",
    "/qball/play",
    "/qball/room/0123456789abcdef0123456789abcdef",
  ])
    assert.equal(authReturnPath(path), path);
});

test("old game sign-in destinations return to the matching QBall page", () => {
  for (const suffix of ["", "/play", "/room/0123456789abcdef0123456789abcdef"])
    assert.equal(authReturnPath(`/lumaball${suffix}`), `/qball${suffix}`);
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
    "/qball//evil.example",
    "/qball?next=https://evil.example",
    "/qball%2f%2fevil.example",
    "/qball/room/../../admin",
    "/qball/room/not-a-room",
  ])
    assert.equal(authReturnPath(value), "/dashboard");
});
