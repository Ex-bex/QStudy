import assert from "node:assert/strict";
import test from "node:test";
import {
  QTESTS_MAX_FILE_BYTES,
  qtestsDocumentError,
  qtestsDocumentTitle,
} from "./qtests-upload.ts";

test("Word selection explains an absent, legacy, empty or oversized file", () => {
  assert.match(qtestsDocumentError(null), /Сначала выберите/);
  assert.match(
    qtestsDocumentError({ name: "Вопросы.doc", size: 100 }),
    /Сохранить как/,
  );
  assert.match(
    qtestsDocumentError({ name: "Вопросы.doc", size: 100 }),
    /переименование/,
  );
  assert.match(
    qtestsDocumentError({ name: "Вопросы.docx", size: 0 }),
    /Файл пуст/,
  );
  assert.match(
    qtestsDocumentError({
      name: "Вопросы.docx",
      size: QTESTS_MAX_FILE_BYTES + 1,
    }),
    /10 МБ/,
  );
  assert.equal(
    qtestsDocumentError({ name: "Вопросы.DOCX", size: QTESTS_MAX_FILE_BYTES }),
    "",
  );
});

test("a long Word filename cannot produce an invalid automatic bank title", () => {
  const title = qtestsDocumentTitle(`${"🧪".repeat(210)}.DOCX`);
  assert.equal(Array.from(title).length, 180);
  assert.equal(title, "🧪".repeat(180));
  assert.equal(
    qtestsDocumentTitle(" История Казахстана.docx"),
    "История Казахстана",
  );
});
