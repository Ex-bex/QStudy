import OperationsPanel from "@/components/control/OperationsPanel";
import { PageTitle } from "@/components/academic";

export default function OperationsControlPage() {
  return (
    <>
      <PageTitle
        eyebrow="НАДЁЖНОСТЬ И ИСТОРИЯ"
        title="Копии и журнал"
        description="Резервные копии общих данных и история действий администраторов."
      />
      <OperationsPanel />
    </>
  );
}
