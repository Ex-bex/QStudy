/** Map sizes use the original LumaBall metres; frames and painting use pixels. */
export type MapId = "classic" | "hockey" | "arena";
export type MapSettings = {
  map_id: MapId;
  map_width: number;
  map_height: number;
};
export type MapOptions = {
  map_id?: string;
  map_width?: number;
  map_height?: number;
  width?: number;
  height?: number;
};
export const MAPS = [
  {
    id: "classic",
    name: "Футбол",
    description: "Оригинальная физика LumaBall и футбольные ворота.",
    width: 10,
    height: 5,
    playerDamping: 1.5,
    ballDamping: 1,
    hasGoals: true,
  },
  {
    id: "hockey",
    name: "Хоккей",
    description: "Ледовая площадка, шайба и более долгое скольжение.",
    width: 12,
    height: 6,
    playerDamping: 0.45,
    ballDamping: 0.2,
    hasGoals: true,
  },
  {
    id: "arena",
    name: "Арена",
    description: "Закрытая тренировочная арена с препятствиями, без голов.",
    width: 14,
    height: 8,
    playerDamping: 1.5,
    ballDamping: 1,
    hasGoals: false,
  },
] as const;

export const MAP_LIMITS = {
  minWidth: 10,
  maxWidth: 30,
  minHeight: 5,
  maxHeight: 15,
  pixelsPerMetre: 80,
} as const;

export function isMapId(value: unknown): value is MapId {
  return MAPS.some((map) => map.id === value);
}

function size(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}

export function normalizeMapSettings(value?: MapOptions): MapSettings {
  return {
    map_id: isMapId(value?.map_id) ? value.map_id : "classic",
    map_width: size(value?.map_width, 10, 30, 10),
    map_height: size(value?.map_height, 5, 15, 5),
  };
}

export type FieldObstacle =
  | { kind: "circle"; x: number; y: number; radius: number }
  | { kind: "box"; x: number; y: number; width: number; height: number };

/** Room settings are metres; a received GameFrame supplies width/height in pixels. */
export function getField(value?: MapOptions) {
  const settings = normalizeMapSettings({
    ...value,
    map_width:
      value?.map_width ??
      (value?.width === undefined ? undefined : value.width / 80),
    map_height:
      value?.map_height ??
      (value?.height === undefined ? undefined : value.height / 80),
  });
  const width = settings.map_width * 80;
  const height = settings.map_height * 80;
  const obstacles: FieldObstacle[] =
    settings.map_id === "arena"
      ? [
          { kind: "circle", x: width * 0.4, y: height * 0.28, radius: 20 },
          { kind: "circle", x: width * 0.6, y: height * 0.28, radius: 20 },
          { kind: "circle", x: width * 0.4, y: height * 0.72, radius: 20 },
          { kind: "circle", x: width * 0.6, y: height * 0.72, radius: 20 },
        ]
      : [];
  return {
    map_id: settings.map_id,
    width,
    height,
    left: 80,
    right: width - 80,
    top: 60,
    bottom: height - 60,
    goalTop: height / 2 - (height - 120) * 0.2,
    goalBottom: height / 2 + (height - 120) * 0.2,
    goalDepth: 40,
    playerRadius: 17.6,
    ballRadius: 8,
    postRadius: 6.8,
    centerRadius: 80,
    kickRadius: 29.6,
    hasGoals: settings.map_id !== "arena",
    obstacles,
  };
}

export type Field = ReturnType<typeof getField>;
