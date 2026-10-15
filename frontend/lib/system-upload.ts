export const MAX_SYSTEM_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

export function isSystemImport(method: string, path: string[]) {
  return (
    method === "POST" &&
    path.length === 3 &&
    path[0] === "admin" &&
    path[1] === "system" &&
    path[2] === "imports"
  );
}

export function archiveSelectionError(file: { name: string; size: number }) {
  if (!/\.zip$/i.test(file.name))
    return "Выберите ZIP резервной копии или полного проекта QStudy.";
  if (!Number.isSafeInteger(file.size) || file.size < 1)
    return "Выбранный архив пуст или недоступен.";
  if (file.size > MAX_SYSTEM_ARCHIVE_BYTES)
    return "Архив должен занимать не более 2 ГБ.";
  return "";
}

// A slow upload applies backpressure; it never accumulates the entire ZIP in
// the frontend server. The running limit also covers absent/false Content-Length.
export function boundedUploadBody(
  input: ReadableStream<Uint8Array>,
  limit = MAX_SYSTEM_ARCHIVE_BYTES,
) {
  let size = 0;
  let tooLarge = false;
  const body = input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > limit) {
          tooLarge = true;
          throw new Error("QStudy import size limit exceeded");
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return {
    body,
    get tooLarge() {
      return tooLarge;
    },
  };
}
