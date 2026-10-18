"""Bounded, source-preserving import of multiple-choice Word question banks.

This module never evaluates document fields, follows relationships, or asks an AI
to guess an answer key.  ``first`` is an explicit user choice that every first
option is correct; ``marked`` requires a key or a mark present in the document.
"""
from __future__ import annotations

import io
import posixpath
import re
import unicodedata
import zipfile
from dataclasses import dataclass, field
from xml.etree import ElementTree as ET


MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_EXPANDED_BYTES = 48 * 1024 * 1024
MAX_MEMBER_BYTES = 12 * 1024 * 1024
MAX_TEXT_CHARS = 2_000_000
MAX_QUESTIONS = 2000
MAX_OPTIONS = 10
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_LETTERS = "A-JА-ЯЁ"
_OPTION = re.compile(rf"^\s*(?P<mark>[✓✔☑*+]\s*)?(?P<label>[{_LETTERS}])\s*[).:\-]\s*(?P<text>.+)$", re.I)
_INLINE_OPTION = re.compile(rf"(?<!\S)(?:[✓✔☑*+]\s*)?[{_LETTERS}]\s*[).]\s*(?=\S)", re.I)
_QUESTION = re.compile(r"^\s*(?:(?:вопрос|question|сұрақ)\s*(?:№|#)?\s*)?(?P<number>\d{1,5})\s*[).:\-]\s*(?P<text>\S.*)$", re.I)
_NAMED_QUESTION = re.compile(r"^\s*(?:вопрос|question|сұрақ)\s*(?:№|#)?\s*(?P<number>\d{1,5})\s*[:.]?\s+(?P<text>\S.*)$", re.I)
_ANSWER = re.compile(r"^\s*(?:(?:правильн(?:ый|ые)|верн(?:ый|ые))\s+)?(?:ответ(?:ы)?|answer|correct(?:\s+answer)?|дұрыс\s+жауап|жауабы|жауап)\s*[:=\-]\s*(.+)$", re.I)
_EXPLANATION = re.compile(r"^\s*(?:объяснение|пояснение|разъяснение|explanation|rationale|негіздеме|түсіндірме)\s*[:=\-]\s*(.*)$", re.I)
_KEY_HEADER = re.compile(r"^\s*(?:ключ(?:\s+(?:ответов|к\s+тесту))?|ответы(?:\s+к\s+тесту)?|answer\s+key|correct\s+answers|жауаптар(?:\s+кілт[іi])?)\s*:?(.*)$", re.I)
_KEY_PAIR = re.compile(rf"(?<!\d)(\d{{1,5}})\s*[).:=\-–—]\s*([{_LETTERS}]|\d{{1,2}})(?=$|[\s,;|.])", re.I)
_VISUAL = str.maketrans("АВСЕНКМОРТХ", "ABCEHKMOPTX")
_CORRECT_SUFFIX = re.compile(r"\s*(?:[✓✔☑]|\[(?:верно|правильно|correct|правильный\s+ответ)\]|\((?:верно|правильно|correct|правильный\s+ответ)\))\s*$", re.I)


class QTestsImportError(ValueError):
    """A safe, actionable document validation error for the upload interface."""


def _xml(data: bytes) -> ET.Element:
    # XML may be UTF-16/32. Removing NUL bytes here also detects its ASCII DTD
    # syntax before ElementTree can expand an entity in any of these encodings.
    upper = data.replace(b"\x00", b"").upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
        raise QTestsImportError("DOCX содержит запрещённые определения XML. Сохраните его заново как обычный документ Word.")
    try:
        return ET.fromstring(data)
    except (ET.ParseError, ValueError) as error:
        raise QTestsImportError("Повреждён XML внутри DOCX. Откройте файл в Word и сохраните новую копию.") from error


def _read_package(data: bytes) -> dict[str, bytes]:
    if not data:
        raise QTestsImportError("Файл Word пустой.")
    if len(data) > MAX_FILE_BYTES:
        raise QTestsImportError("Размер Word-файла не должен превышать 20 МБ.")
    if not data.startswith(b"PK"):
        raise QTestsImportError("Поддерживается формат DOCX. Старый файл .doc сохраните в Word как .docx.")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 2000 or sum(item.file_size for item in entries) > MAX_EXPANDED_BYTES:
                raise QTestsImportError("Распакованный Word-файл слишком большой. Разделите банк на несколько документов.")
            names: set[str] = set()
            package: dict[str, bytes] = {}
            for item in entries:
                name = item.filename
                if (name in names or "\\" in name or name.startswith("/") or
                        posixpath.normpath(name).startswith("../") or
                        any(part in {"..", "."} for part in name.rstrip("/").split("/")) or
                        ":" in name or "\x00" in name):
                    raise QTestsImportError("DOCX содержит недопустимые пути или повторяющиеся файлы.")
                names.add(name)
                if item.flag_bits & 1:
                    raise QTestsImportError("DOCX защищён паролем. Загрузите незашифрованную копию.")
                if item.file_size > MAX_MEMBER_BYTES or (item.file_size > 1024 * 1024 and item.file_size > max(1, item.compress_size) * 1000):
                    raise QTestsImportError("Слишком большой или чрезмерно сжатый файл внутри DOCX.")
                if ("vbaproject" in name.casefold() or name.casefold().startswith("word/embeddings/") or
                        name.casefold().endswith((".exe", ".dll", ".js", ".vbs"))):
                    raise QTestsImportError("Макросы и вложенные исполняемые файлы в банке тестов не поддерживаются.")
                if name.endswith((".xml", ".rels")) or name == "[Content_Types].xml":
                    payload = archive.read(item)
                    root = _xml(payload)
                    if name.endswith(".rels"):
                        for relationship in root:
                            # A plain hyperlink is just visible source text: we
                            # never follow it or make a network request. Linked
                            # templates, OLE objects and other external content
                            # are rejected rather than loaded by an Office app.
                            external = relationship.attrib.get("TargetMode", "").casefold() == "external"
                            hyperlink = relationship.attrib.get("Type", "").endswith("/hyperlink")
                            if external and not hyperlink:
                                raise QTestsImportError("В DOCX есть внешние связи. Удалите связанные объекты и внешние ссылки, затем сохраните копию.")
                    if name == "[Content_Types].xml" and any(
                            "macroenabled" in node.attrib.get("ContentType", "").casefold()
                            for node in root):
                        raise QTestsImportError("Документы Word с макросами не поддерживаются. Используйте обычный DOCX.")
                    package[name] = payload
            if "word/document.xml" not in package or "[Content_Types].xml" not in package:
                raise QTestsImportError("Файл не является полноценным документом Word DOCX.")
            return package
    except QTestsImportError:
        raise
    except (zipfile.BadZipFile, OSError, RuntimeError, NotImplementedError, EOFError) as error:
        raise QTestsImportError("Не удалось прочитать DOCX. Проверьте, что файл не повреждён и не защищён паролем.") from error


def _plain_paragraph(element: ET.Element) -> str:
    parts: list[str] = []
    for node in element.iter():
        if node.tag == W + "t":
            parts.append(node.text or "")
        elif node.tag == W + "tab":
            parts.append("\t")
        elif node.tag in {W + "br", W + "cr"}:
            parts.append("\n")
    return "".join(parts).replace("\x00", "").replace("\u00a0", " ").strip()


class _Numbering:
    def __init__(self, package: dict[str, bytes]):
        self.formats: dict[tuple[str, str], tuple[str, int]] = {}
        self.counters: dict[tuple[str, str], int] = {}
        if "word/numbering.xml" not in package:
            return
        root = _xml(package["word/numbering.xml"])
        abstracts: dict[str, dict[str, tuple[str, int]]] = {}
        for abstract in root.findall(W + "abstractNum"):
            levels = {}
            for level in abstract.findall(W + "lvl"):
                number_format, start = level.find(W + "numFmt"), level.find(W + "start")
                try:
                    start_value = int(start.attrib.get(W + "val", "1")) if start is not None else 1
                except ValueError:
                    start_value = 1
                levels[level.attrib.get(W + "ilvl", "0")] = (
                    number_format.attrib.get(W + "val", "decimal") if number_format is not None else "decimal",
                    max(1, min(start_value, 100000)),
                )
            abstracts[abstract.attrib.get(W + "abstractNumId", "")] = levels
        for number in root.findall(W + "num"):
            abstract_id = number.find(W + "abstractNumId")
            if abstract_id is None:
                continue
            number_id = number.attrib.get(W + "numId", "")
            for level, format_start in abstracts.get(abstract_id.attrib.get(W + "val", ""), {}).items():
                self.formats[number_id, level] = format_start
            for override in number.findall(W + "lvlOverride"):
                start = override.find(W + "startOverride")
                key = number_id, override.attrib.get(W + "ilvl", "0")
                if start is not None and key in self.formats:
                    try:
                        self.formats[key] = (self.formats[key][0], max(1, min(int(start.attrib.get(W + "val", "1")), 100000)))
                    except ValueError:
                        pass

    def paragraph(self, element: ET.Element) -> str:
        text = _plain_paragraph(element)
        properties = element.find(W + "pPr")
        number = properties.find(W + "numPr") if properties is not None else None
        if not text or number is None:
            return text
        number_id, level = number.find(W + "numId"), number.find(W + "ilvl")
        if number_id is None:
            return text
        key = number_id.attrib.get(W + "val", ""), level.attrib.get(W + "val", "0") if level is not None else "0"
        number_format, start = self.formats.get(key, ("bullet", 1))
        value = self.counters.get(key, start - 1) + 1
        self.counters[key] = value
        if _QUESTION.match(text) or _OPTION.match(text):
            return text
        if number_format == "decimal":
            return f"{value}. {text}"
        if number_format in {"upperLetter", "lowerLetter"} and value <= 26:
            return f"{chr(64 + value)}) {text}"
        if number_format in {"russianUpper", "russianLower"} and value <= 33:
            alphabet = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ"
            return f"{alphabet[value - 1]}) {text}"
        return text


def _table_lines(table: ET.Element, numbering: _Numbering) -> list[str]:
    rows: list[list[list[str]]] = []
    for row in table.findall(W + "tr"):
        cells: list[list[str]] = []
        for cell in row.findall(W + "tc"):
            content: list[str] = []
            for child in cell:
                if child.tag == W + "p":
                    text = numbering.paragraph(child)
                    if text:
                        content.extend(text.splitlines())
                elif child.tag == W + "tbl":
                    content.extend(_table_lines(child, numbering))
            cells.append(content)
        rows.append(cells)
    if not rows:
        return []
    first = [" ".join(cell).strip() for cell in rows[0]]
    option_columns = [(index, value.upper()) for index, value in enumerate(first)
                      if re.fullmatch(rf"[{_LETTERS}][).:]?", value, re.I)]
    option_columns = [(index, value.rstrip(").:")) for index, value in option_columns]
    question_column = next((index for index, value in enumerate(first)
                            if re.search(r"^(?:вопрос|question|сұрақ|текст\s+вопроса)$", value, re.I)), None)
    answer_column = next((index for index, value in enumerate(first)
                          if re.search(r"^(?:(?:правильный|верный)\s+)?(?:ответ|answer|дұрыс\s+жауап)$", value, re.I)), None)
    explanation_column = next((index for index, value in enumerate(first)
                               if re.search(r"^(?:объяснение|пояснение|explanation)$", value, re.I)), None)
    number_column = next((index for index, value in enumerate(first)
                          if value.casefold() in {"№", "номер", "n", "no", "#"}), None)
    result: list[str] = []
    if question_column is not None and len(option_columns) >= 2:
        for index, row in enumerate(rows[1:], 1):
            values = ["\n".join(cell).strip() for cell in row]
            question = values[question_column] if question_column < len(values) else ""
            number = values[number_column] if number_column is not None and number_column < len(values) else str(index)
            if not question:
                continue
            result.append(question if _QUESTION.match(question) else f"{number.rstrip('.)')}. {question}")
            result.extend(f"{label}) {values[column]}" for column, label in option_columns
                          if column < len(values) and values[column])
            if answer_column is not None and answer_column < len(values) and values[answer_column]:
                result.append(f"Ответ: {values[answer_column]}")
            if explanation_column is not None and explanation_column < len(values) and values[explanation_column]:
                result.append(f"Пояснение: {values[explanation_column]}")
        return result
    for row in rows:
        values = ["\n".join(cell).strip() for cell in row]
        nonempty = [value for value in values if value]
        if len(nonempty) == 2 and re.fullmatch(rf"(?:\d{{1,5}}|[{_LETTERS}])[).:]?", nonempty[0], re.I):
            prefix = nonempty[0].rstrip(").:")
            result.append(f"{prefix}{'.' if prefix.isdigit() else ')'} {nonempty[1]}")
        else:
            for value in nonempty:
                result.extend(value.splitlines())
    return result


def _document_lines(data: bytes) -> list[str]:
    package = _read_package(data)
    root = _xml(package["word/document.xml"])
    body = root.find(W + "body")
    if body is None:
        raise QTestsImportError("В Word-файле не найден основной текст документа.")
    numbering = _Numbering(package)
    lines: list[str] = []
    for child in body:
        if child.tag == W + "p":
            lines.extend(numbering.paragraph(child).splitlines())
        elif child.tag == W + "tbl":
            lines.extend(_table_lines(child, numbering))
    if sum(len(line) + 1 for line in lines) > MAX_TEXT_CHARS:
        raise QTestsImportError("В документе слишком много текста. Разделите банк на несколько Word-файлов.")
    if not any(line.strip() for line in lines):
        raise QTestsImportError("В Word-файле не найден текст. Изображения страниц сначала нужно распознать в текст.")
    return lines


def extract_docx_text(data: bytes) -> str:
    """Return the same bounded text used for import, including table position."""
    return "\n".join(_document_lines(data))


@dataclass
class _Block:
    number: int
    explicit: bool = False
    question: list[str] = field(default_factory=list)
    options: list[tuple[str, str]] = field(default_factory=list)
    marked: list[int] = field(default_factory=list)
    answers: list[str] = field(default_factory=list)
    explanation: list[str] = field(default_factory=list)


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text)).strip()


def _answer_index(answer: str, options: list[tuple[str, str]]) -> int | None:
    candidate = answer.strip().rstrip(".;")
    # Multiple answers are not single-choice questions. Do not silently keep A.
    if re.search(rf"^[{_LETTERS}\d]\s*(?:[,;/]|\s+(?:и|and)\s+)\s*[{_LETTERS}\d]", candidate, re.I):
        return None
    token = re.match(rf"^([{_LETTERS}]|\d{{1,2}})(?:[).:]|\s|$)", candidate, re.I)
    if token:
        label = token.group(1).upper()
        exact = [index for index, (source, _) in enumerate(options) if source.upper() == label]
        if len(exact) == 1:
            return exact[0]
        visual = [index for index, (source, _) in enumerate(options)
                  if source.upper().translate(_VISUAL) == label.translate(_VISUAL)]
        if len(visual) == 1:
            return visual[0]
        if label.isdigit() and 1 <= int(label) <= len(options):
            return int(label) - 1
    matching = [index for index, (_, text) in enumerate(options) if _clean(text).casefold() == _clean(candidate).casefold()]
    return matching[0] if len(matching) == 1 else None


def _split_inline(line: str) -> list[str]:
    # A line may contain a complete question and all its options. Require two
    # labels, so an isolated mathematical expression "A)" is not a separator.
    if _ANSWER.match(line) or _EXPLANATION.match(line):
        return [line]
    matches = list(_INLINE_OPTION.finditer(line))
    if len(matches) < 2:
        return [line]
    start = matches[0].start()
    result = [line[:start].strip()] if line[:start].strip() else []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(line)
        result.append(line[match.start():end].strip())
    return result


def _extract_blocks(lines: list[str]) -> tuple[list[_Block], dict[int, str], list[str]]:
    blocks: list[_Block] = []
    current: _Block | None = None
    global_keys: dict[int, str] = {}
    warnings: list[str] = []
    key_section = False
    explanation_mode = False
    for raw_line in lines:
        # Common question-bank export format used by universities.
        tagged = re.sub(r"(?i)<question>\s*", "\n<question> ", raw_line)
        tagged = re.sub(r"(?i)<(variant|variantright|rightvariant)>\s*", r"\n<\1> ", tagged)
        for tagged_line in tagged.splitlines():
            for line in _split_inline(tagged_line.strip()):
                line = line.strip()
                if not line:
                    continue
                key_header = _KEY_HEADER.match(line)
                if key_header and (not key_header.group(1).strip() or _KEY_PAIR.search(key_header.group(1))):
                    key_section = True
                    line = key_header.group(1).strip()
                    if not line:
                        continue
                if key_section:
                    pairs = _KEY_PAIR.findall(line)
                    for number, answer in pairs:
                        number_value = int(number)
                        if number_value in global_keys and global_keys[number_value].upper() != answer.upper():
                            global_keys[number_value] = "[противоречивый ключ]"
                        else:
                            global_keys[number_value] = answer
                    if not pairs:
                        warnings.append("В разделе ключа пропущена строка, которую нельзя однозначно прочитать.")
                    continue
                tagged_question = re.match(r"^<question>\s*(.*)$", line, re.I)
                question = _QUESTION.match(line) or _NAMED_QUESTION.match(line)
                if tagged_question or question:
                    if current is not None and (current.options or current.explicit):
                        blocks.append(current)
                    number = int(question.group("number")) if question else len(blocks) + 1
                    current = _Block(number=number, explicit=True, question=[question.group("text") if question else tagged_question.group(1)])
                    explanation_mode = False
                    if len(blocks) >= MAX_QUESTIONS:
                        raise QTestsImportError("В одном банке поддерживается не более 2000 вопросов. Разделите документ.")
                    continue
                if current is None:
                    current = _Block(number=len(blocks) + 1, question=[])
                answer = _ANSWER.match(line)
                explanation = _EXPLANATION.match(line)
                tagged_option = re.match(r"^<(variant|variantright|rightvariant)>\s*(.*)$", line, re.I)
                option = _OPTION.match(line)
                if answer:
                    current.answers.append(answer.group(1).strip())
                    explanation_mode = False
                elif explanation:
                    current.explanation.append(explanation.group(1).strip())
                    explanation_mode = True
                elif option or tagged_option:
                    text = option.group("text") if option else tagged_option.group(2)
                    label = option.group("label").upper() if option else chr(65 + len(current.options))
                    correct = bool(option and option.group("mark")) or bool(tagged_option and tagged_option.group(1).casefold() != "variant")
                    if _CORRECT_SUFFIX.search(text):
                        correct = True
                        text = _CORRECT_SUFFIX.sub("", text)
                    if re.match(r"^\s*[✓✔☑*+]\s+", text):
                        correct = True
                        text = re.sub(r"^\s*[✓✔☑*+]\s+", "", text)
                    if correct:
                        current.marked.append(len(current.options))
                    current.options.append((label, text.strip()))
                    explanation_mode = False
                elif explanation_mode:
                    current.explanation.append(line)
                elif current.options and (line.endswith("?") or line.casefold().startswith(("what ", "which ", "кто ", "что ", "какой ", "какая ", "какие "))):
                    blocks.append(current)
                    if len(blocks) >= MAX_QUESTIONS:
                        raise QTestsImportError("В одном банке поддерживается не более 2000 вопросов. Разделите документ.")
                    current = _Block(number=len(blocks) + 1, question=[line])
                elif current.options:
                    label, text = current.options[-1]
                    current.options[-1] = label, text + "\n" + line
                else:
                    current.question.append(line)
    if current is not None:
        blocks.append(current)
    # A title or preamble before a numbered bank is not a rejected question.
    return [block for block in blocks if block.options or block.explicit or len(blocks) == 1], global_keys, warnings


def extract_docx_questions(data: bytes, answer_mode: str = "marked") -> dict:
    """Import all valid source questions without guessing missing answer keys.

    ``source_text`` is returned for an optional *separate* AI-assisted review;
    callers should never send it to a public bank endpoint. Every omission is
    counted and described. An over-limit bank raises instead of truncating.
    """
    if answer_mode not in {"first", "marked"}:
        raise QTestsImportError("Выберите режим ответов: первый вариант или ответы, отмеченные в документе.")
    lines = _document_lines(data)
    blocks, global_keys, warnings = _extract_blocks(lines)
    if len(blocks) > MAX_QUESTIONS:
        raise QTestsImportError("В одном банке поддерживается не более 2000 вопросов. Разделите документ.")
    results: list[dict] = []
    rejected = 0
    blocked_questions: set[str] = set()
    seen: dict[tuple, int | None] = {}
    for block in blocks:
        question = "\n".join(block.question).strip()
        options = [(label, text.strip()) for label, text in block.options]
        reason = ""
        if not question:
            reason = "отсутствует текст вопроса"
        elif len(question) > 6000:
            reason = "текст вопроса превышает 6000 символов"
        elif not 2 <= len(options) <= MAX_OPTIONS:
            reason = "нужно от 2 до 10 вариантов ответа"
        elif any(not text or len(text) > 2000 for _, text in options):
            reason = "вариант ответа пустой или превышает 2000 символов"
        elif len({_clean(text).casefold() for _, text in options}) != len(options):
            reason = "повторяются одинаковые варианты ответа"
        elif len({label for label, _ in options}) != len(options):
            reason = "повторяются буквы вариантов ответа"
        elif len("\n".join(block.explanation)) > 10000:
            reason = "пояснение превышает 10 000 символов"
        candidate_keys = list(block.answers)
        if block.number in global_keys:
            candidate_keys.append(global_keys[block.number])
        keyed_indices = [_answer_index(value, options) for value in candidate_keys]
        marked = set(block.marked)
        indices = marked | {index for index in keyed_indices if index is not None}
        correct_index: int | None = None
        if not reason:
            if any(index is None for index in keyed_indices) or len(indices) > 1:
                reason = "неоднозначный или противоречивый ключ ответа"
            elif answer_mode == "first":
                if indices and indices != {0}:
                    reason = "ключ в документе противоречит выбранному режиму «первый вариант»"
                else:
                    correct_index = 0
            elif len(indices) == 1:
                correct_index = next(iter(indices))
            else:
                reason = "не отмечен правильный ответ; выберите режим «первый вариант», только если это правило банка"
        if reason:
            rejected += 1
            warnings.append(f"Вопрос {block.number} пропущен: {reason}.")
            # A later AI layout pass may recover unsupported formatting, but
            # must never reintroduce a source conflict or bypass these limits.
            recoverable = reason.startswith("не отмечен правильный ответ") or (
                reason == "нужно от 2 до 10 вариантов ответа" and len(options) < 2)
            if question and not recoverable:
                blocked_questions.add(question)
            continue
        fingerprint = (_clean(question).casefold(), tuple(_clean(text).casefold() for _, text in options))
        if fingerprint in seen:
            blocked_questions.add(question)
            previous = seen[fingerprint]
            if previous is not None and results[previous]["correct_index"] != correct_index:
                results[previous]["_conflicting"] = True
                seen[fingerprint] = None
                warnings.append(f"Повтор вопроса {block.number} содержит противоречивый ответ; обе версии исключены.")
            else:
                warnings.append(f"Повтор вопроса {block.number} исключён из банка.")
            rejected += 1
            continue
        seen[fingerprint] = len(results)
        results.append({
            "source_number": block.number,
            "question": question,
            "options": [text for _, text in options],
            "correct_index": correct_index,
            "explanation": "\n".join(block.explanation).strip(),
        })
    conflicting = sum(bool(item.get("_conflicting")) for item in results)
    results = [item for item in results if not item.get("_conflicting")]
    rejected += conflicting
    if answer_mode == "first" and results:
        warnings.insert(0, "Использовано выбранное вами правило: в исходном документе правильный ответ — первый вариант. В тестах варианты будут перемешаны.")
    if not results and not warnings:
        warnings.append("Вопросы не распознаны. Используйте нумерацию вопросов и варианты A), B), C), D), либо проверьте документ с помощью ИИ.")
    return {"questions": results, "warnings": warnings, "rejected": rejected,
            "source_text": "\n".join(lines), "blocked_questions": sorted(blocked_questions)}
