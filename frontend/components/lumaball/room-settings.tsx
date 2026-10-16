"use client";

import { useState, type FormEvent } from "react";
import { Save } from "lucide-react";
import { api } from "@/lib/api";
import { normalizeMapSettings } from "@/lib/lumaball/maps";
import { gameRequest, type Room } from "@/lib/lumaball/types";
import { MapSettings, mapSummary } from "./map-settings";
import styles from "./map-settings.module.css";

type RoomMap = Pick<
  Room,
  "id" | "status" | "map_id" | "map_width" | "map_height"
>;
export type RoomSettingsProps = {
  room: RoomMap;
  online: boolean;
  onSaved: (room: Room) => void;
  admin?: boolean;
};

export function RoomSettings(props: RoomSettingsProps) {
  const settings = normalizeMapSettings(props.room);
  return (
    <details className={styles.details}>
      <summary>Карта: {mapSummary(props.room)}</summary>
      <RoomSettingsForm
        key={`${props.room.id}-${settings.map_id}-${settings.map_width}-${settings.map_height}`}
        {...props}
      />
    </details>
  );
}

function RoomSettingsForm({
  room,
  online,
  onSaved,
  admin = false,
}: RoomSettingsProps) {
  const initial = normalizeMapSettings(room);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const stopped = room.status === "lobby" || room.status === "finished";
  const changed =
    value.map_id !== initial.map_id ||
    value.map_width !== initial.map_width ||
    value.map_height !== initial.map_height;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!online || !stopped || busy || !changed) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const options = { method: "PATCH", body: JSON.stringify(value) };
      const result = admin
        ? await api<Room>(`/admin/lumaball/rooms/${room.id}`, options)
        : await gameRequest<Room>(`/rooms/${room.id}`, options);
      setNotice("Карта обновлена у всех игроков.");
      onSaved(result);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось изменить карту.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={save}>
      <MapSettings
        value={value}
        onChange={(next) => {
          setValue(next);
          setNotice("");
        }}
        disabled={!online || !stopped || busy}
      />
      <p className={styles.hint}>
        {!online
          ? "Дождитесь соединения с комнатой."
          : !stopped
            ? "Чтобы сменить карту или размер поля, сначала нажмите «Стоп»."
            : "Новая карта появится у всех участников. Следующий матч начнётся на ней."}
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      <button
        className={styles.save}
        type="submit"
        disabled={!online || !stopped || busy || !changed}
      >
        <Save size={14} /> {busy ? "Меняем карту…" : "Применить карту"}
      </button>
    </form>
  );
}
