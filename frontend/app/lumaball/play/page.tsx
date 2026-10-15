import type { Metadata } from "next";
import LumaLobby from "@/components/lumaball/lobby";

export const metadata: Metadata = { title: "Комнаты LumaBall" };

export default function LumaPlayPage() {
  return <LumaLobby />;
}
