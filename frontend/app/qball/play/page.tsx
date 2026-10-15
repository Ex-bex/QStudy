import type { Metadata } from "next";
import LumaLobby from "@/components/lumaball/lobby";

export const metadata: Metadata = { title: "Комнаты QBall" };

export default function LumaPlayPage() {
  return <LumaLobby />;
}
