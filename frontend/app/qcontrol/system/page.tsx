import SystemPanel from "@/components/control/SystemPanel";
import { PageTitle } from "@/components/academic";

export default function SystemControlPage() {
  return (
    <>
      <PageTitle
        eyebrow="ИНФРАСТРУКТУРА"
        title="Сервер и перенос"
        description="Параметры подключения, запуск, остановка и перенос всей экосистемы."
      />
      <SystemPanel />
    </>
  );
}
