/**
 * React DOM regression tests for the student QMessage workspace and thread.
 * No real accounts or backend are used. API/auth/Next image boundaries are mocked;
 * actual workspace/thread, storage helpers, React state, DOM events, send retries,
 * user search, moderation actions and event cursor recovery are exercised.
 * This is not browser visual testing.
 *
 * Run from the repository root with an isolated DOM test dependency:
 * npm install --prefix .local/qtests-ui-qa --no-save --package-lock=false --ignore-scripts jsdom@26.1.0
 * node scripts/tests/qmessage_dom.mjs --run --jsdom .local/qtests-ui-qa/node_modules/jsdom
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
global.sessionStorage = dom.window.sessionStorage;
global.localStorage = dom.window.localStorage;
const timers = new Map();
let timerId = 0;
window.setTimeout = (callback, delay) => {
  const id = ++timerId;
  timers.set(id, { callback, delay });
  return id;
};
window.clearTimeout = (id) => timers.delete(id);
window.requestAnimationFrame = (callback) => {
  callback(0);
  return 0;
};
window.cancelAnimationFrame = () => {};
dom.window.HTMLElement.prototype.scrollTo = function ({ top }) {
  this.scrollTop = top;
};
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: async () => {} },
});
let account = { id: 1, name: "Алина Тестовая", role: "student" };
const peer = {
  id: 8,
  name: "Жанболат Ахмет",
  group_name: "ИП-26-3кс",
  avatar_url: null,
  online: false,
};
const secondPeer = { ...peer, id: 9, name: "Анна Вторая" };
const wave = {
  id: "wave",
  label: "Привет",
  emoji: "👋",
  image_url: "/qmessage-stickers/wave.svg",
  active: true,
  position: 0,
  builtin: true,
};
const created = new Set();
const messages = new Map([
  [1, []],
  [2, []],
]);
const blocked = new Set();
const reads = new Map();
let nextMessageId = 1;
let apiCalls = [];
let sendFailsAfterCommit = false;
let sendHold = null;
let failConversations = 0;
let failMessages = 0;
let events = [];
const routerListeners = new Set();
let query = "";
const navigate = (url) => {
  query = new URL(url, "http://localhost").search;
  for (const notify of routerListeners) notify();
};
const clone = (value) => JSON.parse(JSON.stringify(value));
function makeMessage(conversation, fields = {}) {
  return {
    id: nextMessageId++,
    conversation_id: conversation,
    author_id: account.id,
    text: "",
    sticker_id: null,
    sticker: null,
    attachment: null,
    reply_to_id: null,
    reply_to: null,
    client_id: crypto.randomUUID(),
    created_at: "2026-10-19T10:00:00Z",
    edited_at: null,
    deleted: false,
    reactions: [],
    ...fields,
  };
}
function conversation(id) {
  const list = messages.get(id);
  return {
    id,
    peer:
      account.id === 8
        ? { ...peer, id: 1, name: "Алина Тестовая" }
        : id === 1
          ? peer
          : secondPeer,
    last_message: list.at(-1) || null,
    unread_count: 0,
    read_message_id: reads.get(id) || 0,
    peer_read_message_id: 0,
    blocked_by_me: blocked.has(id),
    blocked_by_peer: false,
    updated_at: "2026-10-19T10:00:00Z",
    typing: false,
  };
}
function currentMessages(id) {
  return messages.get(id).map((row) => {
    const reply = row.reply_to_id
      ? messages.get(id).find((item) => item.id === row.reply_to_id)
      : null;
    return {
      ...row,
      reply_to: reply
        ? {
            id: reply.id,
            author_id: reply.author_id,
            text: reply.deleted ? "" : reply.text,
            sticker_id: reply.deleted ? null : reply.sticker_id,
            deleted: reply.deleted,
          }
        : null,
    };
  });
}
const api = async (url, options = {}) => {
  apiCalls.push({ url, options });
  if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (url.startsWith("/qmessage/events?")) {
    return await new Promise((resolve, reject) => {
      const entry = {
        after: Number(
          new URL("http://localhost" + url).searchParams.get("after"),
        ),
        resolve,
        reject,
        settled: false,
      };
      events.push(entry);
      options.signal?.addEventListener(
        "abort",
        () => {
          entry.settled = true;
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }
  if (url === "/qmessage/conversations") {
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      const id = body.user_id === secondPeer.id ? 2 : 1;
      created.add(id);
      return clone(conversation(id));
    }
    if (failConversations) {
      failConversations--;
      throw new Error("Диалоги временно недоступны");
    }
    return clone({
      items: Array.from(created).map(conversation),
      cursor: 10,
      account: { banned: false, ban_reason: "" },
    });
  }
  if (url.startsWith("/qmessage/users?")) {
    const q = new URL("http://localhost" + url).searchParams
      .get("q")
      .toLocaleLowerCase("ru-RU");
    return {
      items: clone(
        [peer, secondPeer].filter((user) =>
          user.name.toLocaleLowerCase("ru-RU").includes(q),
        ),
      ),
    };
  }
  if (url === "/qmessage/stickers") return { items: [clone(wave)] };
  let match =
    /^\/qmessage\/conversations\/(\d+)\/(messages|read|typing|attachments)(?:\?(.*))?$/.exec(
      url,
    );
  if (match) {
    const id = Number(match[1]);
    if (match[2] === "typing") return { ok: true };
    if (match[2] === "read") {
      const value = JSON.parse(options.body).message_id;
      reads.set(id, Math.max(reads.get(id) || 0, value));
      return { ok: true, read_message_id: reads.get(id) };
    }
    if (match[2] === "attachments")
      return {
        id: 50,
        url: "/api/qmessage/attachments/50",
        filename: "photo.png",
        content_type: "image/png",
        size_bytes: 4,
        width: 64,
        height: 64,
      };
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.match(
        body.client_id,
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      );
      if (sendHold) await sendHold;
      let saved = messages
        .get(id)
        .find((item) => item.client_id === body.client_id);
      if (!saved) {
        saved = makeMessage(id, {
          ...body,
          sticker: body.sticker_id === wave.id ? wave : null,
        });
        messages.get(id).push(saved);
      }
      if (sendFailsAfterCommit) {
        sendFailsAfterCommit = false;
        throw new Error("Ответ сервера потерян. Повторите отправку.");
      }
      return clone(saved);
    }
    if (failMessages) {
      failMessages--;
      throw new Error("История временно недоступна");
    }
    const parsed = new URLSearchParams(match[3]);
    const search = parsed.get("q")?.toLocaleLowerCase("ru-RU");
    const list = currentMessages(id).filter(
      (item) =>
        !search || item.text.toLocaleLowerCase("ru-RU").includes(search),
    );
    return clone({
      items: list,
      has_more: false,
      typing: false,
      peer_read_message_id: 0,
      read_message_id: reads.get(id) || 0,
    });
  }
  match = /^\/qmessage\/messages\/(\d+)(?:\/(reaction|report))?$/.exec(url);
  if (match) {
    const id = Number(match[1]);
    const row = [...messages.values()].flat().find((item) => item.id === id);
    assert.ok(row);
    if (match[2] === "report") return { id: 1, status: "open" };
    if (match[2] === "reaction") {
      const emoji = JSON.parse(options.body).emoji;
      row.reactions = emoji
        ? [{ emoji, count: 1, user_ids: [account.id] }]
        : [];
      return clone(row);
    }
    if (options.method === "PATCH") {
      row.text = JSON.parse(options.body).text;
      row.edited_at = "2026-10-19T10:00:30Z";
      return clone(row);
    }
    assert.equal(options.method, "DELETE");
    row.deleted = true;
    row.text = "";
    row.sticker = null;
    row.attachment = null;
    return { ok: true };
  }
  if (url === `/qmessage/users/${peer.id}/block`) {
    const value = JSON.parse(options.body).blocked;
    if (value) blocked.add(1);
    else blocked.delete(1);
    return { ok: true, blocked: value };
  }
  throw new Error("Unexpected API: " + url);
};
const messageContext = {
  config: { enabled: true, title: "QMessage", announcement: "" },
  refresh: async () => {},
};
class MockApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
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
    if (request === "@/lib/api")
      return {
        api,
        ApiError: MockApiError,
        formatBytes: (size) => `${size} Б`,
      };
    if (request === "@/lib/auth")
      return {
        useAuth: () => ({ user: account }),
        AuthProvider: ({ children }) => children,
      };
    if (request === "next/navigation")
      return {
        useRouter: () => ({ replace: navigate }),
        useSearchParams: () =>
          new URLSearchParams(
            React.useSyncExternalStore(
              (callback) => {
                routerListeners.add(callback);
                return () => routerListeners.delete(callback);
              },
              () => query,
              () => query,
            ),
          ),
      };
    if (request === "next/image")
      return { __esModule: true, default: ImageMock };
    if (request === "next/link")
      return {
        __esModule: true,
        default: ({ children, ...props }) =>
          React.createElement("a", props, children),
      };
    if (request === "@/components/qmessage-brand")
      return {
        QMessageLogo: (props) =>
          React.createElement(ImageMock, {
            ...props,
            src: "/brand/qmessage-prototype.svg",
          }),
      };
    if (request === "./context") return { useQMessage: () => messageContext };
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
const Workspace = load("components/qmessage/workspace.tsx").default;
let root;
async function flush(action = () => {}) {
  await act(async () => {
    await action();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}
async function tick(delay) {
  const entries = [...timers].filter(([, timer]) => timer.delay === delay);
  assert.ok(entries.length, `No timer with delay ${delay}`);
  await flush(() => {
    for (const [id, timer] of entries) {
      timers.delete(id);
      timer.callback();
    }
  });
}
async function inputValue(node, value) {
  assert.ok(node, "expected input");
  await flush(() => {
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(node),
      "value",
    ).set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const byLabel = (label, scope = document) =>
  scope.querySelector(`button[aria-label="${label}"]`);
const byText = (text, scope = document) =>
  Array.from(scope.querySelectorAll("button")).find(
    (node) =>
      node.textContent.trim() === text || node.textContent.includes(text),
  );
const composer = () => document.getElementById("qmessage-text");
const rowFor = (text) =>
  Array.from(document.querySelectorAll(".messageRow")).find((row) =>
    Array.from(row.querySelectorAll(".messageText")).some(
      (node) => node.textContent === text,
    ),
  );
const pendingEvent = () =>
  [...events].reverse().find((event) => !event.settled);
async function resolveEvent(data) {
  const event = pendingEvent();
  assert.ok(event, "pending long poll");
  event.settled = true;
  await flush(() => event.resolve(data));
}
async function send(text) {
  await inputValue(composer(), text);
  await flush(() => byLabel("Отправить сообщение").click());
}
async function openPerson(name) {
  await flush(() => byLabel("Начать новый разговор").click());
  await inputValue(document.getElementById("qmessage-people-search"), name);
  await tick(300);
  await flush(() => byText(name).click());
}
(async () => {
  root = createRoot(document.getElementById("root"));

  await flush(() => root.render(React.createElement(Workspace)));

  assert.equal(pendingEvent().after, 10);
  await flush(() => byLabel("Начать новый разговор").click());
  await inputValue(document.getElementById("qmessage-people-search"), "Жан");
  assert.equal(
    apiCalls.some((call) => call.url.startsWith("/qmessage/users?")),
    false,
    "search is debounced",
  );

  await tick(300);

  assert.equal(
    apiCalls.filter((call) => call.url.startsWith("/qmessage/users?")).length,
    1,
  );
  assert.equal(
    new URL(
      "http://localhost" +
        apiCalls.find((call) => call.url.startsWith("/qmessage/users?")).url,
    ).searchParams.get("q"),
    "Жан",
  );
  await flush(() => byText(peer.name).click());
  assert.equal(query, "?chat=1");
  assert.ok(composer());
  let releaseSend;
  sendHold = new Promise((resolve) => (releaseSend = resolve));
  sendFailsAfterCommit = true;

  await send("Первое сообщение");
  assert.match(document.body.textContent, /Отправляем/);
  await flush(() => releaseSend());
  sendHold = null;

  assert.match(document.body.textContent, /Ответ сервера потерян/);
  const firstPost = apiCalls.find(
    (call) =>
      call.url === "/qmessage/conversations/1/messages" &&
      call.options.method === "POST",
  );
  await flush(() => byText("Повторить").click());
  const sentPosts = apiCalls.filter(
    (call) =>
      call.url === "/qmessage/conversations/1/messages" &&
      call.options.method === "POST",
  );
  assert.equal(sentPosts.length, 2);
  assert.equal(
    JSON.parse(sentPosts[0].options.body).client_id,
    JSON.parse(sentPosts[1].options.body).client_id,
  );
  assert.equal(messages.get(1).length, 1);
  assert.equal(
    document.querySelectorAll('article[aria-label="Ваше сообщение"]').length,
    1,
  );
  assert.equal(sessionStorage.getItem("qmessage_draft_1_1_outbox"), null);
  await flush(() => byLabel("Эмодзи и стикеры").click());
  await flush(() => byLabel("Вставить 😀").click());
  assert.equal(composer().value, "😀");
  await flush(() => byLabel("Отправить сообщение").click());
  assert.equal(messages.get(1).at(-1).text, "😀");
  await flush(() => byLabel("Эмодзи и стикеры").click());
  await flush(() =>
    byText("Стикеры", document.querySelector(".picker")).click(),
  );
  assert.equal(
    document.querySelector('img[src="/qmessage-stickers/wave.svg"]') !== null,
    true,
  );
  await flush(() => byLabel("Отправить стикер: Привет").click());
  assert.equal(messages.get(1).at(-1).sticker_id, "wave");
  const incoming = makeMessage(1, {
    author_id: peer.id,
    text: "Привет от друга",
  });
  messages.get(1).push(incoming);
  await resolveEvent({
    items: [
      {
        id: 11,
        type: "message.created",
        conversation_id: 1,
        message_id: incoming.id,
      },
    ],
    cursor: 11,
    has_more: false,
  });
  assert.ok(rowFor(incoming.text));
  await tick(120);
  assert.equal(pendingEvent().after, 11);
  await flush(() =>
    byLabel("Действия с сообщением", rowFor(incoming.text)).click(),
  );
  await flush(() => byText("Ответить", rowFor(incoming.text)).click());
  await send("Ответ другу");
  assert.equal(messages.get(1).at(-1).reply_to_id, incoming.id);
  await flush(() =>
    byLabel("Действия с сообщением", rowFor(incoming.text)).click(),
  );
  await flush(() => byLabel("Реакция 👍", rowFor(incoming.text)).click());
  assert.equal(
    messages.get(1).find((item) => item.id === incoming.id).reactions[0].emoji,
    "👍",
  );
  await inputValue(composer(), "Неотправленный черновик");
  await flush(() =>
    byLabel("Действия с сообщением", rowFor("Первое сообщение")).click(),
  );
  await flush(() => byText("Изменить", rowFor("Первое сообщение")).click());
  await inputValue(composer(), "Исправленное сообщение");
  await flush(() => byLabel("Сохранить изменение").click());
  assert.equal(messages.get(1)[0].text, "Исправленное сообщение");
  assert.equal(composer().value, "Неотправленный черновик");
  await flush(() =>
    byLabel("Действия с сообщением", rowFor("Исправленное сообщение")).click(),
  );
  await flush(() =>
    byText("Удалить у обоих", rowFor("Исправленное сообщение")).click(),
  );
  assert.equal(
    apiCalls.some(
      (call) =>
        call.url === `/qmessage/messages/${messages.get(1)[0].id}` &&
        call.options.method === "DELETE",
    ),
    false,
  );
  await flush(() =>
    byText("Да, удалить у обоих", rowFor("Исправленное сообщение")).click(),
  );
  assert.equal(messages.get(1)[0].deleted, true);
  await flush(() =>
    byLabel("Действия с сообщением", rowFor(incoming.text)).click(),
  );
  await flush(() => byText("Пожаловаться", rowFor(incoming.text)).click());
  assert.equal(
    document.querySelector('[role="dialog"]').getAttribute("aria-modal"),
    "true",
  );
  await inputValue(
    document.getElementById("qmessage-report-reason"),
    "Проверка жалобы",
  );
  await flush(() =>
    byText(
      "Отправить жалобу",
      document.querySelector('[role="dialog"]'),
    ).click(),
  );
  assert.equal(
    JSON.parse(
      apiCalls.find(
        (call) => call.url === `/qmessage/messages/${incoming.id}/report`,
      ).options.body,
    ).reason,
    "Проверка жалобы",
  );
  await flush(() => byLabel("Настройки диалога").click());
  await flush(() => byText("Заблокировать").click());
  assert.equal(composer(), null);
  await flush(() => byText("Разблокировать").click());
  assert.ok(composer());
  const malicious = makeMessage(1, {
    author_id: peer.id,
    text: "Плохие URL",
    attachment: {
      id: 70,
      url: "https://evil.example/photo.png",
      filename: "evil.png",
      width: 64,
      height: 64,
    },
    sticker: {
      ...wave,
      builtin: false,
      image_url: "https://evil.example/sticker.png",
    },
  });
  messages.get(1).push(malicious);
  failConversations = 1;
  await resolveEvent({
    items: [
      {
        id: 12,
        type: "message.created",
        conversation_id: 1,
        message_id: malicious.id,
      },
    ],
    cursor: 12,
    has_more: false,
  });
  assert.match(document.body.textContent, /Восстанавливаем связь/);
  await tick(2000);
  assert.equal(
    pendingEvent().after,
    11,
    "cursor does not advance if list refresh failed",
  );
  await resolveEvent({
    items: [
      {
        id: 12,
        type: "message.created",
        conversation_id: 1,
        message_id: malicious.id,
      },
    ],
    cursor: 12,
    has_more: false,
  });
  assert.ok(rowFor("Плохие URL"));
  assert.equal(
    document.querySelector('img[src^="https://evil.example"]'),
    null,
  );
  await tick(120);
  assert.equal(pendingEvent().after, 12);
  const afterHistoryFailure = makeMessage(1, {
    author_id: peer.id,
    text: "История восстановилась после ошибки",
  });
  messages.get(1).push(afterHistoryFailure);
  failMessages = 1;
  await resolveEvent({
    items: [
      {
        id: 13,
        type: "message.created",
        conversation_id: 1,
        message_id: afterHistoryFailure.id,
      },
    ],
    cursor: 13,
    has_more: false,
  });
  await tick(2000);
  assert.equal(
    pendingEvent().after,
    12,
    "cursor does not advance if selected thread refresh failed",
  );
  await resolveEvent({
    items: [
      {
        id: 13,
        type: "message.created",
        conversation_id: 1,
        message_id: afterHistoryFailure.id,
      },
    ],
    cursor: 13,
    has_more: false,
  });
  assert.ok(rowFor(afterHistoryFailure.text));
  await tick(120);
  assert.equal(pendingEvent().after, 13);
  await inputValue(composer(), "Черновик первого аккаунта");
  await openPerson(secondPeer.name);
  assert.equal(composer().value, "");
  assert.equal(
    sessionStorage.getItem("qmessage_draft_1_1"),
    "Черновик первого аккаунта",
  );
  await flush(() =>
    byText(peer.name, document.querySelector(".conversationList")).click(),
  );
  assert.equal(composer().value, "Черновик первого аккаунта");
  const restored = makeMessage(1, {
    id: 1,
    author_id: peer.id,
    text: "Сообщение после восстановления",
  });
  messages.set(1, [restored]);
  reads.set(1, 0);
  const requestsBeforeRestore = apiCalls.filter((call) =>
    call.url.includes("/messages?"),
  ).length;
  await resolveEvent({ items: [], cursor: 3, has_more: false });
  assert.ok(
    apiCalls.filter((call) => call.url.includes("/messages?")).length >
      requestsBeforeRestore,
    "lower restored cursor triggers full history resync even without events",
  );
  assert.ok(rowFor(restored.text));
  assert.equal(
    reads.get(1),
    1,
    "restoring the database resets the thread read pointer for lower message IDs",
  );
  await tick(120);
  assert.equal(
    pendingEvent().after,
    3,
    "event cursor follows restored database cursor instead of staying ahead forever",
  );
  sessionStorage.setItem(
    "qmessage_draft_1_1_outbox",
    JSON.stringify([
      {
        client_id: crypto.randomUUID(),
        text: "Секретный исходящий другого аккаунта",
        status: "failed",
        sticker_id: null,
        attachment_id: null,
        reply_to_id: null,
      },
    ]),
  );
  account = { id: 8, name: peer.name, role: "student" };
  await flush(() => root.render(React.createElement(Workspace)));
  assert.equal(
    composer().value,
    "",
    "other Q-ID account must never inherit the previous account draft",
  );
  assert.equal(
    sessionStorage.getItem("qmessage_draft_1_1"),
    "Черновик первого аккаунта",
  );
  assert.equal(
    apiCalls.some((call) => call.url.startsWith("/admin/")),
    false,
  );
  assert.ok(JSON.parse(firstPost.options.body).client_id);
  await flush(() => root.unmount());
  root = null;
  console.log(
    "PASS: actual student workspace search/debounce/Cyrillic/start, pending send/idempotent UUID retry, emoji/sticker, reply/reaction/edit/delete/report/block, invalid image URL rejection, chat/account draft isolation, failed-refresh cursor replay and lower-restore cursor/history resync.",
  );
})().catch(async (cause) => {
  console.error(cause);
  if (root) await flush(() => root.unmount());
  process.exitCode = 1;
});
