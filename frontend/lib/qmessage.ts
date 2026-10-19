export interface MessageConfig {
  enabled: boolean;
  title: string;
  description?: string;
  announcement: string;
  logo_url: string;
  logo_custom: boolean;
}
export interface MessageUser {
  id: number;
  name: string;
  group_name: string | null;
  avatar_url: string | null;
  online: boolean;
}
export interface MessageSticker {
  id: string;
  label: string;
  emoji: string;
  image_url: string | null;
  active: boolean;
  position: number;
  builtin: boolean;
}
export interface MessageAttachment {
  id: number;
  url: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  width: number;
  height: number;
}
export interface DirectMessage {
  id: number;
  conversation_id: number;
  author_id: number;
  text: string;
  sticker_id: string | null;
  sticker: MessageSticker | null;
  attachment: MessageAttachment | null;
  reply_to_id: number | null;
  reply_to: {
    id: number;
    author_id: number;
    text: string;
    sticker_id: string | null;
    deleted: boolean;
  } | null;
  client_id: string;
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
  reactions: { emoji: string; count: number; user_ids: number[] }[];
}
export interface MessageConversation {
  id: number;
  peer: MessageUser;
  last_message: DirectMessage | null;
  unread_count: number;
  read_message_id: number;
  peer_read_message_id: number;
  blocked_by_me: boolean;
  blocked_by_peer: boolean;
  updated_at: string;
  typing: boolean;
}
export interface ConversationList {
  items: MessageConversation[];
  cursor: number;
  account: { banned: boolean; ban_reason: string };
}
export interface MessagePage {
  items: DirectMessage[];
  has_more: boolean;
  typing: boolean;
  peer_read_message_id: number;
  read_message_id: number;
}
export interface MessageEvents {
  items: {
    id: number;
    type: string;
    conversation_id: number | null;
    message_id: number | null;
  }[];
  cursor: number;
  has_more: boolean;
  reset?: boolean;
}
export interface PendingMessage {
  client_id: string;
  text: string;
  sticker_id: string | null;
  sticker?: MessageSticker | null;
  reply_to_id: number | null;
  attachment_id: number | null;
  attachment?: MessageAttachment | null;
  status: "sending" | "failed";
  error?: string;
}
export const MESSAGE_REACTIONS = [
  "👍",
  "❤️",
  "😂",
  "🎉",
  "😮",
  "😢",
  "👏",
  "🔥",
];
export const MESSAGE_EMOJI = [
  "😀",
  "😊",
  "😂",
  "😍",
  "🤔",
  "😎",
  "🥳",
  "😴",
  "😢",
  "😮",
  "👋",
  "👍",
  "👏",
  "🙏",
  "❤️",
  "🔥",
  "✨",
  "🎉",
  "📚",
  "⚽",
  "✅",
  "💡",
  "☕",
  "🚀",
];
export function conversationId(value: string | null): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
export function messageInitials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/u)
      .slice(0, 2)
      .map((word) => Array.from(word)[0] || "")
      .join("")
      .toLocaleUpperCase("ru-RU") || "?"
  );
}
export function messageDate(value: string) {
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
    ? value
    : `${value}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}
export function messageTime(value: string) {
  return (
    messageDate(value)?.toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    }) || ""
  );
}
export function messageDay(value: string) {
  return (
    messageDate(value)?.toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }) || ""
  );
}
export function messagePreview(message: DirectMessage | null) {
  if (!message) return "Начните разговор";
  if (message.deleted) return "Сообщение удалено";
  return (
    message.text ||
    (message.sticker
      ? `${message.sticker.emoji} ${message.sticker.label}`
      : message.attachment
        ? "📷 Изображение"
        : "Стикер")
  );
}
export function attachmentUrl(value: MessageAttachment | null | undefined) {
  return value &&
    value.url === `/api/qmessage/attachments/${value.id}` &&
    Number.isSafeInteger(value.id) &&
    value.id > 0
    ? value.url
    : null;
}
export function stickerUrl(value: MessageSticker | null | undefined) {
  if (
    value?.builtin &&
    [
      "wave",
      "heart",
      "spark",
      "party",
      "laugh",
      "study",
      "goal",
      "thanks",
    ].includes(value.id) &&
    value.image_url === `/qmessage-stickers/${value.id}.svg`
  )
    return value.image_url;
  return value &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.id) &&
    value.image_url === `/api/qmessage/stickers/${value.id}/image`
    ? value.image_url
    : null;
}
export function mergeMessages(
  previous: DirectMessage[],
  incoming: DirectMessage[],
) {
  const merged = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) merged.set(message.id, message);
  return [...merged.values()].sort((a, b) => a.id - b.id);
}
export function draftKey(user: number, conversation: number) {
  return `qmessage_draft_${user}_${conversation}`;
}
export function messageClientId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  )
    crypto.getRandomValues(bytes);
  else
    for (let index = 0; index < bytes.length; index++)
      bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function readDraft(key: string) {
  try {
    return typeof window === "undefined"
      ? ""
      : sessionStorage.getItem(key)?.slice(0, 4000) || "";
  } catch {
    return "";
  }
}
export function writeDraft(key: string, value: string) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {}
}
export function readDraftAttachment(key: string): MessageAttachment | null {
  try {
    if (typeof window === "undefined") return null;
    const value = JSON.parse(
      sessionStorage.getItem(`${key}_attachment`) || "null",
    );
    return attachmentUrl(value) &&
      typeof value.filename === "string" &&
      typeof value.size_bytes === "number" &&
      typeof value.width === "number" &&
      typeof value.height === "number"
      ? value
      : null;
  } catch {
    return null;
  }
}
export function writeDraftAttachment(
  key: string,
  value: MessageAttachment | null,
) {
  try {
    if (value)
      sessionStorage.setItem(`${key}_attachment`, JSON.stringify(value));
    else sessionStorage.removeItem(`${key}_attachment`);
  } catch {}
}
export function readOutbox(key: string): PendingMessage[] {
  try {
    const value =
      typeof window === "undefined"
        ? []
        : JSON.parse(sessionStorage.getItem(`${key}_outbox`) || "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item) =>
          item &&
          typeof item.client_id === "string" &&
          /^[a-f0-9-]{36}$/i.test(item.client_id) &&
          typeof item.text === "string" &&
          item.text.length <= 4000,
      )
      .map((item) => ({
        ...item,
        status: "failed",
        error:
          "Отправка не подтверждена. Повторите — сообщение не продублируется.",
      }));
  } catch {
    return [];
  }
}
