"use client";

import { useResource } from "@/components/academic";
import type { TimetableSource } from "@/types/academic";

export function TimetableSourceInfo({
  warnings = [],
}: {
  warnings?: string[];
}) {
  const { data: source, error } = useResource<TimetableSource>(
    "/academic/timetable-source",
  );
  return (
    <details className="panel academic-timetable-source">
      <summary>Источник расписания и уточнения</summary>
      <p className="muted">
        Время указано по Казахстану (UTC+5). Несколько времён через «/» —
        отдельные начала занятий. Окончание показывается только тогда, когда оно
        известно. Даты начала и окончания учебного периода в справочнике не
        заданы.
      </p>
      {source?.imported && (
        <p>
          <strong>{source.title}</strong>
          <br />
          {source.source_file} · Обновление источника: {source.updated_at}
          <br />
          {source.university} · {source.school}
          <br />
          {source.academic_year}
        </p>
      )}
      {error && (
        <p className="muted">
          Не удалось загрузить сведения об источнике: {error}
        </p>
      )}
      {!!(warnings.length || source?.warnings.length) && (
        <ul>
          {[...new Set([...warnings, ...(source?.warnings || [])])].map(
            (warning, i) => (
              <li key={i}>{warning}</li>
            ),
          )}
        </ul>
      )}
      <p className="muted">
        Выбранная календарная неделя фильтрует только явно заданную чётность.
        Занятия без указанной периодичности остаются видимыми; их актуальность
        нужно уточнять по источнику.
      </p>
    </details>
  );
}
