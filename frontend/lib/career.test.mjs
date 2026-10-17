import assert from "node:assert/strict";
import { test } from "node:test";
import {
  careerLearningHref,
  careerExternalHref,
  careerPercent,
  careerInterests,
  careerTab,
  careerDate,
} from "./career.ts";

test("career curriculum links preserve exact module context and stay within shared learning routes", () => {
  const href =
    "/dashboard/tests?course=260&module=%D0%9C%D0%BE%D0%B4%D1%83%D0%BB%D1%8C+1&week=2&work=13";
  assert.equal(careerLearningHref(href), href);
  assert.equal(
    careerLearningHref("/dashboard/groups/61/courses/260#week-2"),
    "/dashboard/groups/61/courses/260#week-2",
  );
  for (const unsafe of [
    "https://evil.test/dashboard/tests",
    "//evil.test/dashboard/tests",
    "/dashboard/../admin",
    "/dashboard/admin",
    "/dashboard/tests\\evil",
    "javascript:alert(1)",
    "/dashboard/tests\n",
    "/dashboard/groups/x/courses/1",
    null,
  ])
    assert.equal(careerLearningHref(unsafe), null, String(unsafe));
});

test("curated opportunity links reject code, credentials and parser confusion", () => {
  assert.equal(
    careerExternalHref("https://example.org/internship?id=9"),
    "https://example.org/internship?id=9",
  );
  assert.equal(
    careerExternalHref("http://example.org/"),
    "http://example.org/",
  );
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,x",
    "https://user:password@example.org/",
    "//example.org/",
    "https:\\example.org",
    "https://example.org/\n",
    "",
    undefined,
  ])
    assert.equal(careerExternalHref(value), null, String(value));
});

test("no target readiness is unknown rather than fabricated zero", () => {
  for (const value of [undefined, null, NaN, Infinity])
    assert.equal(careerPercent(value), null);
  assert.equal(careerPercent(67.6), 68);
  assert.equal(careerPercent(150), 100);
  assert.equal(careerPercent(-2), 0);
});

test("profile interest editing trims and deduplicates without inventing interest scores", () => {
  assert.deepEqual(careerInterests(" Python, аналитика; Python\n дизайн, "), [
    "Python",
    "аналитика",
    "дизайн",
  ]);
  assert.deepEqual(careerInterests(" ,;\n "), []);
  assert.equal(careerTab("profile"), "profile");
  assert.equal(careerTab("<script>"), "overview");
  assert.equal(careerDate("not a date"), "");
});
