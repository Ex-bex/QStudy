import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSyllabusDraft } from "./syllabus-draft.ts";

test("empty and absent API drafts keep preview and editor arrays usable", () => {
  for (const input of [undefined, null, {}, false, [], "legacy value"]) {
    const normalized = normalizeSyllabusDraft(input, {
      title: "Документ",
      summary: "Описание",
    });
    assert.deepEqual(normalized, {
      title: "Документ",
      summary: "Описание",
      weeks: [],
      works: [],
      course_facts: null,
    });
    assert.equal(normalized.weeks.length + normalized.works.length, 0);
  }
});

test("partial drafts preserve existing text and fill missing row fields", () => {
  const normalized = normalizeSyllabusDraft({
    weeks: [{ week_number: 2, title: "Практика", tasks: "Решить задачи" }],
    works: [{ title: "Модуль" }],
  });
  assert.deepEqual(normalized.weeks[0], {
    week_number: 2,
    title: "Практика",
    tasks: "Решить задачи",
    content: "",
    assessment: "",
    hours: 0,
    module: "",
    resources: "",
  });
  assert.deepEqual(normalized.works[0], {
    title: "Модуль",
    description: "",
    module: "",
    week_number: null,
    max_score: 100,
    kind: "assignment",
  });
  assert.equal(normalized.works.map((work) => work.title).join(""), "Модуль");
});

test("malformed arrays and rows cannot become React children or break map", () => {
  const normalized = normalizeSyllabusDraft({
    title: {},
    summary: [],
    weeks: { length: 5 },
    works: [
      null,
      "invalid",
      [],
      { title: { html: "bad" }, description: null, max_score: NaN },
    ],
  });
  assert.deepEqual(normalized.weeks, []);
  assert.equal(normalized.works.length, 1);
  assert.equal(normalized.works[0].title, "");
  assert.equal(normalized.works[0].description, "");
  assert.equal(normalized.works[0].max_score, 100);
});

test("legacy visible weeks work without a draft and do not leak storage IDs into saves", () => {
  const normalized = normalizeSyllabusDraft(null, {
    weeks: [
      null,
      {
        id: 8,
        course_id: 4,
        source_syllabus_id: 3,
        week_number: 7,
        title: "Контроль",
      },
    ],
  });
  assert.equal(normalized.weeks[0].week_number, 7);
  assert.equal(normalized.weeks[0].title, "Контроль");
  assert.equal("id" in normalized.weeks[0], false);
  assert.equal("source_syllabus_id" in normalized.weeks[0], false);
  assert.deepEqual(
    normalizeSyllabusDraft({ weeks: [] }, { weeks: normalized.weeks }).weeks,
    [],
  );
});

test("normalizing does not mutate the API response or discard a complete valid draft", () => {
  const draft = {
    title: "План",
    summary: "Программа",
    course_facts: null,
    weeks: [
      {
        week_number: 1,
        title: "Тема",
        content: "Содержание",
        tasks: "Задания",
        assessment: "Критерии",
        hours: 2,
        module: "Модуль",
        resources: "Учебник",
      },
    ],
    works: [
      {
        title: "Экзамен",
        description: "Ответ",
        module: "Модуль",
        week_number: 1,
        max_score: 25,
        kind: "exam",
      },
    ],
  };
  const original = JSON.parse(JSON.stringify(draft));
  const normalized = normalizeSyllabusDraft(draft);
  assert.deepEqual(normalized, original);
  normalized.weeks[0].title = "Изменено в редакторе";
  assert.deepEqual(draft, original);
});

test("missing week numbers are not silently invented by normalization", () => {
  const normalized = normalizeSyllabusDraft({
    weeks: [{ title: "Тема без недели" }],
  });
  assert.equal(normalized.weeks[0].week_number, 0);
  assert.equal(normalized.weeks[0].title, "Тема без недели");
});

test("explicit syllabus facts survive normalization and manual draft editing", () => {
  const facts = {
    credits: 3.5,
    teacher: "А. Есенов",
    total_hours: 105,
    source_group: "ИП-26-3кс",
    semester: 4,
  };
  const source = { summary: "Описание", course_facts: facts };
  const normalized = normalizeSyllabusDraft(source);
  assert.deepEqual(normalized.course_facts, facts);
  const edited = {
    ...normalized,
    summary: "Исправлено вручную",
    weeks: [{ week_number: 1, title: "Тема" }],
  };
  assert.deepEqual(normalizeSyllabusDraft(edited).course_facts, facts);
  normalized.course_facts.teacher = "Изменено в состоянии";
  assert.equal(source.course_facts.teacher, "А. Есенов");
});

test("published student metadata is preserved without exposing a private draft", () => {
  const facts = {
    credits: 2,
    teacher: "Преподаватель",
    total_hours: null,
    source_group: "",
    semester: null,
  };
  assert.deepEqual(
    normalizeSyllabusDraft(null, { course_facts: facts }).course_facts,
    facts,
  );
  assert.equal(
    normalizeSyllabusDraft({ course_facts: null }, { course_facts: facts })
      .course_facts,
    null,
  );
});

test("missing or malformed course facts never invent numeric or textual values", () => {
  for (const input of [undefined, null, [], "unexpected", false]) {
    assert.equal(
      normalizeSyllabusDraft({ course_facts: input }).course_facts,
      null,
    );
  }
  assert.deepEqual(
    normalizeSyllabusDraft({
      course_facts: {
        credits: "3",
        teacher: "-",
        total_hours: Infinity,
        source_group: [],
        semester: 1.5,
      },
    }).course_facts,
    {
      credits: null,
      teacher: "",
      total_hours: null,
      source_group: "",
      semester: null,
    },
  );
  assert.deepEqual(
    normalizeSyllabusDraft({
      course_facts: {
        credits: 0,
        teacher: {},
        total_hours: -5,
        source_group: " — ",
        semester: 17,
      },
    }).course_facts,
    {
      credits: null,
      teacher: "",
      total_hours: null,
      source_group: "",
      semester: null,
    },
  );
  assert.deepEqual(normalizeSyllabusDraft({ course_facts: {} }).course_facts, {
    credits: null,
    teacher: "",
    total_hours: null,
    source_group: "",
    semester: null,
  });
});
