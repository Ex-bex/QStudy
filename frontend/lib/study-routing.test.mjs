import assert from "node:assert/strict";
import { test } from "node:test";
import { isStudyManagement, studyPath } from "./study-routing.ts";

test("shared management requires both the admin role and the QControl workspace", () => {
  assert.equal(isStudyManagement("admin", "/qcontrol"), true);
  assert.equal(isStudyManagement("admin", "/qcontrol/qstudy/groups/1"), true);
  for (const role of ["student", undefined, "administrator"])
    assert.equal(isStudyManagement(role, "/qcontrol/qstudy/groups/1"), false);
  for (const path of [
    "/dashboard/groups/1",
    "/dashboard/syllabi",
    "/qcontrol-other",
  ])
    assert.equal(isStudyManagement("admin", path), false);
});

test("curriculum links and deletion returns stay within QControl while preserving selection", () => {
  const current = "/qcontrol/qstudy/groups/1/courses/2";
  for (const [before, after] of [
    ["/dashboard/groups", "/qcontrol/qstudy/groups"],
    ["/dashboard/groups/1/courses/2", "/qcontrol/qstudy/groups/1/courses/2"],
    ["/dashboard/syllabi?course=2", "/qcontrol/qstudy/syllabi?course=2"],
    ["/dashboard/modules?course=2", "/qcontrol/qstudy/modules?course=2"],
    ["/dashboard/subjects#topic", "/qcontrol/qstudy/subjects#topic"],
  ])
    assert.equal(studyPath(before, current), after);
});

test("student navigation and personal learning actions keep their QStudy routes", () => {
  const paths = [
    "/dashboard/tests?course=2",
    "/dashboard/lectures/1/2",
    "/dashboard/notes",
    "/dashboard/subjects-extra",
    "https://example.com/dashboard/groups",
    "//example.com/dashboard/groups",
  ];
  for (const href of paths)
    assert.equal(studyPath(href, "/qcontrol/qstudy/subjects"), href);
  assert.equal(
    studyPath("/dashboard/groups/1", "/dashboard/modules"),
    "/dashboard/groups/1",
  );
  assert.equal(
    studyPath("/dashboard/groups/1", "/qcontrol-other"),
    "/dashboard/groups/1",
  );
});
