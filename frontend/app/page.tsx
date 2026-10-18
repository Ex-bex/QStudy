import type { Metadata } from "next";
import QForceHome from "@/components/qforce/home";

export const metadata: Metadata = {
  title: { absolute: "QForce — команда и экосистема проектов" },
  description:
    "Познакомьтесь с командой QForce, её подразделениями и проектами: QStudy, QTests, QCareer, QBall, Q-ID и QControl.",
};

export default function Home() {
  return <QForceHome />;
}
