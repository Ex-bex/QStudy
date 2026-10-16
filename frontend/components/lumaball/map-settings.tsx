"use client";

import { RotateCcw } from "lucide-react";
import {
  MAP_LIMITS,
  MAPS,
  normalizeMapSettings,
  type MapSettings as MapSettingsValue,
} from "@/lib/lumaball/maps";
import styles from "./map-settings.module.css";

export function mapSummary(value: Parameters<typeof normalizeMapSettings>[0]) {
  const settings = normalizeMapSettings(value);
  const preset = MAPS.find((map) => map.id === settings.map_id)!;
  return `${preset.name} · ${settings.map_width} × ${settings.map_height} м`;
}

export function MapSettings({
  value,
  onChange,
  disabled = false,
}: {
  value: MapSettingsValue;
  onChange: (value: MapSettingsValue) => void;
  disabled?: boolean;
}) {
  const preset = MAPS.find((map) => map.id === value.map_id) || MAPS[0];
  const preview = normalizeMapSettings(value);
  const width = preview.map_width * 10;
  const height = preview.map_height * 10;
  return (
    <fieldset className={styles.fields} disabled={disabled}>
      <legend>Карта и размер поля</legend>
      <label>
        <span>Карта</span>
        <select
          value={value.map_id}
          onChange={(event) => {
            const next = MAPS.find((map) => map.id === event.target.value);
            if (next)
              onChange({
                map_id: next.id,
                map_width: next.width,
                map_height: next.height,
              });
          }}
        >
          {MAPS.map((map) => (
            <option key={map.id} value={map.id}>
              {map.name}
            </option>
          ))}
        </select>
      </label>
      <p className={styles.hint}>{preset.description}</p>
      <div className={styles.sizes}>
        <label>
          <span>Ширина, м</span>
          <input
            type="number"
            inputMode="numeric"
            min={MAP_LIMITS.minWidth}
            max={MAP_LIMITS.maxWidth}
            step={1}
            required
            value={value.map_width}
            onChange={(event) =>
              onChange({ ...value, map_width: Number(event.target.value) })
            }
          />
        </label>
        <label>
          <span>Высота, м</span>
          <input
            type="number"
            inputMode="numeric"
            min={MAP_LIMITS.minHeight}
            max={MAP_LIMITS.maxHeight}
            step={1}
            required
            value={value.map_height}
            onChange={(event) =>
              onChange({ ...value, map_height: Number(event.target.value) })
            }
          />
        </label>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className={`${styles.preview} ${styles[value.map_id]}`}
        aria-hidden="true"
        preserveAspectRatio="xMidYMid meet"
      >
        <rect x="4" y="4" width={width - 8} height={height - 8} rx="3" />
        {value.map_id === "arena" ? (
          <>
            {[0.4, 0.6].flatMap((x) =>
              [0.28, 0.72].map((y) => (
                <circle
                  className={styles.obstacle}
                  key={`${x}-${y}`}
                  cx={width * x}
                  cy={height * y}
                  r="3"
                />
              )),
            )}
          </>
        ) : (
          <>
            <path d={`M ${width / 2} 4 V ${height - 4}`} />
            <circle cx={width / 2} cy={height / 2} r="9" />
            <path
              d={`M 4 ${height * 0.3} H 14 V ${height * 0.7} H 4 M ${width - 4} ${height * 0.3} H ${width - 14} V ${height * 0.7} H ${width - 4}`}
            />
          </>
        )}
        <circle
          className={styles.ball}
          cx={width / 2}
          cy={height / 2}
          r="1.7"
        />
      </svg>
      <div className={styles.footer}>
        <span>{mapSummary(value)}</span>
        <button
          type="button"
          onClick={() => onChange(normalizeMapSettings())}
          className={styles.reset}
        >
          <RotateCcw size={12} /> По умолчанию
        </button>
      </div>
    </fieldset>
  );
}
