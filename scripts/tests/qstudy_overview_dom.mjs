/**
 * Actual QStudy overview React DOM checks: independent failures and retries,
 * group/account races, timetable links, no invented end times, search and empty
 * states. No live accounts/API are modified; this is not visual browser QA.
 * node scripts/tests/qstudy_overview_dom.mjs --run --jsdom .local/qtests-ui-qa/node_modules/jsdom
 */
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--run")) {
  console.log("SKIP: opt in with --run and optionally --jsdom <package path>.");
  process.exit(0);
}
const project = fileURLToPath(new URL("../..", import.meta.url));
const appRequire = Module.createRequire(
  path.join(project, "frontend/package.json"),
);
const scriptRequire = Module.createRequire(import.meta.url);
const argument = process.argv.indexOf("--jsdom");
if (argument !== -1 && !process.argv[argument + 1])
  throw new Error("--jsdom requires an installed package path");
const { JSDOM } =
  argument === -1
    ? appRequire("jsdom")
    : scriptRequire(path.resolve(process.argv[argument + 1]));
const dom = new JSDOM(
  '<!doctype html><html><body><div id="root"></div></body></html>',
  { url: "http://localhost/dashboard" },
);
for (const name of [
  "window",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "MouseEvent",
  "Node",
])
  global[name] = dom.window[name];
Object.defineProperty(global, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = appRequire("react");
const { act } = React;
const { createRoot } = appRequire("react-dom/client");
const ts = appRequire("typescript");
let user = {
  id: 1,
  name: "Алина Тестовая",
  email: "fixture@example.test",
  group_id: 1,
};
let failNotes = true;
const requests = [];
const heldGroups = new Map();
let holdNotes = null;
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const now = new Date();
const dateParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Almaty",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).formatToParts(now);
const part = (name) => dateParts.find((item) => item.type === name).value;
const day = `${part("year")}-${part("month")}-${part("day")}`;
const dayOfWeek = new Date(`${day}T12:00:00Z`).getUTCDay() || 7;
function group(id) {
  return {
    id,
    name: `Группа ${id}`,
    courses: [],
    schedule: [
      {
        id: id * 10,
        group_id: id,
        course_id: id * 100,
        course_title: `Дисциплина ${id}`,
        day_of_week: dayOfWeek,
        start_time: "08:00",
        start_times: ["08:00", "08:50"],
        end_time: null,
        room: "204",
        lesson_type: "Практика",
        week_pattern: "unspecified",
        teacher: "Преподаватель",
        source_file: "fixture.xlsx",
        source_updated_at: "2026-10-01",
      },
    ],
  };
}
async function api(request, options) {
  requests.push({ request, options });
  if (request === "/notes") {
    if (holdNotes) return holdNotes.promise;
    if (failNotes) throw new Error("Заметки временно недоступны");
    return [
      {
        id: 1,
        title: `Заметка пользователя ${user.id}`,
        updated_at: "2026-10-01T10:00:00Z",
      },
    ];
  }
  if (request.startsWith("/groups/")) {
    const id = Number(request.split("/").at(-1));
    return heldGroups.has(id) ? heldGroups.get(id).promise : group(id);
  }
  if (request.startsWith("/search?"))
    return {
      notes: [{ id: 5, title: "Найденный конспект", snippet: "Фрагмент" }],
      materials: [],
      tasks: [],
      cards: [],
    };
  throw new Error(`Unexpected API request: ${request}`);
}
const modules = new Map();
function load(relative) {
  const filename = path.join(project, "frontend", relative);
  if (modules.has(filename)) return modules.get(filename).exports;
  const target = new Module(filename);
  modules.set(filename, target);
  target.filename = filename;
  target.paths = Module._nodeModulePaths(path.dirname(filename));
  target.require = (request) => {
    if (request === "@/lib/api") return { api };
    if (request === "@/lib/auth") return { useAuth: () => ({ user }) };
    if (request === "next/link")
      return {
        __esModule: true,
        default: ({ children, ...props }) =>
          React.createElement("a", props, children),
      };
    if (request.endsWith(".css"))
      return {
        __esModule: true,
        default: new Proxy({}, { get: (_, key) => key }),
      };
    if (request.startsWith("@/")) return load(request.slice(2) + ".ts");
    return appRequire(request);
  };
  target._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    filename,
  );
  return target.exports;
}
const Page = load("app/dashboard/page.tsx").default;
const root = createRoot(document.getElementById("root"));
async function flush(action = () => {}) {
  await act(async () => {
    await action();
    await new Promise((done) => setTimeout(done, 5));
  });
}
const text = () => document.body.textContent;
const button = (label) =>
  [...document.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
const render = () => flush(() => root.render(React.createElement(Page)));
try {
  await render();
  assert.ok(
    text().includes("Дисциплина 1"),
    "notes failure does not suppress schedule",
  );
  assert.ok(text().includes("Заметки временно недоступны"));
  assert.equal(
    document.querySelector(".lesson").getAttribute("href"),
    "/dashboard/groups/1/courses/100",
  );
  assert.ok(
    document.querySelector(".time").textContent.includes("08:00 / 08:50"),
  );
  assert.ok(
    !document.querySelector(".time").textContent.includes("—"),
    "no invented ending",
  );
  assert.ok(text().includes("Периодичность не указана"));
  assert.equal(document.querySelector(".source").open, false);
  assert.equal(document.querySelector(".search").open, false);
  assert.equal(requests.length, 2, "overview only loads group and notes");
  assert.ok(
    !text().includes("МАЛЕНЬКИЕ ШАГИ") && !text().includes("QSTUDY AI"),
  );

  failNotes = false;
  await flush(() => button("Повторить загрузку заметок").click());
  assert.ok(text().includes("Заметка пользователя 1"));
  assert.ok(!text().includes("Заметки временно недоступны"));
  assert.equal(
    requests.filter(({ request }) => request.startsWith("/groups/")).length,
    1,
    "notes retry does not refetch schedule",
  );

  const input = document.querySelector(
    'input[aria-label="Поиск по личным материалам"]',
  );
  await flush(() => {
    document.querySelector(".search").open = true;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set.call(input, "конспект");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush(() =>
    document
      .querySelector("form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  assert.ok(text().includes("Найденный конспект"));
  assert.ok(
    requests.some(
      ({ request }) =>
        request ===
        "/search?q=%D0%BA%D0%BE%D0%BD%D1%81%D0%BF%D0%B5%D0%BA%D1%82",
    ),
  );

  heldGroups.set(2, deferred());
  user = { ...user, group_id: 2 };
  await render();
  assert.ok(
    !text().includes("Дисциплина 1"),
    "old group hidden while replacement is loading",
  );
  assert.ok(text().includes("Загружаем расписание"));
  await flush(() => heldGroups.get(2).resolve(group(2)));
  assert.ok(text().includes("Дисциплина 2"));

  heldGroups.set(3, deferred());
  heldGroups.set(4, deferred());
  user = { ...user, group_id: 3 };
  await render();
  const group3Request = requests.find(({ request }) => request === "/groups/3");
  user = { ...user, group_id: 4 };
  await render();
  assert.ok(
    group3Request.options.signal.aborted,
    "old group request is cancelled",
  );
  await flush(() => heldGroups.get(4).resolve(group(4)));
  await flush(() => heldGroups.get(3).resolve(group(3)));
  assert.ok(
    text().includes("Дисциплина 4") && !text().includes("Дисциплина 3"),
    "late old response cannot overwrite current group",
  );

  holdNotes = deferred();
  user = { ...user, id: 2 };
  await render();
  assert.ok(
    !text().includes("Заметка пользователя 1"),
    "old account notes hidden immediately",
  );
  assert.ok(
    !text().includes("Найденный конспект"),
    "old account search results hidden",
  );
  await flush(() =>
    holdNotes.resolve([{ id: 7, title: "Новая личная заметка" }]),
  );
  assert.ok(text().includes("Новая личная заметка"));
  holdNotes = null;

  user = { ...user, group_id: null };
  const before = requests.length;
  await render();
  assert.ok(text().includes("Группа ещё не выбрана"));
  assert.ok(text().includes("Попросите администратора назначить вам группу"));
  assert.ok(document.querySelector('a[href="/dashboard/profile"]'));
  assert.ok(
    !requests
      .slice(before)
      .some(({ request }) => request.startsWith("/groups/")),
    "no group request without assignment",
  );
  assert.ok(!text().includes("Дисциплина 4"));
  console.log(
    "QStudy overview DOM PASS: independent errors/retry, schedule fidelity, search, group/account isolation and empty state.",
  );
} finally {
  await flush(() => root.unmount());
  dom.window.close();
}
