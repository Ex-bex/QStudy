import assert from "node:assert/strict";
import { test } from "node:test";
import { learningActivityContext } from "./context.ts";
import {
  emptyLearningSelection,
  learningHref,
  learningSelectionError,
  learningSelectionFromQuery,
  learningSelectionFromSource,
  learningSourceActivity,
  safeResearchUrl,
} from "./learning-selection.ts";

const courses = [
  {
    id: 3,
    title: "Алгоритмы",
    group_id: 2,
    group_name: "ИП-26-3кс",
    modules: ["Модуль 1", "Модуль 2"],
    weeks: [
      { week_number: 1, title: "Основы", module: "Модуль 1" },
      { week_number: 2, title: "Графы", module: "Модуль 2" },
    ],
    works: [
      { id: 10, title: "Практика", module: "Модуль 1", week_number: 1 },
      { id: 11, title: "Графы", module: "Модуль 2", week_number: 2 },
      { id: 12, title: "Итог", module: "Модуль 1", week_number: null },
    ],
  },
];

test("course shortcuts preserve Cyrillic modules, selected weeks and work IDs", () => {
  const selection = {
    course_id: 3,
    module: "Модуль 1 & практика",
    week_numbers: [1, 2],
    work_ids: [10],
    use_web: false,
  };
  const href = learningHref("/dashboard/tests", selection);
  assert.ok(href.startsWith("/dashboard/tests?"));
  assert.deepEqual(
    learningSelectionFromQuery(href.slice(href.indexOf("?"))),
    selection,
  );
});

test("malformed URL IDs never become numeric selections and duplicates are removed", () => {
  const selection = learningSelectionFromQuery(
    "?course=3&weeks=1,1,-2,NaN,1.5,2&works=10,10,Infinity,0,11",
  );
  assert.deepEqual(selection.week_numbers, [1, 2]);
  assert.deepEqual(selection.work_ids, [10, 11]);
  for (const course of [
    "-3",
    "NaN",
    "Infinity",
    "3.2",
    "0",
    "999999999999999999999",
  ])
    assert.equal(
      learningSelectionFromQuery(`?course=${course}`).course_id,
      null,
    );
});

test("personal defaults request internet without inventing curriculum fields", () => {
  assert.deepEqual(emptyLearningSelection(), {
    course_id: null,
    module: "",
    week_numbers: [],
    work_ids: [],
    use_web: true,
  });
  assert.deepEqual(learningSelectionFromQuery(""), emptyLearningSelection());
  assert.equal(learningHref("/dashboard/chat", {}), "/dashboard/chat");
});

test("stale or inaccessible course selection blocks generation instead of broadening it", () => {
  assert.ok(
    learningSelectionError(
      { ...emptyLearningSelection(), course_id: 77 },
      courses,
    ),
  );
  assert.ok(
    learningSelectionError({ ...emptyLearningSelection(), course_id: 3 }, []),
  );
  assert.ok(
    learningSelectionError(
      { ...emptyLearningSelection(), course_id: 3, module: "Неизвестный" },
      courses,
    ),
  );
  assert.ok(
    learningSelectionError(
      { ...emptyLearningSelection(), course_id: 3, work_ids: [999] },
      courses,
    ),
  );
});

test("module, week and work selectors intersect and preserve explicit work targeting", () => {
  const selection = {
    ...emptyLearningSelection(),
    course_id: 3,
    module: "Модуль 1",
    week_numbers: [1],
    work_ids: [10],
  };
  assert.equal(learningSelectionError(selection, courses), "");
  assert.ok(
    learningSelectionError({ ...selection, week_numbers: [2] }, courses),
  );
  assert.ok(learningSelectionError({ ...selection, work_ids: [11] }, courses));
  assert.ok(learningSelectionError({ ...selection, work_ids: [12] }, courses));
  assert.equal(
    learningSelectionError(
      { ...selection, week_numbers: [], work_ids: [12] },
      courses,
    ),
    "",
  );
});

test("an empty curriculum cannot generate a fictional syllabus scope", () => {
  assert.ok(
    learningSelectionError({ ...emptyLearningSelection(), course_id: 3 }, [
      { ...courses[0], weeks: [], works: [] },
    ]),
  );
});

test("source links reject script, data and credential URLs", () => {
  for (const input of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///C:/private",
    "https://user:secret@example.com",
    null,
    {},
    "/relative",
  ])
    assert.equal(safeResearchUrl(input), null);
  assert.equal(
    safeResearchUrl("https://example.com/lesson?a=1"),
    "https://example.com/lesson?a=1",
  );
});

test("new chat selection replaces legacy single-week scope without mutating stored activity", () => {
  const activity = {
    page: "tasks",
    course_id: 3,
    week_number: 1,
    use_web: false,
    task: { question: "Вопрос", status: "new" },
  };
  const selected = {
    ...emptyLearningSelection(),
    course_id: 3,
    module: "Модуль 2",
    week_numbers: [2],
    work_ids: [11],
  };
  const result = learningActivityContext(activity, selected);
  assert.equal(result.week_number, undefined);
  assert.equal(result.use_web, undefined);
  assert.deepEqual(result.week_numbers, [2]);
  assert.deepEqual(result.work_ids, [11]);
  assert.equal(activity.week_number, 1);
  assert.deepEqual(result.task, activity.task);
});

test("switching chat course or personal mode clears previous course lecture/task context", () => {
  const activity = {
    page: "lectures",
    course_id: 3,
    lecture: { title: "Старая лекция", content: "Учебный текст" },
    task: { question: "Старый вопрос", status: "new" },
    subject: "Старый предмет",
  };
  for (const course_id of [null, 8]) {
    const result = learningActivityContext(activity, {
      ...emptyLearningSelection(),
      course_id,
    });
    assert.equal(result.lecture, undefined);
    assert.equal(result.task, undefined);
    assert.equal(result.subject, undefined);
    assert.equal(result.page, "chat");
    assert.equal(result.course_id, course_id || undefined);
  }
});

test("history module restores its own course and lessons without reinterpreting expanded work IDs", () => {
  const saved = {
    mode: "course",
    course_id: 3,
    course_title: "Алгоритмы",
    module: "Модуль 1",
    week_numbers: [1],
    work_ids: [10, 12],
    weeks: [{ week_number: 1, title: "Основы", module: "Модуль 1" }],
    works: courses[0].works.filter((work) => work.module === "Модуль 1"),
  };
  const activity = {
    page: "tests",
    course_id: 99,
    module: "Другой модуль",
    work_ids: [999],
    ...learningSourceActivity(saved),
  };
  const prefilled = learningSelectionFromQuery(
    learningHref("", activity).slice(1),
  );
  assert.equal(prefilled.course_id, 3);
  assert.equal(prefilled.module, "Модуль 1");
  assert.deepEqual(prefilled.week_numbers, [1]);
  assert.deepEqual(prefilled.work_ids, []);
  assert.equal(learningSelectionError(prefilled, courses), "");
  assert.deepEqual(learningActivityContext(activity, prefilled).work_ids, []);
  assert.deepEqual(saved.work_ids, [10, 12]);
});

test("history work-only scope stays exact and personal artifacts clear an unrelated course selector", () => {
  const saved = {
    mode: "course",
    course_id: 3,
    module: "Модуль 1",
    week_numbers: [1],
    work_ids: [10],
    weeks: [],
    works: [courses[0].works[0]],
  };
  const prefilled = learningSelectionFromSource(saved);
  assert.deepEqual(prefilled.work_ids, [10]);
  assert.deepEqual(prefilled.week_numbers, []);
  assert.equal(learningSelectionError(prefilled, courses), "");
  const personal = {
    course_id: 99,
    work_ids: [999],
    ...learningSourceActivity({
      mode: "personal",
      subject_titles: ["Математика"],
    }),
  };
  assert.equal(personal.course_id, undefined);
  assert.equal(personal.work_ids, undefined);
  assert.equal(personal.subject, "Математика");
});

test("work/week intersection matches backend and accepts work-only weeks without a lesson row", () => {
  assert.ok(
    learningSelectionError(
      {
        ...emptyLearningSelection(),
        course_id: 3,
        week_numbers: [1, 2],
        work_ids: [10],
      },
      courses,
    ),
  );
  const worksOnly = [
    {
      ...courses[0],
      weeks: [],
      works: [{ id: 20, title: "Работа", module: "Модуль 1", week_number: 3 }],
    },
  ];
  assert.equal(
    learningSelectionError(
      {
        ...emptyLearningSelection(),
        course_id: 3,
        week_numbers: [3],
        work_ids: [20],
      },
      worksOnly,
    ),
    "",
  );
  assert.ok(
    learningSelectionError(
      { ...emptyLearningSelection(), course_id: 3, week_numbers: [53] },
      courses,
    ),
  );
});
