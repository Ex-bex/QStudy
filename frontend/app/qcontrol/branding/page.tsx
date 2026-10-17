import { BrandingAdmin } from "@/components/branding-admin";
import { DeveloperDirectoryAdmin } from "@/components/developer-directory";
import { PageTitle } from "@/components/academic";
import EcosystemBrandingAdmin from "@/components/control/ecosystem-branding-admin";

export default function BrandingControlPage() {
  return (
    <>
      <PageTitle
        eyebrow="ИДЕНТИЧНОСТЬ ЭКОСИСТЕМЫ"
        title="Брендинг и команда"
        description="Логотипы проектов, департаменты и публичные контакты разработчиков."
      />
      <EcosystemBrandingAdmin />
      <BrandingAdmin />
      <DeveloperDirectoryAdmin />
    </>
  );
}
