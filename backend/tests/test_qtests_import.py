"""Word import keeps real source questions and never guesses an absent key."""
import io
import unittest
import warnings
import zipfile
from xml.etree import ElementTree as ET

from app.services.qtests_import import (
    MAX_MEMBER_BYTES, MAX_QUESTIONS, QTestsImportError,
    extract_docx_questions, extract_docx_text,
)


W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
TYPES = b'''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>'''


def paragraph(text, *, num_id=None):
    element = ET.Element(W + "p")
    if num_id is not None:
        properties = ET.SubElement(element, W + "pPr")
        numbering = ET.SubElement(properties, W + "numPr")
        ET.SubElement(numbering, W + "ilvl", {W + "val": "0"})
        ET.SubElement(numbering, W + "numId", {W + "val": str(num_id)})
    run = ET.SubElement(element, W + "r")
    ET.SubElement(run, W + "t").text = text
    return element


def table(rows):
    element = ET.Element(W + "tbl")
    for values in rows:
        row = ET.SubElement(element, W + "tr")
        for value in values:
            cell = ET.SubElement(row, W + "tc")
            cell.append(paragraph(value))
    return element


def word(lines=(), *, elements=None, extra=None, document=None):
    if document is None:
        root = ET.Element(W + "document")
        body = ET.SubElement(root, W + "body")
        for element in (elements if elements is not None else [paragraph(line) for line in lines]):
            body.append(element)
        document = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", TYPES)
        archive.writestr("word/document.xml", document)
        for name, payload in (extra or {}).items():
            archive.writestr(name, payload)
    return output.getvalue()


def sample(number=1, *, answer=None):
    lines = [f"{number}. Вопрос {number}?", "A) Верный вариант", "B) Неверный вариант", "C) Ещё один вариант", "D) Другой вариант"]
    if answer:
        lines.append(f"Ответ: {answer}")
    return lines


class QTestsWordImportTests(unittest.TestCase):
    def test_three_hundred_questions_are_imported_without_truncation(self):
        lines = ["Учебный банк: 300 вопросов"]
        for number in range(1, 301):
            lines.extend(sample(number))
        result = extract_docx_questions(word(lines), "first")
        self.assertEqual(len(result["questions"]), 300)
        self.assertEqual(result["rejected"], 0)
        self.assertEqual(result["questions"][-1]["source_number"], 300)
        self.assertTrue(all(item["correct_index"] == 0 for item in result["questions"]))
        self.assertIn("300. Вопрос 300?", result["source_text"])
        self.assertTrue(result["warnings"])

    def test_marked_mode_never_assumes_first_option(self):
        result = extract_docx_questions(word(sample()), "marked")
        self.assertEqual(result["questions"], [])
        self.assertEqual(result["rejected"], 1)
        self.assertIn("не отмечен", " ".join(result["warnings"]))

    def test_default_mode_requires_an_explicit_key(self):
        self.assertFalse(extract_docx_questions(word(sample()))["questions"])

    def test_latin_key_and_source_explanation(self):
        result = extract_docx_questions(word(sample(answer="C") + ["Пояснение: Причина из документа.", "Продолжение пояснения."]))
        question = result["questions"][0]
        self.assertEqual(question["correct_index"], 2)
        self.assertEqual(question["explanation"], "Причина из документа.\nПродолжение пояснения.")

    def test_cyrillic_alphabet_key_is_not_confused_with_visual_latin(self):
        result = extract_docx_questions(word(["1. Выберите вариант?", "А) Один", "Б) Два", "В) Три", "Г) Четыре", "Правильный ответ: В"]))
        self.assertEqual(result["questions"][0]["correct_index"], 2)

    def test_cyrillic_lookalike_in_key_matches_latin_option(self):
        result = extract_docx_questions(word(sample(answer="В")))
        self.assertEqual(result["questions"][0]["correct_index"], 1)

    def test_numeric_key_refers_to_source_position(self):
        result = extract_docx_questions(word(sample(answer="3")))
        self.assertEqual(result["questions"][0]["correct_index"], 2)

    def test_key_can_use_the_full_answer_text(self):
        result = extract_docx_questions(word(sample(answer="Ещё один вариант")))
        self.assertEqual(result["questions"][0]["correct_index"], 2)

    def test_marked_option_prefix_and_suffix(self):
        for marker in ("✓ B) Неверный вариант", "B) Неверный вариант ✓", "B) Неверный вариант [correct]", "B) + Неверный вариант"):
            with self.subTest(marker=marker):
                lines = sample()
                lines[2] = marker
                result = extract_docx_questions(word(lines))
                self.assertEqual(result["questions"][0]["correct_index"], 1)
                self.assertEqual(result["questions"][0]["options"][1], "Неверный вариант")

    def test_conflicting_marked_key_does_not_override_source(self):
        result = extract_docx_questions(word(sample(answer="B")), "first")
        self.assertEqual(result["rejected"], 1)
        self.assertFalse(result["questions"])
        self.assertIn("противоречит", " ".join(result["warnings"]))

    def test_conflicting_explicit_keys_and_multiple_answers_are_rejected(self):
        for key in ("A, C", "A; C", "A и C", "A and C"):
            with self.subTest(key=key):
                result = extract_docx_questions(word(sample(answer=key)))
                self.assertFalse(result["questions"])
                self.assertEqual(result["rejected"], 1)
        result = extract_docx_questions(word(sample(answer="A") + ["Ответ: B"]))
        self.assertFalse(result["questions"])

    def test_unsafe_rejections_are_blocked_from_later_ai_layout_recovery(self):
        for lines in (sample(answer="A, C"), sample(answer="B"),
                      ["1. Дублируются варианты?", "A) Да", "B) Да"]):
            with self.subTest(lines=lines):
                result = extract_docx_questions(word(lines), "first")
                self.assertTrue(result["blocked_questions"])
        missing_key = extract_docx_questions(word(sample()), "marked")
        self.assertFalse(missing_key["blocked_questions"])

    def test_global_answer_key_can_include_multiple_pairs_per_line(self):
        lines = sample(1) + sample(2) + sample(3) + ["Ключ ответов:", "1-A; 2-C; 3-D"]
        result = extract_docx_questions(word(lines))
        self.assertEqual([item["correct_index"] for item in result["questions"]], [0, 2, 3])

    def test_conflicting_global_answer_key_is_rejected(self):
        result = extract_docx_questions(word(sample() + ["Ответы:", "1-A", "1-B"]))
        self.assertFalse(result["questions"])

    def test_inline_choices_and_named_question(self):
        result = extract_docx_questions(word(["Вопрос №1: Какая столица? A) Астана B) Алматы C) Семей D) Актау", "Ответ: A"]))
        question = result["questions"][0]
        self.assertEqual(question["question"], "Какая столица?")
        self.assertEqual(question["options"], ["Астана", "Алматы", "Семей", "Актау"])

    def test_tagged_university_export_with_marked_variant(self):
        result = extract_docx_questions(word(["<question> На какой планете? <variant> Земля <variantright> Марс <variant> Венера"]))
        question = result["questions"][0]
        self.assertEqual(question["options"], ["Земля", "Марс", "Венера"])
        self.assertEqual(question["correct_index"], 1)

    def test_table_with_question_and_answer_columns(self):
        result = extract_docx_questions(word(elements=[table([
            ["№", "Вопрос", "A", "B", "C", "Ответ", "Пояснение"],
            ["1", "Какая столица?", "Астана", "Алматы", "Семей", "A", "Астана — столица."],
            ["2", "Какой язык?", "Python", "Java", "Rust", "C", "В исходном ключе указан Rust."],
        ])]))
        self.assertEqual(len(result["questions"]), 2)
        self.assertEqual(result["questions"][1]["correct_index"], 2)
        self.assertEqual(result["questions"][0]["explanation"], "Астана — столица.")

    def test_document_order_interleaves_paragraphs_and_tables(self):
        before = [paragraph(line) for line in sample(1, answer="A")]
        between = table([["2", "Вопрос внутри таблицы?"], ["A", "Первый"], ["B", "Второй"], ["Ответ: B", ""]])
        after = [paragraph(line) for line in sample(3, answer="C")]
        result = extract_docx_questions(word(elements=before + [between] + after))
        self.assertEqual([item["source_number"] for item in result["questions"]], [1, 2, 3])
        self.assertEqual([item["correct_index"] for item in result["questions"]], [0, 1, 2])
        self.assertLess(result["source_text"].index("1. Вопрос"), result["source_text"].index("2. Вопрос"))
        self.assertLess(result["source_text"].index("2. Вопрос"), result["source_text"].index("3. Вопрос"))

    def test_word_automatic_numbering_is_read_even_without_visible_prefix_text(self):
        numbering = f'''<w:numbering xmlns:w="{W[1:-1]}">
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperLetter"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>
</w:numbering>'''.encode()
        elements = [paragraph("Вопрос со списком?", num_id=1), paragraph("Да", num_id=2), paragraph("Нет", num_id=2), paragraph("Ответ: B")]
        result = extract_docx_questions(word(elements=elements, extra={"word/numbering.xml": numbering}))
        self.assertEqual(result["questions"][0]["source_number"], 1)
        self.assertEqual(result["questions"][0]["options"], ["Да", "Нет"])
        self.assertEqual(result["questions"][0]["correct_index"], 1)

    def test_missing_option_question_is_rejected_and_counted(self):
        result = extract_docx_questions(word(["1. Нет вариантов?", *sample(2, answer="A")]))
        self.assertEqual(len(result["questions"]), 1)
        self.assertEqual(result["rejected"], 1)
        self.assertIn("Вопрос 1", " ".join(result["warnings"]))

    def test_duplicate_source_questions_do_not_inflate_question_bank(self):
        result = extract_docx_questions(word(sample(answer="A") + sample(answer="A")))
        self.assertEqual(len(result["questions"]), 1)
        self.assertEqual(result["rejected"], 1)

    def test_duplicate_source_questions_with_conflicting_keys_are_both_rejected(self):
        result = extract_docx_questions(word(sample(answer="A") + sample(answer="B")))
        self.assertFalse(result["questions"])
        self.assertEqual(result["rejected"], 2)

    def test_repeated_identical_options_are_rejected(self):
        result = extract_docx_questions(word(["1. Вопрос?", "A) Да", "B) Да", "Ответ: A"]))
        self.assertFalse(result["questions"])

    def test_multiline_question_and_option_are_preserved(self):
        result = extract_docx_questions(word(["1. Прочитайте условие:", "Продолжение условия.", "A) Первый", "продолжение первого варианта", "B) Второй", "Ответ: A"]))
        self.assertEqual(result["questions"][0]["question"], "Прочитайте условие:\nПродолжение условия.")
        self.assertEqual(result["questions"][0]["options"][0], "Первый\nпродолжение первого варианта")

    def test_unnumbered_questions_ending_in_question_mark(self):
        result = extract_docx_questions(word(["Где учиться?", "A) Здесь", "B) Там", "Ответ: A", "Что изучать?", "A) Математику", "B) Биологию", "Ответ: B"]))
        self.assertEqual(len(result["questions"]), 2)

    def test_exact_question_limit_is_accepted_but_overflow_is_not_truncated(self):
        lines = ["Заголовок банка"]
        for number in range(1, MAX_QUESTIONS + 1):
            lines.extend([f"{number}. Вопрос {number}?", "A) Да", "B) Нет"])
        self.assertEqual(len(extract_docx_questions(word(lines), "first")["questions"]), MAX_QUESTIONS)
        with self.assertRaisesRegex(QTestsImportError, "2000"):
            extract_docx_questions(word(lines + ["2001. Лишний?", "A) Да", "B) Нет"]), "first")

    def test_too_long_content_is_reported_not_silently_truncated(self):
        result = extract_docx_questions(word(["1. " + "В" * 6001, "A) Да", "B) Нет"]), "first")
        self.assertEqual(result["rejected"], 1)
        self.assertFalse(result["questions"])

    def test_invalid_answer_mode_is_rejected(self):
        with self.assertRaises(QTestsImportError):
            extract_docx_questions(word(sample()), "guess")

    def test_raw_text_export_uses_the_same_validation(self):
        self.assertIn("Вопрос 1?", extract_docx_text(word(sample())))
        with self.assertRaises(QTestsImportError):
            extract_docx_text(b"not a word file")

    def test_empty_legacy_or_corrupt_files_fail_with_a_safe_message(self):
        for content in (b"", b"DOC-legacy-format", b"PKbroken"):
            with self.subTest(content=content), self.assertRaises(QTestsImportError):
                extract_docx_questions(content)
        with self.assertRaisesRegex(QTestsImportError, "не найден текст"):
            extract_docx_questions(word())

    def test_archive_paths_duplicates_and_macros_are_rejected(self):
        for name in ("../escape.xml", "/escape.xml", "word\\escape.xml", "word/vbaProject.bin", "word/script.js", "C:/escape.xml"):
            with self.subTest(name=name), self.assertRaises(QTestsImportError):
                extract_docx_questions(word(sample(), extra={name: b"content"}), "first")
        output = io.BytesIO(word(sample()))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(output, "a") as archive:
                archive.writestr("word/document.xml", "<duplicate/>")
        with self.assertRaisesRegex(QTestsImportError, "повторяющиеся"):
            extract_docx_questions(output.getvalue(), "first")

    def test_external_relationships_and_macro_content_types_are_rejected(self):
        relationships = b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="x" Type="link" TargetMode="External" Target="https://example.com/linked.docx"/></Relationships>'
        with self.assertRaisesRegex(QTestsImportError, "внешние связи"):
            extract_docx_questions(word(sample(), extra={"word/_rels/document.xml.rels": relationships}), "first")
        output = io.BytesIO(word(sample()))
        with zipfile.ZipFile(io.BytesIO(output.getvalue())) as source:
            contents = {item.filename: source.read(item) for item in source.infolist()}
        contents["[Content_Types].xml"] = TYPES.replace(b"wordprocessingml.document.main+xml", b"ms-word.document.macroEnabled.main+xml")
        target = io.BytesIO()
        with zipfile.ZipFile(target, "w") as archive:
            for name, data in contents.items():
                archive.writestr(name, data)
        with self.assertRaisesRegex(QTestsImportError, "макросами"):
            extract_docx_questions(target.getvalue(), "first")

    def test_ordinary_hyperlinks_and_printer_settings_are_not_executed_or_rejected(self):
        relationships = b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="x" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" TargetMode="External" Target="https://example.com/reference"/></Relationships>'
        result = extract_docx_questions(word(sample(), extra={"word/_rels/document.xml.rels": relationships,
                                                             "word/printerSettings/printerSettings1.bin": b"ordinary printer metadata"}), "first")
        self.assertEqual(len(result["questions"]), 1)

    def test_xml_entities_are_rejected_in_utf8_and_utf16_before_parsing(self):
        xml = f'''<?xml version="1.0"?><!DOCTYPE x [<!ENTITY secret "injected">]><w:document xmlns:w="{W[1:-1]}"><w:body><w:p><w:r><w:t>&secret;</w:t></w:r></w:p></w:body></w:document>'''
        for encoding in ("utf-8", "utf-16", "utf-32"):
            with self.subTest(encoding=encoding), self.assertRaisesRegex(QTestsImportError, "XML"):
                extract_docx_questions(word(document=xml.encode(encoding)))

    def test_expanded_member_limit_prevents_zip_bombs(self):
        with self.assertRaisesRegex(QTestsImportError, "сжатый"):
            extract_docx_questions(word(sample(), extra={"word/giant.xml": b" " * (MAX_MEMBER_BYTES + 1)}), "first")

    def test_corrupt_xml_cannot_be_silently_ignored(self):
        with self.assertRaisesRegex(QTestsImportError, "Повреждён"):
            extract_docx_questions(word(document=b"<broken>"))


if __name__ == "__main__":
    unittest.main()
