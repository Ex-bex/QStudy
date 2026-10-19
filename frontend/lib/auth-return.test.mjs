import assert from "node:assert/strict";
import { test } from "node:test";
import { authReturnPath } from "./auth-return.ts";

test("QMessage returns to a selected local conversation without accepting other query parameters", () => {
  for (const value of [
    "/qmessage",
    "/qmessage/chats",
    "/qmessage/chats?chat=12",
    "/qcontrol/qmessage",
  ])
    assert.equal(authReturnPath(value), value);
  for (const value of [
    "/qmessage/chats?chat=0",
    "/qmessage/chats?chat=-1",
    "/qmessage/chats?chat=1&next=https://evil.example",
    "/qmessage/chats?chat=1&chat=2",
    "/qmessage//evil.example",
    "/qmessage/chats?chat=999999999999999999999",
    "/qmessage/chats?chat=%31",
    "/qmessage/../admin",
  ])
    assert.equal(authReturnPath(value), "/dashboard");
});

test("QTests resumes only a local bank, attempt or library after Q-ID login", () => {
  for (const value of [
    "/qtests",
    "/qtests/library",
    "/qtests/banks/19",
    "/qtests/attempts/3",
    "/qcontrol/qtests",
  ])
    assert.equal(authReturnPath(value), value);
  for (const value of [
    "/qtests//evil.example",
    "/qtests/banks/0",
    "/qtests/attempts/-1",
    "/qtests/library?next=https://evil.example",
    "/qtests/banks/2/../../admin",
    "/qtests%2flibrary",
  ])
    assert.equal(authReturnPath(value), "/dashboard");
});

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

test("QCareer reuses QStudy login with exact safe workspace destinations", () => {
  for (const value of ["/qcareer", "/qcareer/workspace"])
    assert.equal(authReturnPath(value), value);
  for (const value of [
    "/qcareer//evil.example",
    "/qcareer/workspace?next=https://evil.example",
    "/qcareer%2fworkspace",
    "/qcareer/../admin",
  ])
    assert.equal(authReturnPath(value), "/dashboard");
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

test("QControl returns stay inside known management routes and reject ambiguous paths", () => {
  for (const value of [
    "/qcontrol",
    "/qcontrol/accounts",
    "/qcontrol/system",
    "/qcontrol/qstudy/groups/2/courses/31",
  ])
    assert.equal(authReturnPath(value), value);
  for (const value of [
    "/qcontrol//evil.example",
    "/qcontrol/../admin",
    "/qcontrol/system?next=https://evil.example",
    "/qcontrol%2fsystem",
    "/qcontrol/unknown",
    "/qcontrol/qstudy/groups/0",
    "/qcontrol/qstudy/groups/2/courses/-1",
  ])
    assert.equal(authReturnPath(value), "/dashboard");
});
