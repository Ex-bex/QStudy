import assert from "node:assert/strict";
import { test } from "node:test";
import { assessmentSessionFromQuery } from "./assessment-link.ts";

test("a career evidence link reopens a concrete assessment without accepting arbitrary routes", () => {
  assert.equal(assessmentSessionFromQuery("?session=42"), 42);
  assert.equal(assessmentSessionFromQuery("?course=1&session=7"), 7);
  for (const query of [
    "",
    "?session=0",
    "?session=-1",
    "?session=01",
    "?session=1.2",
    "?session=1e2",
    "?session=9007199254740992",
    "?session=../../admin",
    "?session=1&session=2",
  ])
    assert.equal(assessmentSessionFromQuery(query), null, query);
});
