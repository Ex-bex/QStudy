export const QTESTS_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const QTESTS_TITLE_LIMIT = 180;

export function qtestsDocumentError(
  file: Pick<File, "name" | "size"> | null,
): string {
  if (!file)
    return "Сначала выберите Word .docx с вопросами, затем нажмите «Загрузить Word».";
  if (!/\.docx$/i.test(file.name)) {
    return "Нужен Word .docx. Старый .doc откройте в Word и выберите «Сохранить как → Документ Word (.docx)». Простое переименование файла не подходит.";
  }
  if (!file.size) return "Файл пуст. Выберите документ с вопросами.";
  if (file.size > QTESTS_MAX_FILE_BYTES) {
    return "Документ слишком большой. Максимальный размер — 10 МБ.";
  }
  return "";
}

export function qtestsDocumentTitle(filename: string): string {
  return Array.from(filename.replace(/\.docx$/i, "").trim())
    .slice(0, QTESTS_TITLE_LIMIT)
    .join("");
}
