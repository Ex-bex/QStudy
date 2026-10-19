"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  ArrowDown,
  ArrowLeft,
  CheckCheck,
  ChevronDown,
  Copy,
  CornerUpLeft,
  Flag,
  ImagePlus,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  Send,
  ShieldBan,
  Smile,
  Sticker,
  Trash2,
  X,
} from "lucide-react";
import { api, ApiError, formatBytes } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  attachmentUrl,
  draftKey,
  mergeMessages,
  messageClientId,
  messageDay,
  messageInitials,
  messageTime,
  readDraft,
  readDraftAttachment,
  readOutbox,
  stickerUrl,
  writeDraft,
  writeDraftAttachment,
  MESSAGE_EMOJI,
  MESSAGE_REACTIONS,
  type DirectMessage,
  type MessageAttachment,
  type MessageConversation,
  type MessagePage,
  type MessageSticker,
  type PendingMessage,
} from "@/lib/qmessage";
import styles from "./qmessage.module.css";

function StickerPicture({
  sticker,
  className = "",
}: {
  sticker: MessageSticker | null | undefined;
  className?: string;
}) {
  const source = stickerUrl(sticker);
  return (
    <span
      className={`${styles.stickerPicture} ${className}`}
      role="img"
      aria-label={sticker?.label || "Стикер"}
    >
      {source ? (
        <Image src={source} alt="" width={128} height={128} unoptimized />
      ) : (
        <span>{sticker?.emoji || "✨"}</span>
      )}
    </span>
  );
}

export default function MessageThread({
  conversation,
  revision,
  disabled,
  onChanged,
  onBack,
  registerRefresh,
}: {
  conversation: MessageConversation;
  revision: number;
  disabled: boolean;
  onChanged: () => void;
  onBack: () => void;
  registerRefresh: (callback: (() => Promise<void>) | null) => void;
}) {
  const { user } = useAuth();
  const key = draftKey(user.id, conversation.id);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [olderLoading, setOlderLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [text, setText] = useState(() => readDraft(key));
  const [pending, setPending] = useState<PendingMessage[]>(() =>
    readOutbox(key),
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reply, setReply] = useState<DirectMessage | null>(null);
  const [editing, setEditing] = useState<DirectMessage | null>(null);
  const [busyEdit, setBusyEdit] = useState(false);
  const [menuId, setMenuId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [headerMenu, setHeaderMenu] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [peerRead, setPeerRead] = useState(conversation.peer_read_message_id);
  const [peerTyping, setPeerTyping] = useState(conversation.typing);
  const [picker, setPicker] = useState<"emoji" | "stickers" | null>(null);
  const [stickers, setStickers] = useState<MessageSticker[]>([]);
  const [stickerError, setStickerError] = useState("");
  const [stickersLoaded, setStickersLoaded] = useState(false);
  const [attachment, setAttachment] = useState<MessageAttachment | null>(() =>
    readDraftAttachment(key),
  );
  const [uploading, setUploading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [report, setReport] = useState<DirectMessage | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState("");
  const [newBelow, setNewBelow] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const alive = useRef(true);
  const controllers = useRef(new Set<AbortController>());
  const refreshController = useRef<AbortController | null>(null);
  const oldestLoaded = useRef<number | null>(null);
  const typingTimer = useRef<number | undefined>(undefined);
  const lastTyping = useRef(0);
  const lastRead = useRef(conversation.read_message_id);
  const previousDraft = useRef("");
  const restoring = useRef<{ height: number; top: number } | null>(null);
  const sending = useRef(new Set<string>());
  const snapshots = useRef<{
    reply: DirectMessage | null;
    editing: DirectMessage | null;
    report: DirectMessage | null;
  }>({ reply: null, editing: null, report: null });
  const paginationController = useRef<AbortController | null>(null);
  const blocked =
    disabled || conversation.blocked_by_me || conversation.blocked_by_peer;

  useEffect(() => {
    snapshots.current = { reply, editing, report };
  }, [reply, editing, report]);
  useEffect(() => {
    writeDraftAttachment(key, attachment);
  }, [key, attachment]);

  useEffect(() => {
    alive.current = true;
    const runningControllers = controllers.current;
    return () => {
      alive.current = false;
      for (const controller of runningControllers) controller.abort();
      window.clearTimeout(typingTimer.current);
    };
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setActiveQuery(query.trim());
      paginationController.current?.abort();
      setOlderLoading(false);
      oldestLoaded.current = null;
      nearBottom.current = true;
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    try {
      if (pending.length)
        sessionStorage.setItem(`${key}_outbox`, JSON.stringify(pending));
      else sessionStorage.removeItem(`${key}_outbox`);
    } catch {}
  }, [pending, key]);
  const markRead = useCallback(
    async (id: number) => {
      if (
        !id ||
        id <= lastRead.current ||
        document.visibilityState === "hidden" ||
        !nearBottom.current
      )
        return;
      await api(`/qmessage/conversations/${conversation.id}/read`, {
        method: "POST",
        body: JSON.stringify({ message_id: id }),
      });
      if (!alive.current) return;
      lastRead.current = Math.max(lastRead.current, id);
      onChanged();
    },
    [conversation.id, onChanged],
  );
  const refresh = useCallback(async () => {
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    controllers.current.add(controller);
    try {
      const endpoint = `/qmessage/conversations/${conversation.id}/messages?limit=50${activeQuery ? `&q=${encodeURIComponent(activeQuery)}` : ""}`;
      const first = await api<MessagePage>(endpoint, {
        signal: controller.signal,
      });
      let next = first;
      let collected = first.items;
      const oldest = oldestLoaded.current;
      while (
        next.has_more &&
        oldest !== null &&
        collected.length &&
        collected[0].id > oldest
      ) {
        next = await api<MessagePage>(`${endpoint}&before=${collected[0].id}`, {
          signal: controller.signal,
        });
        if (!next.items.length) break;
        collected = [...next.items, ...collected];
      }
      const authoritative = new Map(
        collected.map((message) => [message.id, message]),
      );
      const selectedSnapshots = [
        snapshots.current.reply,
        snapshots.current.editing,
        snapshots.current.report,
      ].filter((message): message is DirectMessage => message !== null);
      for (const selected of selectedSnapshots) {
        if (authoritative.has(selected.id)) continue;
        const row = await api<MessagePage>(
          `/qmessage/conversations/${conversation.id}/messages?before=${selected.id + 1}&limit=1`,
          { signal: controller.signal },
        );
        const found = row.items.find((message) => message.id === selected.id);
        if (found) authoritative.set(found.id, found);
      }
      if (!alive.current || controller.signal.aborted)
        throw new DOMException("Aborted", "AbortError");
      setMessages(collected);
      setReply((current) =>
        current
          ? authoritative.get(current.id)?.deleted
            ? null
            : authoritative.get(current.id) || current
          : null,
      );
      const selectedEdit = snapshots.current.editing;
      if (selectedEdit && authoritative.get(selectedEdit.id)?.deleted) {
        setEditing(null);
        setText(previousDraft.current);
        setNotice(
          "Сообщение удалено. Изменение отменено, ваш черновик сохранён.",
        );
      } else
        setEditing((current) =>
          current ? authoritative.get(current.id) || current : null,
        );
      setReport((current) =>
        current
          ? authoritative.get(current.id)?.deleted
            ? null
            : authoritative.get(current.id) || current
          : null,
      );
      setHasMore(next.has_more);
      setPeerRead(first.peer_read_message_id);
      setPeerTyping(first.typing);
      window.clearTimeout(typingTimer.current);
      if (first.typing)
        typingTimer.current = window.setTimeout(
          () => setPeerTyping(false),
          8500,
        );
      setError("");
      setLoading(false);
      const accepted = new Set(collected.map((message) => message.client_id));
      setPending((current) =>
        current.filter((message) => !accepted.has(message.client_id)),
      );
      const newest = collected.at(-1)?.id;
      if (newest && !activeQuery) void markRead(newest).catch(() => {});
      if (
        !nearBottom.current &&
        first.items.some(
          (message) =>
            message.id > (lastRead.current || 0) &&
            message.author_id !== user.id,
        )
      )
        setNewBelow(true);
    } catch (cause) {
      if (alive.current && !controller.signal.aborted) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось обновить сообщения",
        );
        setLoading(false);
      }
      throw cause;
    } finally {
      controllers.current.delete(controller);
    }
  }, [activeQuery, conversation.id, markRead, user.id]);
  useEffect(() => {
    registerRefresh(refresh);
    return () => registerRefresh(null);
  }, [refresh, registerRefresh]);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh, revision]);
  useEffect(() => {
    const view = viewport.current;
    if (!view) return;
    const frame = window.requestAnimationFrame(() => {
      if (restoring.current) {
        view.scrollTop =
          restoring.current.top + view.scrollHeight - restoring.current.height;
        restoring.current = null;
      } else if (nearBottom.current) view.scrollTop = view.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, pending, peerTyping]);
  useEffect(() => {
    if (!picker) return;
    const controller = new AbortController();
    void api<{ items: MessageSticker[] }>("/qmessage/stickers", {
      signal: controller.signal,
    })
      .then((data) => {
        setStickers(data.items);
        setStickersLoaded(true);
        setStickerError("");
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setStickersLoaded(true);
          setStickerError(
            cause instanceof Error
              ? cause.message
              : "Не удалось загрузить стикеры",
          );
        }
      });
    return () => controller.abort();
  }, [picker]);
  useEffect(() => {
    if (!report) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.current?.querySelector("textarea")?.focus();
    return () => previous?.focus();
  }, [report]);

  async function older() {
    if (!messages.length || olderLoading) return;
    setOlderLoading(true);
    const controller = new AbortController();
    paginationController.current?.abort();
    paginationController.current = controller;
    controllers.current.add(controller);
    try {
      const data = await api<MessagePage>(
        `/qmessage/conversations/${conversation.id}/messages?before=${messages[0].id}&limit=50${activeQuery ? `&q=${encodeURIComponent(activeQuery)}` : ""}`,
        { signal: controller.signal },
      );
      if (!alive.current || controller.signal.aborted) return;
      if (viewport.current)
        restoring.current = {
          height: viewport.current.scrollHeight,
          top: viewport.current.scrollTop,
        };
      nearBottom.current = false;
      if (data.items.length) oldestLoaded.current = data.items[0].id;
      setMessages((current) => mergeMessages(current, data.items));
      setHasMore(data.has_more);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось загрузить историю",
        );
    } finally {
      controllers.current.delete(controller);
      if (alive.current && paginationController.current === controller)
        setOlderLoading(false);
    }
  }
  function updateText(value: string) {
    setText(value);
    if (!editing) writeDraft(key, value);
    if (
      !editing &&
      !blocked &&
      (!value.trim() || Date.now() - lastTyping.current > 3000)
    ) {
      lastTyping.current = Date.now();
      void api(`/qmessage/conversations/${conversation.id}/typing`, {
        method: "POST",
        body: JSON.stringify({ typing: Boolean(value.trim()) }),
      }).catch(() => {});
    }
  }
  async function deliver(item: PendingMessage) {
    if (sending.current.has(item.client_id) || blocked) return;
    sending.current.add(item.client_id);
    setPending((current) =>
      current.map((message) =>
        message.client_id === item.client_id
          ? { ...message, status: "sending", error: "" }
          : message,
      ),
    );
    try {
      const sent = await api<DirectMessage>(
        `/qmessage/conversations/${conversation.id}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            client_id: item.client_id,
            text: item.text,
            sticker_id: item.sticker_id,
            reply_to_id: item.reply_to_id,
            attachment_id: item.attachment_id,
          }),
        },
      );
      if (!alive.current) return;
      nearBottom.current = true;
      setMessages((current) => mergeMessages(current, [sent]));
      setPending((current) =>
        current.filter((message) => message.client_id !== item.client_id),
      );
      onChanged();
      void refresh().catch(() => {});
    } catch (cause) {
      if (alive.current)
        setPending((current) =>
          current.map((message) =>
            message.client_id === item.client_id
              ? {
                  ...message,
                  status: "failed",
                  error:
                    cause instanceof Error
                      ? cause.message
                      : "Отправка не подтверждена",
                }
              : message,
          ),
        );
    } finally {
      sending.current.delete(item.client_id);
    }
  }
  function enqueue(sticker: MessageSticker | null = null) {
    if (pending.length >= 20) {
      setError(
        "В очереди уже 20 неподтверждённых сообщений. Повторите отправку или разберите очередь, прежде чем писать новые.",
      );
      return;
    }
    if (blocked || uploading || (!sticker && !text.trim() && !attachment))
      return;
    const item: PendingMessage = {
      client_id: messageClientId(),
      text: sticker ? "" : text.trim(),
      sticker_id: sticker?.id || null,
      sticker,
      reply_to_id: reply?.id || null,
      attachment_id: sticker ? null : attachment?.id || null,
      attachment: sticker ? null : attachment,
      status: "sending",
    };
    setPending((current) => [...current, item]);
    nearBottom.current = true;
    if (!sticker) {
      setText("");
      writeDraft(key, "");
      setAttachment(null);
    }
    setReply(null);
    setPicker(null);
    void deliver(item);
    void api(`/qmessage/conversations/${conversation.id}/typing`, {
      method: "POST",
      body: JSON.stringify({ typing: false }),
    }).catch(() => {});
    composer.current?.focus();
  }
  function cancelEdit() {
    setEditing(null);
    setText(previousDraft.current);
    composer.current?.focus();
  }
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!editing) {
      enqueue();
      return;
    }
    if (
      busyEdit ||
      blocked ||
      (!text.trim() && !editing.attachment && !editing.sticker)
    )
      return;
    setBusyEdit(true);
    setError("");
    try {
      const result = await api<DirectMessage>(
        `/qmessage/messages/${editing.id}`,
        { method: "PATCH", body: JSON.stringify({ text: text.trim() }) },
      );
      setMessages((current) => mergeMessages(current, [result]));
      cancelEdit();
      onChanged();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось изменить сообщение",
      );
    } finally {
      setBusyEdit(false);
    }
  }
  async function upload(file: File | undefined) {
    if (!file || blocked || uploading) return;
    if (
      !/\.(png|jpe?g|webp)$/i.test(file.name) ||
      file.size <= 0 ||
      file.size > 6 * 1024 * 1024
    ) {
      setError("Выберите PNG, JPEG или WebP размером до 6 МБ.");
      return;
    }
    setUploading(true);
    setError("");
    const controller = new AbortController();
    try {
      const body = new FormData();
      body.set("file", file);
      const data = await api<MessageAttachment>(
        `/qmessage/conversations/${conversation.id}/attachments`,
        { method: "POST", body, signal: controller.signal },
      );
      writeDraftAttachment(key, data);
      if (alive.current) {
        setAttachment(data);
        composer.current?.focus();
      }
      if (attachment && attachment.id !== data.id)
        void api(`/qmessage/attachments/${attachment.id}`, {
          method: "DELETE",
        }).catch(() => {});
    } catch (cause) {
      if (alive.current && !controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось загрузить изображение. Выберите его ещё раз.",
        );
    } finally {
      if (alive.current) setUploading(false);
    }
  }
  async function discardAttachment() {
    if (!attachment || uploading) return;
    setUploading(true);
    try {
      await api(`/qmessage/attachments/${attachment.id}`, { method: "DELETE" });
      if (alive.current) setAttachment(null);
    } catch (cause) {
      if (alive.current && cause instanceof ApiError && cause.status === 404)
        setAttachment(null);
      else if (alive.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось убрать изображение. Повторите попытку.",
        );
    } finally {
      if (alive.current) setUploading(false);
    }
  }
  async function react(message: DirectMessage, emoji: string) {
    if (blocked || actionBusy) return;
    setActionBusy(true);
    try {
      const mine = message.reactions.some(
        (reaction) =>
          reaction.emoji === emoji && reaction.user_ids.includes(user.id),
      );
      const result = await api<DirectMessage>(
        `/qmessage/messages/${message.id}/reaction`,
        { method: "PUT", body: JSON.stringify({ emoji: mine ? null : emoji }) },
      );
      setMessages((current) => mergeMessages(current, [result]));
      setMenuId(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось сохранить реакцию",
      );
    } finally {
      setActionBusy(false);
    }
  }
  async function remove(message: DirectMessage) {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      await api(`/qmessage/messages/${message.id}`, { method: "DELETE" });
      setMenuId(null);
      setConfirmDelete(null);
      await refresh();
      onChanged();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось удалить сообщение",
      );
    } finally {
      setActionBusy(false);
    }
  }
  async function block() {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      await api(`/qmessage/users/${conversation.peer.id}/block`, {
        method: "PUT",
        body: JSON.stringify({ blocked: !conversation.blocked_by_me }),
      });
      setHeaderMenu(false);
      onChanged();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось изменить блокировку",
      );
    } finally {
      setActionBusy(false);
    }
  }
  async function submitReport(event: FormEvent) {
    event.preventDefault();
    if (!report || reportBusy || !reportReason.trim()) return;
    setReportBusy(true);
    setReportError("");
    try {
      await api(`/qmessage/messages/${report.id}/report`, {
        method: "POST",
        body: JSON.stringify({ reason: reportReason.trim() }),
      });
      setReport(null);
      setReportReason("");
      setNotice(
        "Жалоба отправлена. Администратору доступно только отмеченное сообщение и причина жалобы.",
      );
    } catch (cause) {
      setReportError(
        cause instanceof Error ? cause.message : "Не удалось отправить жалобу",
      );
    } finally {
      setReportBusy(false);
    }
  }
  function scrollBottom() {
    nearBottom.current = true;
    setNewBelow(false);
    viewport.current?.scrollTo({
      top: viewport.current.scrollHeight,
      behavior: "smooth",
    });
    const newest = messages.at(-1)?.id;
    if (newest && !activeQuery) void markRead(newest).catch(() => {});
  }
  function composerKeys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submit();
    }
    if (event.key === "Escape") {
      setPicker(null);
      if (editing) cancelEdit();
      else setReply(null);
    }
  }
  return (
    <div className={styles.thread}>
      <header className={styles.threadHeader}>
        <button
          type="button"
          className={`${styles.iconButton} ${styles.mobileBack}`}
          aria-label="Вернуться к диалогам"
          onClick={onBack}
        >
          <ArrowLeft size={21} />
        </button>
        <span className={styles.avatar}>
          {messageInitials(conversation.peer.name)}
        </span>
        <div className={styles.peerCopy}>
          <h1>{conversation.peer.name}</h1>
          <p>
            {peerTyping ? (
              <span className={styles.typingText}>печатает…</span>
            ) : (
              <>
                {conversation.peer.group_name || "Без группы"}
                <span> · ID {conversation.peer.id}</span>
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Поиск в переписке"
          aria-expanded={searchOpen}
          onClick={() => {
            setSearchOpen(!searchOpen);
            if (searchOpen) setQuery("");
          }}
        >
          <Search size={20} />
        </button>
        <div className={styles.headerMenuWrap}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Настройки диалога"
            aria-expanded={headerMenu}
            onClick={() => setHeaderMenu(!headerMenu)}
          >
            <MoreHorizontal size={22} />
          </button>
          {headerMenu && (
            <div className={styles.headerMenu}>
              <span>
                История доступна только участникам. Жалоба передаёт
                администратору отмеченное сообщение.
              </span>
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => void block()}
              >
                <ShieldBan size={16} />
                {conversation.blocked_by_me
                  ? "Разблокировать"
                  : "Заблокировать"}
              </button>
              <button type="button" onClick={() => setHeaderMenu(false)}>
                Закрыть <X size={14} />
              </button>
            </div>
          )}
        </div>
      </header>
      {searchOpen && (
        <div className={styles.threadSearch}>
          <Search size={17} />
          <label className={styles.srOnly} htmlFor="qmessage-chat-search">
            Поиск по всей переписке
          </label>
          <input
            id="qmessage-chat-search"
            autoFocus
            value={query}
            placeholder="Поиск по всей переписке…"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            aria-label="Закрыть поиск"
            onClick={() => {
              setSearchOpen(false);
              setQuery("");
            }}
          >
            <X size={17} />
          </button>
        </div>
      )}
      {error && (
        <div className={styles.threadError} role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void refresh().catch(() => {})}>
            Повторить <RefreshCw size={14} />
          </button>
          <button
            type="button"
            aria-label="Скрыть ошибку"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className={styles.threadNotice} role="status">
          <span>{notice}</span>
          <button
            type="button"
            aria-label="Скрыть уведомление"
            onClick={() => setNotice("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <div
        className={styles.timeline}
        ref={viewport}
        onScroll={() => {
          const view = viewport.current;
          if (!view) return;
          nearBottom.current =
            view.scrollHeight - view.scrollTop - view.clientHeight < 90;
          if (nearBottom.current) {
            setNewBelow(false);
            const newest = messages.at(-1)?.id;
            if (newest && !activeQuery) void markRead(newest).catch(() => {});
          }
        }}
        aria-label={
          activeQuery ? "Результаты поиска сообщений" : "История сообщений"
        }
      >
        {hasMore && (
          <button
            type="button"
            className={styles.olderButton}
            disabled={olderLoading}
            onClick={() => void older()}
          >
            {olderLoading ? (
              <LoaderCircle className={styles.spin} size={15} />
            ) : (
              <ChevronDown size={15} />
            )}{" "}
            Более ранние сообщения
          </button>
        )}
        {loading && (
          <div className={styles.threadEmpty} role="status">
            <LoaderCircle className={styles.spin} size={25} /> Открываем
            переписку…
          </div>
        )}
        {!loading && !messages.length && (
          <div className={styles.threadEmpty}>
            <span className={styles.emptyWave}>👋</span>
            <h2>
              {activeQuery
                ? "Ничего не найдено"
                : `Привет, ${conversation.peer.name.split(" ")[0]}!`}
            </h2>
            <p>
              {activeQuery
                ? "Попробуйте другое слово или очистите поиск."
                : "Разговор начинается с первого сообщения."}
            </p>
          </div>
        )}
        {messages.map((message, index) => (
          <div key={message.id}>
            {(index === 0 ||
              messageDay(message.created_at) !==
                messageDay(messages[index - 1].created_at)) && (
              <div className={styles.dateDivider}>
                <span>{messageDay(message.created_at)}</span>
              </div>
            )}
            <div
              className={`${styles.messageRow} ${message.author_id === user.id ? styles.ownRow : ""}`}
            >
              <article
                className={`${styles.bubble} ${message.author_id === user.id ? styles.ownBubble : ""} ${message.deleted ? styles.deletedBubble : ""}`}
                aria-label={
                  message.author_id === user.id
                    ? "Ваше сообщение"
                    : `Сообщение от ${conversation.peer.name}`
                }
              >
                {!message.deleted && message.reply_to && (
                  <div className={styles.replyQuote}>
                    <strong>
                      {message.reply_to.author_id === user.id
                        ? "Вы"
                        : conversation.peer.name}
                    </strong>
                    <span>
                      {message.reply_to.deleted
                        ? "Сообщение удалено"
                        : message.reply_to.text ||
                          (message.reply_to.sticker_id
                            ? "Стикер"
                            : "Изображение")}
                    </span>
                  </div>
                )}
                {message.deleted ? (
                  <p className={styles.deletedText}>Сообщение удалено</p>
                ) : (
                  <>
                    {message.sticker && (
                      <StickerPicture sticker={message.sticker} />
                    )}
                    {attachmentUrl(message.attachment) && (
                      <a
                        href={attachmentUrl(message.attachment)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.messageImageLink}
                        aria-label={`Открыть изображение: ${message.attachment!.filename}`}
                      >
                        <Image
                          src={attachmentUrl(message.attachment)!}
                          alt={message.attachment!.filename}
                          width={message.attachment!.width}
                          height={message.attachment!.height}
                          sizes="(max-width: 600px) 72vw, 340px"
                          unoptimized
                        />
                      </a>
                    )}
                    {message.text && (
                      <p className={styles.messageText}>{message.text}</p>
                    )}
                  </>
                )}
                <div className={styles.messageMeta}>
                  {message.edited_at && !message.deleted && (
                    <span>изменено</span>
                  )}
                  <time dateTime={message.created_at}>
                    {messageTime(message.created_at)}
                  </time>
                  {message.author_id === user.id && (
                    <CheckCheck
                      size={14}
                      className={
                        message.id <= peerRead ? styles.readReceipt : ""
                      }
                      aria-label={
                        message.id <= peerRead ? "Прочитано" : "Отправлено"
                      }
                    />
                  )}
                </div>
                {!message.deleted && message.reactions.length > 0 && (
                  <div className={styles.reactions}>
                    {message.reactions.map((reaction) => (
                      <button
                        type="button"
                        key={reaction.emoji}
                        className={
                          reaction.user_ids.includes(user.id)
                            ? styles.myReaction
                            : ""
                        }
                        disabled={blocked || actionBusy}
                        onClick={() => void react(message, reaction.emoji)}
                        aria-label={`${reaction.emoji}: ${reaction.count}${reaction.user_ids.includes(user.id) ? ", ваша реакция" : ""}`}
                      >
                        {reaction.emoji}
                        <span>{reaction.count}</span>
                      </button>
                    ))}
                  </div>
                )}
              </article>
              {!message.deleted && (
                <div className={styles.messageMenuWrap}>
                  <button
                    type="button"
                    className={styles.messageMenuButton}
                    aria-label="Действия с сообщением"
                    aria-expanded={menuId === message.id}
                    onClick={() => {
                      setMenuId(menuId === message.id ? null : message.id);
                      setConfirmDelete(null);
                    }}
                  >
                    <MoreHorizontal size={18} />
                  </button>
                  {menuId === message.id && (
                    <div className={styles.messageMenu}>
                      {!blocked && (
                        <div className={styles.reactionPicker}>
                          {MESSAGE_REACTIONS.map((emoji) => (
                            <button
                              type="button"
                              key={emoji}
                              disabled={actionBusy}
                              onClick={() => void react(message, emoji)}
                              aria-label={`Реакция ${emoji}`}
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                      )}
                      {!blocked && (
                        <button
                          type="button"
                          onClick={() => {
                            setReply(message);
                            setMenuId(null);
                            composer.current?.focus();
                          }}
                        >
                          <CornerUpLeft size={15} /> Ответить
                        </button>
                      )}
                      {message.text && (
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard
                              ?.writeText(message.text)
                              .then(() => {
                                setNotice("Текст скопирован.");
                                setMenuId(null);
                              })
                              .catch(() =>
                                setError(
                                  "Не удалось скопировать. Выделите текст сообщения вручную.",
                                ),
                              );
                          }}
                        >
                          <Copy size={15} /> Скопировать текст
                        </button>
                      )}
                      {message.author_id === user.id ? (
                        <>
                          {!blocked && (
                            <button
                              type="button"
                              onClick={() => {
                                previousDraft.current = readDraft(key);
                                setText(message.text);
                                setEditing(message);
                                setReply(null);
                                setMenuId(null);
                                composer.current?.focus();
                              }}
                            >
                              <Pencil size={15} /> Изменить
                            </button>
                          )}
                          {confirmDelete === message.id ? (
                            <button
                              type="button"
                              className={styles.dangerAction}
                              disabled={actionBusy}
                              onClick={() => void remove(message)}
                            >
                              <Trash2 size={15} /> Да, удалить у обоих
                            </button>
                          ) : (
                            <button
                              type="button"
                              className={styles.dangerAction}
                              onClick={() => setConfirmDelete(message.id)}
                            >
                              <Trash2 size={15} /> Удалить у обоих
                            </button>
                          )}
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setReport(message);
                            setReportReason("");
                            setReportError("");
                            setMenuId(null);
                          }}
                        >
                          <Flag size={15} /> Пожаловаться
                        </button>
                      )}
                      <button type="button" onClick={() => setMenuId(null)}>
                        <X size={15} /> Закрыть
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {!activeQuery &&
          pending.map((item) => (
            <div
              key={item.client_id}
              className={`${styles.messageRow} ${styles.ownRow}`}
            >
              <article
                className={`${styles.bubble} ${styles.ownBubble} ${styles.pendingBubble}`}
              >
                {item.sticker && <StickerPicture sticker={item.sticker} />}
                {item.attachment && (
                  <span className={styles.pendingAttachment}>
                    <ImagePlus size={15} /> {item.attachment.filename}
                  </span>
                )}
                {item.text && <p className={styles.messageText}>{item.text}</p>}
                <div className={styles.pendingState}>
                  {item.status === "sending" ? (
                    <>
                      <LoaderCircle className={styles.spin} size={12} />{" "}
                      Отправляем…
                    </>
                  ) : (
                    <>
                      <span>{item.error || "Не отправлено"}</span>
                      <button
                        type="button"
                        disabled={blocked}
                        onClick={() => void deliver(item)}
                      >
                        Повторить <RefreshCw size={12} />
                      </button>
                      {item.sticker_id ? (
                        <button
                          type="button"
                          onClick={() =>
                            setPending((current) =>
                              current.filter(
                                (message) =>
                                  message.client_id !== item.client_id,
                              ),
                            )
                          }
                        >
                          Убрать стикер из очереди
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={Boolean(text || attachment || editing)}
                          title={
                            text || attachment || editing
                              ? "Сначала отправьте или сохраните текущий черновик."
                              : undefined
                          }
                          onClick={() => {
                            if (text || attachment || editing) return;
                            updateText(item.text);
                            if (item.attachment) setAttachment(item.attachment);
                            setPending((current) =>
                              current.filter(
                                (message) =>
                                  message.client_id !== item.client_id,
                              ),
                            );
                          }}
                        >
                          Вернуть в черновик
                        </button>
                      )}
                    </>
                  )}
                </div>
              </article>
            </div>
          ))}
        {peerTyping && !activeQuery && (
          <p className={styles.typingBubble} role="status">
            <span>•••</span> {conversation.peer.name} печатает
          </p>
        )}
      </div>
      {newBelow && (
        <button
          type="button"
          className={styles.newMessages}
          onClick={scrollBottom}
        >
          Новые сообщения <ArrowDown size={15} />
        </button>
      )}
      <div className={styles.composerArea}>
        {blocked ? (
          <p className={styles.blockedNotice}>
            {conversation.blocked_by_me ? (
              <>
                Вы заблокировали пользователя.{" "}
                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={() => void block()}
                >
                  Разблокировать
                </button>
              </>
            ) : disabled ? (
              "Отправка сообщений сейчас недоступна."
            ) : (
              "Сейчас отправить сообщение этому пользователю нельзя."
            )}
          </p>
        ) : (
          <>
            {(reply || editing) && (
              <div className={styles.composerContext}>
                {editing ? <Pencil size={17} /> : <CornerUpLeft size={18} />}
                <div>
                  <strong>
                    {editing
                      ? "Изменение сообщения"
                      : reply?.author_id === user.id
                        ? "Ответ себе"
                        : `Ответ: ${conversation.peer.name}`}
                  </strong>
                  <span>
                    {(editing || reply)?.text ||
                      ((editing || reply)?.sticker ? "Стикер" : "Изображение")}
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={editing ? "Отменить изменение" : "Отменить ответ"}
                  onClick={() => (editing ? cancelEdit() : setReply(null))}
                >
                  <X size={17} />
                </button>
              </div>
            )}
            {attachment && (
              <div className={styles.attachmentDraft}>
                <ImagePlus size={20} />
                <div>
                  <strong>{attachment.filename}</strong>
                  <span>
                    {formatBytes(attachment.size_bytes)} · готово к отправке
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="Убрать изображение"
                  disabled={uploading}
                  onClick={() => void discardAttachment()}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {picker && (
              <div className={styles.picker}>
                <div className={styles.pickerHeader}>
                  <button
                    type="button"
                    className={picker === "emoji" ? styles.activeTab : ""}
                    onClick={() => setPicker("emoji")}
                  >
                    <Smile size={15} /> Эмодзи
                  </button>
                  <button
                    type="button"
                    className={picker === "stickers" ? styles.activeTab : ""}
                    onClick={() => setPicker("stickers")}
                  >
                    <Sticker size={15} /> Стикеры
                  </button>
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label="Закрыть эмодзи и стикеры"
                    onClick={() => setPicker(null)}
                  >
                    <X size={16} />
                  </button>
                </div>
                {picker === "emoji" ? (
                  <div className={styles.emojiGrid}>
                    {MESSAGE_EMOJI.map((emoji) => (
                      <button
                        type="button"
                        key={emoji}
                        onClick={() => {
                          updateText(`${text}${emoji}`);
                          composer.current?.focus();
                        }}
                        aria-label={`Вставить ${emoji}`}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className={styles.stickerGrid}>
                    {stickerError ? (
                      <p role="alert">{stickerError}</p>
                    ) : !stickers.length ? (
                      <p role="status">
                        {stickersLoaded
                          ? "Стикеры пока не добавлены."
                          : "Загружаем стикеры…"}
                      </p>
                    ) : (
                      stickers.map((sticker) => (
                        <button
                          type="button"
                          key={sticker.id}
                          disabled={Boolean(editing)}
                          onClick={() => enqueue(sticker)}
                          aria-label={`Отправить стикер: ${sticker.label}`}
                          title={sticker.label}
                        >
                          <StickerPicture sticker={sticker} />
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
            <form
              className={styles.composer}
              onSubmit={(event) => void submit(event)}
            >
              <button
                type="button"
                className={styles.iconButton}
                aria-label="Эмодзи и стикеры"
                aria-expanded={Boolean(picker)}
                onClick={() => setPicker(picker ? null : "emoji")}
              >
                <Smile size={23} />
              </button>
              <label className={styles.srOnly} htmlFor="qmessage-text">
                Сообщение
              </label>
              <textarea
                ref={composer}
                id="qmessage-text"
                value={text}
                rows={1}
                maxLength={4000}
                placeholder={
                  editing ? "Изменить сообщение…" : "Написать сообщение…"
                }
                onChange={(event) => updateText(event.target.value)}
                onKeyDown={composerKeys}
                disabled={busyEdit}
              />
              <input
                ref={imageInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className={styles.hiddenFile}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  void upload(file);
                }}
              />
              <button
                type="button"
                className={styles.iconButton}
                aria-label="Прикрепить изображение"
                disabled={uploading || Boolean(editing)}
                onClick={() => imageInput.current?.click()}
              >
                {uploading ? (
                  <LoaderCircle className={styles.spin} size={21} />
                ) : (
                  <ImagePlus size={21} />
                )}
              </button>
              <button
                type="submit"
                className={styles.sendButton}
                disabled={
                  uploading ||
                  busyEdit ||
                  (!text.trim() &&
                    !attachment &&
                    !(editing?.attachment || editing?.sticker))
                }
                aria-label={
                  editing ? "Сохранить изменение" : "Отправить сообщение"
                }
              >
                {busyEdit ? (
                  <LoaderCircle className={styles.spin} size={19} />
                ) : editing ? (
                  <CheckCheck size={22} />
                ) : (
                  <Send size={20} />
                )}
              </button>
            </form>
            <div className={styles.composerHint}>
              <span>Enter — отправить · Shift + Enter — новая строка</span>
              {text.length > 3500 && <span>{text.length} / 4000</span>}
            </div>
          </>
        )}
      </div>
      {report && (
        <div
          className={styles.modalBackdrop}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !reportBusy)
              setReport(null);
          }}
        >
          <div
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="qmessage-report-title"
            className={styles.reportDialog}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !reportBusy) setReport(null);
              if (event.key === "Tab") {
                const focusable = dialog.current?.querySelectorAll<HTMLElement>(
                  "button:not(:disabled),textarea:not(:disabled)",
                );
                if (!focusable?.length) return;
                const first = focusable[0],
                  last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first.focus();
                }
              }
            }}
          >
            <div className={styles.reportTitle}>
              <Flag size={22} />
              <h2 id="qmessage-report-title">Пожаловаться на сообщение</h2>
              <button
                type="button"
                className={styles.iconButton}
                disabled={reportBusy}
                onClick={() => setReport(null)}
                aria-label="Закрыть жалобу"
              >
                <X size={18} />
              </button>
            </div>
            <p>
              Администратор получит это сообщение и вашу причину. Остальная
              переписка ему не открывается.
            </p>
            <blockquote>
              {report.text || (report.sticker ? "Стикер" : "Изображение")}
            </blockquote>
            <form onSubmit={(event) => void submitReport(event)}>
              <label htmlFor="qmessage-report-reason">Что произошло?</label>
              <textarea
                id="qmessage-report-reason"
                required
                maxLength={1000}
                rows={4}
                value={reportReason}
                onChange={(event) => setReportReason(event.target.value)}
                placeholder="Опишите причину жалобы…"
                disabled={reportBusy}
              />
              {reportError && (
                <p className={styles.reportError} role="alert">
                  {reportError}
                </p>
              )}
              <button
                type="submit"
                className={styles.primary}
                disabled={reportBusy || !reportReason.trim()}
              >
                {reportBusy ? (
                  <LoaderCircle size={16} className={styles.spin} />
                ) : (
                  <Flag size={16} />
                )}{" "}
                Отправить жалобу
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
