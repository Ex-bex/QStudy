"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCheck,
  LoaderCircle,
  MessageCircle,
  Search,
  ShieldCheck,
  SquarePen,
  UsersRound,
  X,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { AuthProvider, useAuth } from "@/lib/auth";
import { QMessageLogo } from "@/components/qmessage-brand";
import {
  conversationId,
  messageInitials,
  messagePreview,
  messageTime,
  type ConversationList,
  type MessageConversation,
  type MessageEvents,
  type MessageUser,
} from "@/lib/qmessage";
import { useQMessage } from "./context";
import MessageThread from "./thread";
import styles from "./qmessage.module.css";

export default function QMessageWorkspace() {
  const params = useSearchParams();
  const selected = conversationId(params.get("chat"));
  const path = selected
    ? `/qmessage/chats?chat=${selected}`
    : "/qmessage/chats";
  return (
    <AuthProvider
      loginPath={`/login?next=${encodeURIComponent(path)}`}
      loadingMark={<QMessageLogo width={58} height={58} />}
    >
      <AuthedWorkspace />
    </AuthProvider>
  );
}

function AuthedWorkspace() {
  const { user } = useAuth();
  return <Messenger key={user.id} />;
}

function Messenger() {
  const { user } = useAuth();
  const { config, refresh: refreshConfig } = useQMessage();
  const params = useSearchParams();
  const router = useRouter();
  const selectedId = conversationId(params.get("chat"));
  const [conversations, setConversations] = useState<MessageConversation[]>([]);
  const [account, setAccount] = useState<ConversationList["account"]>({
    banned: false,
    ban_reason: "",
  });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [peopleMode, setPeopleMode] = useState(false);
  const [people, setPeople] = useState<MessageUser[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [peopleError, setPeopleError] = useState("");
  const [creating, setCreating] = useState<number | null>(null);
  const [connection, setConnection] = useState("connecting");
  const [messageRevision, setMessageRevision] = useState(0);
  const [restoreEpoch, setRestoreEpoch] = useState(0);
  const initialCursor = useRef<number | null>(null);
  const refreshThread = useRef<(() => Promise<void>) | null>(null);
  const registerRefresh = useCallback(
    (callback: (() => Promise<void>) | null) => {
      refreshThread.current = callback;
    },
    [],
  );
  const searchInput = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await api<ConversationList>("/qmessage/conversations", {
        signal,
      });
      if (signal?.aborted) return false;
      setConversations(data.items);
      setAccount(data.account);
      setError("");
      if (initialCursor.current === null) initialCursor.current = data.cursor;
      setReady(true);
      setConnection("online");
      return true;
    } catch (cause) {
      if (!signal?.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось загрузить диалоги",
        );
      return false;
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    let generation = 0;
    let cursor = initialCursor.current || 0;
    let failures = 0;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    const poll = async (current: number) => {
      if (
        !active ||
        current !== generation ||
        document.visibilityState === "hidden"
      )
        return;
      controller = new AbortController();
      try {
        const data = await api<MessageEvents>(
          `/qmessage/events?after=${cursor}&wait=20`,
          { signal: controller.signal },
        );
        if (!active || current !== generation) return;
        const restored = Boolean(data.reset || data.cursor < cursor);
        if (data.items.length || restored) {
          const refreshed = await refresh();
          if (!refreshed) throw new Error("Не удалось обновить диалоги");
          if (refreshThread.current) await refreshThread.current();
          if (
            restored ||
            data.items.some((item) => item.type === "account.updated")
          )
            await refreshConfig();
        }
        if (!active || current !== generation) return;
        cursor = data.cursor;
        if (restored) setRestoreEpoch((value) => value + 1);
        failures = 0;
        setConnection("online");
        timer = window.setTimeout(
          () => void poll(current),
          data.has_more ? 20 : 120,
        );
      } catch (cause) {
        if (!active || current !== generation || controller?.signal.aborted)
          return;
        if (cause instanceof ApiError && cause.status === 503)
          void refreshConfig();
        setConnection("reconnecting");
        failures++;
        timer = window.setTimeout(
          () => void poll(current),
          Math.min(30000, 1000 * 2 ** Math.min(failures, 5)),
        );
      }
    };
    const resume = () => {
      generation++;
      window.clearTimeout(timer);
      controller?.abort();
      if (document.visibilityState === "hidden") setConnection("paused");
      else {
        setConnection("connecting");
        void refresh();
        setMessageRevision((value) => value + 1);
        void poll(generation);
      }
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    void poll(generation);
    return () => {
      active = false;
      generation++;
      controller?.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
    };
  }, [ready, refresh, refreshConfig]);
  useEffect(() => {
    if (!peopleMode || search.trim().length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPeopleLoading(true);
      setPeopleError("");
      try {
        const data = await api<{ items: MessageUser[] }>(
          `/qmessage/users?q=${encodeURIComponent(search.trim())}`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) setPeople(data.items);
      } catch (cause) {
        if (!controller.signal.aborted)
          setPeopleError(
            cause instanceof Error
              ? cause.message
              : "Поиск временно недоступен",
          );
      } finally {
        if (!controller.signal.aborted) setPeopleLoading(false);
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [search, peopleMode]);
  const changed = useCallback(() => {
    void refresh();
  }, [refresh]);
  const openConversation = (id: number) =>
    router.replace(`/qmessage/chats?chat=${id}`, { scroll: false });
  async function startConversation(person: MessageUser) {
    if (creating) return;
    setCreating(person.id);
    setError("");
    try {
      const conversation = await api<MessageConversation>(
        "/qmessage/conversations",
        { method: "POST", body: JSON.stringify({ user_id: person.id }) },
      );
      setConversations((current) => [
        conversation,
        ...current.filter((item) => item.id !== conversation.id),
      ]);
      setPeopleMode(false);
      setSearch("");
      openConversation(conversation.id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось начать разговор",
      );
    } finally {
      setCreating(null);
    }
  }
  const selected = conversations.find((item) => item.id === selectedId);
  const visibleConversations = conversations.filter((item) =>
    item.peer.name
      .toLocaleLowerCase("ru-RU")
      .includes(search.toLocaleLowerCase("ru-RU").trim()),
  );
  return (
    <div
      className={`${styles.workspace} ${selectedId ? styles.withConversation : ""}`}
    >
      <aside className={styles.sidebar} aria-label="Диалоги и поиск людей">
        <div className={styles.sidebarTop}>
          <Link href="/qmessage" className={styles.brand}>
            <QMessageLogo alt="" width={37} height={37} />
            <span>
              {config?.title || "QMessage"}
              <small>ваши разговоры</small>
            </span>
          </Link>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Начать новый разговор"
            onClick={() => {
              setPeopleMode(true);
              setSearch("");
              searchInput.current?.focus();
            }}
          >
            <SquarePen size={21} />
          </button>
        </div>
        <div className={styles.searchBox}>
          <Search size={18} />
          <label className={styles.srOnly} htmlFor="qmessage-people-search">
            {peopleMode ? "Найти человека по имени" : "Найти диалог"}
          </label>
          <input
            ref={searchInput}
            id="qmessage-people-search"
            value={search}
            placeholder={
              peopleMode ? "Имя, минимум 2 символа…" : "Поиск в диалогах…"
            }
            onChange={(event) => {
              setSearch(event.target.value);
              setPeople([]);
              setPeopleError("");
              setPeopleLoading(false);
            }}
          />
          {search && (
            <button
              type="button"
              aria-label="Очистить поиск"
              onClick={() => setSearch("")}
            >
              <X size={15} />
            </button>
          )}
        </div>
        <div className={styles.listTabs}>
          <button
            type="button"
            className={!peopleMode ? styles.activeTab : ""}
            onClick={() => {
              setPeopleMode(false);
              setSearch("");
            }}
          >
            Диалоги <span>{conversations.length}</span>
          </button>
          <button
            type="button"
            className={peopleMode ? styles.activeTab : ""}
            onClick={() => {
              setPeopleMode(true);
              setSearch("");
              searchInput.current?.focus();
            }}
          >
            Найти людей
          </button>
        </div>
        <div className={styles.conversationList}>
          {error && (
            <div className={styles.sidebarError} role="alert">
              {error}
              <button type="button" onClick={() => void refresh()}>
                Повторить
              </button>
            </div>
          )}
          {!ready && !error && (
            <div className={styles.emptyList} role="status">
              <LoaderCircle className={styles.spin} size={24} />
              <p>Открываем ваши диалоги…</p>
            </div>
          )}
          {peopleMode ? (
            <>
              {search.trim().length < 2 ? (
                <div className={styles.emptyList}>
                  <UsersRound size={31} />
                  <h2>С кем поговорим?</h2>
                  <p>
                    Введите хотя бы 2 буквы имени. Под именем показываются
                    группа и номер профиля — так проще найти нужного человека.
                  </p>
                </div>
              ) : peopleLoading ? (
                <div className={styles.emptyList} role="status">
                  <LoaderCircle className={styles.spin} size={23} /> Ищем людей…
                </div>
              ) : peopleError ? (
                <p className={styles.sidebarError} role="alert">
                  {peopleError}
                </p>
              ) : people.length ? (
                people.map((person) => (
                  <button
                    key={person.id}
                    type="button"
                    className={styles.conversationItem}
                    disabled={
                      creating !== null ||
                      account.banned ||
                      config?.enabled === false
                    }
                    onClick={() => void startConversation(person)}
                  >
                    <span className={styles.avatar}>
                      {messageInitials(person.name)}
                    </span>
                    <span className={styles.conversationCopy}>
                      <strong>{person.name}</strong>
                      <small>
                        {person.group_name || "Без группы"} · ID {person.id}
                      </small>
                    </span>
                    {creating === person.id ? (
                      <LoaderCircle className={styles.spin} size={17} />
                    ) : (
                      <ArrowUpRight size={18} />
                    )}
                  </button>
                ))
              ) : (
                <div className={styles.emptyList}>
                  <Search size={26} />
                  <p>
                    По этому имени никого не нашли. Попробуйте другое написание.
                  </p>
                </div>
              )}
            </>
          ) : (
            <>
              {visibleConversations.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  className={`${styles.conversationItem} ${conversation.id === selectedId ? styles.selectedConversation : ""}`}
                  onClick={() => openConversation(conversation.id)}
                  aria-current={
                    conversation.id === selectedId ? "page" : undefined
                  }
                >
                  <span className={styles.avatar}>
                    {messageInitials(conversation.peer.name)}
                  </span>
                  <span className={styles.conversationCopy}>
                    <span>
                      <strong>{conversation.peer.name}</strong>
                      <time>
                        {conversation.last_message
                          ? messageTime(conversation.last_message.created_at)
                          : ""}
                      </time>
                    </span>
                    <span>
                      <small>
                        {conversation.typing
                          ? "печатает…"
                          : messagePreview(conversation.last_message)}
                      </small>
                      {conversation.unread_count > 0 && (
                        <b className={styles.unread}>
                          {conversation.unread_count > 99
                            ? "99+"
                            : conversation.unread_count}
                        </b>
                      )}
                    </span>
                  </span>
                </button>
              ))}
              {ready && !visibleConversations.length && (
                <div className={styles.emptyList}>
                  <MessageCircle size={31} />
                  <h2>
                    {search
                      ? "Такого диалога пока нет"
                      : "Здесь начнётся разговор"}
                  </h2>
                  <p>
                    {search
                      ? "Попробуйте другое имя или найдите человека в поиске людей."
                      : "Найдите человека по имени, чтобы написать первое сообщение."}
                  </p>
                  <button
                    type="button"
                    className={styles.smallPrimary}
                    onClick={() => {
                      setPeopleMode(true);
                      setSearch("");
                      searchInput.current?.focus();
                    }}
                  >
                    Найти человека <ArrowRightSmall />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        <div className={styles.sidebarBottom}>
          <span className={styles.selfAvatar}>
            {messageInitials(user.name)}
          </span>
          <span>
            <strong>{user.name}</strong>
            <small>
              <i
                className={`${styles.connectionDot} ${connection === "online" ? styles.connected : ""}`}
              />
              {connection === "online"
                ? "На связи"
                : connection === "paused"
                  ? "Обновим при возвращении"
                  : connection === "reconnecting"
                    ? "Восстанавливаем связь…"
                    : "Подключаемся…"}
            </small>
          </span>
          {user.role === "admin" && (
            <Link
              href="/qcontrol/qmessage"
              className={styles.iconButton}
              aria-label="Управление QMessage"
            >
              <ShieldCheck size={18} />
            </Link>
          )}
          <Link
            href="/"
            className={styles.iconButton}
            aria-label="На главную QForce"
          >
            <ArrowUpRight size={18} />
          </Link>
        </div>
      </aside>
      <main className={styles.chatMain} aria-label="Переписка">
        {account.banned && (
          <p className={styles.serviceNotice} role="alert">
            Отправка сообщений ограничена администратором.
            {account.ban_reason && ` Причина: ${account.ban_reason}`}
          </p>
        )}
        {config?.enabled === false && (
          <p className={styles.serviceNotice} role="status">
            QMessage временно закрыт. Сохранённые переписки не удалены.
          </p>
        )}
        {config?.announcement && (
          <p className={styles.announcement}>{config.announcement}</p>
        )}
        {selected ? (
          <MessageThread
            key={`${selected.id}:${restoreEpoch}`}
            conversation={selected}
            revision={messageRevision}
            registerRefresh={registerRefresh}
            disabled={account.banned || config?.enabled === false}
            onChanged={changed}
            onBack={() => router.replace("/qmessage/chats", { scroll: false })}
          />
        ) : (
          <div className={styles.welcome}>
            <QMessageLogo alt="" width={80} height={80} />
            <span className={styles.eyebrow}>
              Q-ID ОБЪЕДИНЯЕТ. QMESSAGE СБЛИЖАЕТ.
            </span>
            <h1>
              {selectedId && ready
                ? "Диалог недоступен"
                : "Кому сегодня скажем «привет»?"}
            </h1>
            <p>
              {selectedId && ready
                ? "Переписка не найдена или у вашего аккаунта нет к ней доступа."
                : "Выберите разговор слева или найдите человека по имени. Сообщения и история останутся с вами после перезапуска."}
            </p>
            {selectedId && (
              <button
                type="button"
                className={styles.smallPrimary}
                onClick={() => router.replace("/qmessage/chats")}
              >
                <ArrowLeft size={16} /> К диалогам
              </button>
            )}
            <span className={styles.welcomeNote}>
              <CheckCheck size={16} /> Один аккаунт. Твои разговоры.
            </span>
          </div>
        )}
      </main>
    </div>
  );
}

function ArrowRightSmall() {
  return <ArrowUpRight size={15} />;
}
