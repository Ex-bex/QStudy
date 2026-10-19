/**
 * React DOM regression tests for QMessage administration and independent branding.
 * No real accounts or backend are used. API/auth/Next image boundaries are mocked;
 * actual QMessage provider, logo, QControl, resource hooks, PNG input, React state,
 * FormData, moderation confirmations and DOM events are exercised.
 * This is not browser visual testing.
 *
 * Run from the repository root with an isolated DOM test dependency:
 * npm install --prefix .local/qtests-ui-qa --no-save --package-lock=false --ignore-scripts jsdom@26.1.0
 * node scripts/tests/qmessage_admin_dom.mjs --run --jsdom .local/qtests-ui-qa/node_modules/jsdom
 * If jsdom is already installed in frontend, --jsdom is optional.
 */
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--run")) {
  console.log(
    "SKIP: opt in with --run. Supply --jsdom <installed jsdom package path> if it is not installed in frontend.",
  );
  process.exit(0);
}
const project = fileURLToPath(new URL("../..", import.meta.url));
const appRequire = Module.createRequire(
  path.join(project, "frontend/package.json"),
);
const scriptRequire = Module.createRequire(import.meta.url);
const dependencyArgument = process.argv.indexOf("--jsdom");
let JSDOM;
try {
  if (dependencyArgument !== -1 && !process.argv[dependencyArgument + 1]) {
    throw new Error("--jsdom requires the path to an installed jsdom package.");
  }
  ({ JSDOM } =
    dependencyArgument === -1
      ? appRequire("jsdom")
      : scriptRequire(
          path.resolve(process.cwd(), process.argv[dependencyArgument + 1]),
        ));
} catch (cause) {
  console.error(
    "Cannot load DOM test dependency. Install jsdom in an isolated directory and pass --jsdom <package path>. See the script header.",
  );
  console.error(cause.message);
  process.exit(1);
}
const dom = new JSDOM(
  '<!doctype html><html><body><div id="root"></div></body></html>',
  { url: "http://localhost/" },
);
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "FormData",
  "File",
  "Event",
  "MouseEvent",
  "CustomEvent",
  "Node",
])
  global[key] = dom.window[key];
Object.defineProperty(global, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = appRequire("react");
const { act } = React;
const { createRoot } = appRequire("react-dom/client");
const ts = appRequire("typescript");
global.localStorage = dom.window.localStorage;
dom.window.Blob.prototype.arrayBuffer = function () {
  return new Promise((resolve, reject) => {
    const reader = new dom.window.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(this);
  });
};
const defaultLogo = "/brand/qmessage-prototype.svg";
const asset = (character) =>
  `/api/branding/assets/qmessage/${character.repeat(64)}.png`;
let currentLogo = { logo_url: defaultLogo, logo_custom: false };
let config = {
  enabled: true,
  title: "QMessage",
  announcement: "Начальное объявление",
};
const user = {
  id: 7,
  name: "Тестовый участник",
  group_name: "ИП-26-3кс",
  role: "student",
  is_active: true,
  banned: false,
  ban_reason: "",
};
let users = [user];
let stickers = [
  {
    id: "wave",
    label: "Привет",
    emoji: "👋",
    image_url: "/qmessage-stickers/wave.svg",
    active: true,
    position: 0,
    builtin: true,
  },
];
let reports = [
  {
    id: 1,
    message_id: 12,
    reporter: { id: 8, name: "Автор жалобы" },
    author: user,
    reason: "Проверка модерации",
    status: "open",
    created_at: "2026-10-19T10:00:00Z",
    message: {
      id: 12,
      text: "Только отмеченное сообщение",
      deleted: false,
      sticker: null,
      attachment: {
        filename: "reported.png",
        url: "/api/admin/qmessage/reports/1/attachment",
      },
    },
  },
];
let apiCalls = [];
let role = "admin";
let failBan = false;
let failLogo = false;
let logoHold = null;
let userRequests = 0;
const clone = (value) => JSON.parse(JSON.stringify(value));
const api = async (url, options = {}) => {
  apiCalls.push({ url, options });
  if (url === "/branding/message") {
    const value = { ...currentLogo };
    if (logoHold) await logoHold;
    return value;
  }
  if (url === "/branding/message-logo") {
    if (failLogo) throw new Error("Логотип временно не сохранён.");
    currentLogo =
      options.method === "DELETE"
        ? { logo_url: defaultLogo, logo_custom: false }
        : { logo_url: asset("a"), logo_custom: true };
    return clone(currentLogo);
  }
  if (url === "/admin/qmessage/overview")
    return clone({
      settings: config,
      stats: {
        users: users.length,
        messages: 12,
        conversations: 1,
        open_reports: reports.filter((report) => report.status === "open")
          .length,
        stickers: stickers.length,
        banned_users: users.filter((row) => row.banned).length,
      },
    });
  if (url === "/admin/qmessage/settings") {
    config = { ...config, ...JSON.parse(options.body) };
    return clone(config);
  }
  if (url.startsWith("/admin/qmessage/users?")) {
    userRequests++;
    return { items: clone(users) };
  }
  if (url === "/admin/qmessage/users/7/ban") {
    if (failBan)
      throw new Error("Ограничение не сохранено. Повторите попытку.");
    const body = JSON.parse(options.body);
    users = [
      {
        ...users[0],
        banned: body.banned,
        ban_reason: body.banned ? body.reason : "",
      },
    ];
    return clone(users[0]);
  }
  if (url.startsWith("/admin/qmessage/reports?")) {
    const status = new URL("http://localhost" + url).searchParams.get("status");
    return {
      items: clone(
        reports.filter(
          (report) => status === "all" || report.status === status,
        ),
      ),
    };
  }
  if (url === "/admin/qmessage/reports/1/resolve") {
    const body = JSON.parse(options.body);
    reports = reports.map((report) => ({
      ...report,
      status: "resolved",
      message: body.delete_message
        ? { ...report.message, text: "", deleted: true, attachment: null }
        : report.message,
    }));
    return { id: 1, status: "resolved" };
  }
  if (url === "/admin/qmessage/stickers") {
    if (options.method === "POST") {
      const item = {
        ...JSON.parse(options.body),
        image_url: null,
        builtin: false,
      };
      stickers.push(item);
      return clone(item);
    }
    return { items: clone(stickers) };
  }
  const match = /^\/admin\/qmessage\/stickers\/([^/]+)(\/image)?$/.exec(url);
  if (match) {
    const item = stickers.find((row) => row.id === match[1]);
    assert.ok(item);
    if (match[2]) {
      item.image_url =
        options.method === "DELETE"
          ? item.builtin
            ? `/qmessage-stickers/${item.id}.svg`
            : null
          : `/api/qmessage/stickers/${item.id}/image`;
      return clone(item);
    }
    if (options.method === "DELETE") {
      item.active = false;
      return { ok: true };
    }
    assert.equal(options.method, "PATCH");
    Object.assign(item, JSON.parse(options.body));
    return clone(item);
  }
  throw new Error("Unexpected API call: " + url);
};
let objectUrlIndex = 0;
URL.createObjectURL = () => `blob:qmessage-test-${++objectUrlIndex}`;
URL.revokeObjectURL = () => {};
const modules = new Map();
const ImageMock = ({ fill, unoptimized, priority, ...props }) =>
  React.createElement("img", props);
function load(relative) {
  const filename = path.join(project, "frontend", relative);
  if (modules.has(filename)) return modules.get(filename).exports;
  const target = new Module(filename);
  modules.set(filename, target);
  target.filename = filename;
  target.paths = Module._nodeModulePaths(path.dirname(filename));
  target.require = (request) => {
    if (request === "@/lib/api") return { api };
    if (request === "@/lib/auth")
      return { useAuth: () => ({ user: { role } }) };
    if (request === "next/image")
      return { __esModule: true, default: ImageMock };
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
    let resolved;
    if (request.startsWith("@/")) resolved = request.slice(2);
    else if (request.startsWith("."))
      resolved = path.join(path.dirname(relative), request);
    if (resolved) {
      if (!/\.[cm]?[jt]sx?$/.test(resolved))
        resolved += fs.existsSync(
          path.join(project, "frontend", resolved + ".tsx"),
        )
          ? ".tsx"
          : ".ts";
      return load(resolved);
    }
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
const branding = load("components/qmessage-brand.tsx");
const Admin = load("components/control/qmessage-admin.tsx").default;
function Harness() {
  return React.createElement(
    branding.QMessageBrandingProvider,
    null,
    React.createElement(branding.QMessageLogo, {
      alt: "Live QMessage",
      "data-live-logo": "true",
    }),
    React.createElement(Admin),
  );
}
let root;
async function flush(action = () => {}) {
  await act(async () => {
    await action();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}
async function mount() {
  if (root) await flush(() => root.unmount());
  document.getElementById("root").innerHTML = "";
  root = createRoot(document.getElementById("root"));
  await flush(() => root.render(React.createElement(Harness)));
}
const button = (text, scope = document) =>
  Array.from(scope.querySelectorAll("button")).find(
    (node) =>
      node.textContent.trim() === text || node.textContent.includes(text),
  );
const form = (label) => document.querySelector(`form[aria-label="${label}"]`);
const section = (id) => document.getElementById(id).closest("section");
const liveLogo = () =>
  document.querySelector("[data-live-logo]").getAttribute("src");
async function inputValue(node, value) {
  await flush(() => {
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(node),
      "value",
    ).set.call(node, value);
    node.dispatchEvent(
      new Event(node.tagName === "SELECT" ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
async function submit(node) {
  await flush(() =>
    node.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
}
async function select(input, file) {
  await flush(() => {
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
(async () => {
  await mount();
  assert.match(document.body.textContent, /Только отмеченное сообщение/);
  assert.equal(
    document.querySelector(
      'img[src="/api/admin/qmessage/reports/1/attachment"]',
    ).alt,
    "Вложение сообщения из жалобы",
  );
  assert.equal(liveLogo(), defaultLogo);
  const settings = form("Настройки QMessage");
  await inputValue(
    settings.querySelector('input:not([type="checkbox"])'),
    "Наш QMessage",
  );
  await inputValue(
    settings.querySelector("textarea"),
    "Проверенное объявление",
  );
  await submit(settings);
  assert.equal(config.title, "Наш QMessage");
  assert.equal(config.announcement, "Проверенное объявление");
  const access = section("message-access-title");
  await flush(() => button("Ограничить", access).click());
  const ban = form("Подтверждение ограничения QMessage");
  await inputValue(ban.querySelector("textarea"), "Нарушение правил общения");
  failBan = true;
  await submit(ban);
  assert.match(access.textContent, /Ограничение не сохранено/);
  failBan = false;
  await submit(ban);
  assert.equal(users[0].banned, true);
  assert.equal(users[0].ban_reason, "Нарушение правил общения");
  await flush(() => button("Восстановить", access).click());
  await submit(form("Подтверждение ограничения QMessage"));
  assert.equal(users[0].banned, false);
  const userCount = userRequests;
  await inputValue(access.querySelector('input[type="search"]'), "участник");
  await submit(access.querySelector("form"));
  assert.equal(userRequests, userCount + 1);
  const reportsSection = section("message-reports-title");
  await flush(() => button("Удалить сообщение", reportsSection).click());
  assert.equal(
    apiCalls.some((call) => call.url.endsWith("/resolve")),
    false,
    "destructive moderation waits for explicit confirmation",
  );
  await flush(() => button("Подтвердить решение", reportsSection).click());
  const resolution = apiCalls.find((call) => call.url.endsWith("/resolve"));
  assert.deepEqual(JSON.parse(resolution.options.body), {
    delete_message: true,
  });
  assert.equal(reports[0].message.deleted, true);
  assert.equal(reports[0].status, "resolved");
  await inputValue(reportsSection.querySelector("select"), "resolved");
  assert.match(reportsSection.textContent, /Сообщение удалено/);
  const catalog = section("message-stickers-title");
  const builtinCard = catalog.querySelector("article");
  assert.equal(
    builtinCard.querySelector("img").getAttribute("src"),
    "/qmessage-stickers/wave.svg",
  );
  assert.equal(
    button("Убрать картинку", builtinCard),
    undefined,
    "default builtin SVG has no custom image to remove",
  );
  await select(
    builtinCard.querySelector('input[type="file"]'),
    new File(["testpng"], "wave-custom.png", { type: "image/png" }),
  );
  await flush(() => button("Загрузить картинку", builtinCard).click());
  assert.equal(
    builtinCard.querySelector("img").getAttribute("src"),
    "/api/qmessage/stickers/wave/image",
  );
  await flush(() => button("Убрать картинку", builtinCard).click());
  assert.match(builtinCard.textContent, /Восстановить стандартное изображение/);
  await flush(() => button("Да, убрать", builtinCard).click());
  assert.equal(
    builtinCard.querySelector("img").getAttribute("src"),
    "/qmessage-stickers/wave.svg",
  );
  assert.match(
    builtinCard.textContent,
    /Стандартное изображение восстановлено/,
  );
  await flush(() => button("Добавить стикер", catalog).click());
  const editor = form("Новый стикер");
  const fields = editor.querySelectorAll("input");
  await inputValue(fields[0], "qforce-test");
  await inputValue(fields[1], "Проверенный стикер");
  await inputValue(fields[2], "🔥");
  await inputValue(fields[3], "3");
  await submit(editor);
  assert.equal(
    stickers.some(
      (item) =>
        item.id === "qforce-test" && item.label === "Проверенный стикер",
    ),
    true,
  );
  let custom = Array.from(catalog.querySelectorAll("article")).find((node) =>
    node.textContent.includes("Проверенный стикер"),
  );
  await flush(() => button("Изменить", custom).click());
  const edit = form("Редактирование стикера");
  await inputValue(edit.querySelectorAll("input")[1], "Изменённый стикер");
  await submit(edit);
  assert.equal(
    stickers.find((item) => item.id === "qforce-test").label,
    "Изменённый стикер",
  );
  custom = Array.from(catalog.querySelectorAll("article")).find((node) =>
    node.textContent.includes("Изменённый стикер"),
  );
  const image = new File(["fake-png"], "sticker.png", { type: "image/png" });
  await select(custom.querySelector('input[type="file"]'), image);
  await flush(() => button("Загрузить картинку", custom).click());
  const stickerPut = apiCalls.find(
    (call) =>
      call.url === "/admin/qmessage/stickers/qforce-test/image" &&
      call.options.method === "PUT",
  );
  assert.equal(stickerPut.options.body.get("file").name, image.name);
  await flush(() => button("Убрать картинку", custom).click());
  await flush(() => button("Да, убрать", custom).click());
  assert.equal(
    stickers.find((item) => item.id === "qforce-test").image_url,
    null,
  );
  await flush(() => button("Скрыть", custom).click());
  await flush(() => button("Да, скрыть", custom).click());
  assert.equal(
    stickers.find((item) => item.id === "qforce-test").active,
    false,
  );

  const logoForm = form("Логотип QMessage");
  const png = new File(
    [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])],
    "message.png",
    { type: "image/png" },
  );
  await select(logoForm.querySelector('input[type="file"]'), png);
  failLogo = true;
  await submit(logoForm);
  assert.match(logoForm.textContent, /Логотип временно не сохранён/);
  failLogo = false;
  await submit(logoForm);
  assert.equal(liveLogo(), asset("a"));
  assert.equal(
    apiCalls
      .find(
        (call) =>
          call.url === "/branding/message-logo" &&
          call.options.method === "PUT",
      )
      .options.body.get("file").name,
    "message.png",
  );
  currentLogo = { logo_url: asset("b"), logo_custom: true };
  await flush(() => branding.notifyQMessageBranding(currentLogo));
  assert.equal(liveLogo(), asset("b"));
  currentLogo = { logo_url: asset("c"), logo_custom: true };
  await flush(() =>
    window.dispatchEvent(
      new dom.window.StorageEvent("storage", {
        key: "qmessage:branding-updated",
        newValue: "changed",
      }),
    ),
  );
  assert.equal(liveLogo(), asset("c"));
  let release;
  logoHold = new Promise((resolve) => (release = resolve));
  await flush(() => window.dispatchEvent(new Event("focus")));
  currentLogo = { logo_url: asset("d"), logo_custom: true };
  await flush(() => branding.notifyQMessageBranding(currentLogo));
  await flush(() => release());
  logoHold = null;
  assert.equal(liveLogo(), asset("d"));
  await flush(() => button("Стандартный логотип", logoForm).click());
  assert.equal(liveLogo(), defaultLogo);
  assert.equal(
    apiCalls.some((call) => call.url.startsWith("/qmessage/conversations")),
    false,
    "admin interface must never fetch private conversation history",
  );
  assert.equal(
    apiCalls.some((call) =>
      /\/branding\/(project|force|identity|control|tests)-logo/.test(call.url),
    ),
    false,
  );
  role = "student";
  apiCalls = [];
  await mount();
  assert.match(document.body.textContent, /доступно администратору/);
  assert.equal(
    apiCalls.some((call) => call.url.startsWith("/admin/")),
    false,
  );
  await flush(() => root.unmount());
  root = null;
  console.log(
    "PASS: actual QMessage QControl settings, user search/ban/unban/error+retry, explicit report deletion confirmation, report attachment scope, sticker create/edit/image/hide, independent logo PUT/reset/event/storage/stale-request guard and student/no-private-chat restrictions.",
  );
})().catch(async (cause) => {
  console.error(cause);
  if (root) await flush(() => root.unmount());
  process.exitCode = 1;
});
