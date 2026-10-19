import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachmentUrl,
  conversationId,
  draftKey,
  mergeMessages,
  messageClientId,
  messagePreview,
  stickerUrl,
} from "./qmessage.ts";

test("QMessage accepts only exact local private-image and known sticker addresses", () => {
  assert.equal(
    attachmentUrl({ id: 12, url: "/api/qmessage/attachments/12" }),
    "/api/qmessage/attachments/12",
  );
  for (const url of [
    "https://outside.example/a.png",
    "javascript:alert(1)",
    "/api/qmessage/attachments/13",
    "/api/qmessage/attachments/12?x=1",
    "/api/admin/qmessage/reports/1/attachment",
  ])
    assert.equal(attachmentUrl({ id: 12, url }), null);
  for (const id of [0, -1, 1.5, "12", Number.MAX_SAFE_INTEGER + 1])
    assert.equal(
      attachmentUrl({ id, url: `/api/qmessage/attachments/${id}` }),
      null,
    );
  assert.equal(
    stickerUrl({
      id: "wave",
      builtin: true,
      image_url: "/qmessage-stickers/wave.svg",
    }),
    "/qmessage-stickers/wave.svg",
  );
  assert.equal(
    stickerUrl({
      id: "my-sticker",
      image_url: "/api/qmessage/stickers/my-sticker/image",
    }),
    "/api/qmessage/stickers/my-sticker/image",
  );
  for (const value of [
    { id: "wave", builtin: false, image_url: "/qmessage-stickers/wave.svg" },
    {
      id: "unknown",
      builtin: true,
      image_url: "/qmessage-stickers/unknown.svg",
    },
    {
      id: "wave",
      builtin: true,
      image_url: "https://outside.example/wave.svg",
    },
    { id: "wave", image_url: "/api/qmessage/stickers/heart/image" },
    { id: "../wave", image_url: "/api/qmessage/stickers/../wave/image" },
    { id: "wave", image_url: "/api/qmessage/stickers/wave/image?other=1" },
  ])
    assert.equal(stickerUrl(value), null);
});

test("QMessage restores exact conversation IDs and scopes drafts to both account and conversation", () => {
  assert.equal(conversationId("12"), 12);
  for (const value of [
    null,
    "",
    "0",
    "01",
    "-1",
    "1.2",
    "1e3",
    "1/../../admin",
    "9007199254740992",
  ])
    assert.equal(conversationId(value), null);
  assert.notEqual(draftKey(1, 12), draftKey(2, 12));
  assert.notEqual(draftKey(1, 12), draftKey(1, 13));
  const identifiers = Array.from({ length: 100 }, messageClientId);
  assert.equal(new Set(identifiers).size, 100);
  assert.ok(
    identifiers.every((value) =>
      /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(
        value,
      ),
    ),
  );
});

test("Authoritative edits and deletions replace earlier message pages without duplicate bubbles", () => {
  const earlier = [
    { id: 4, text: "removed original" },
    { id: 2, text: "older" },
  ];
  const incoming = [
    { id: 4, text: "", deleted: true },
    { id: 8, text: "latest" },
  ];
  const merged = mergeMessages(earlier, incoming);
  assert.deepEqual(
    merged.map((row) => row.id),
    [2, 4, 8],
  );
  assert.equal(merged[1].text, "");
  assert.equal(messagePreview(merged[1]), "Сообщение удалено");
  assert.equal(earlier[0].text, "removed original");
});
