import { getTranslations } from "next-intl/server";
import { APP_NAME } from "@/lib/brand";
import { SOURCE_URL, LICENSE_URL } from "@/lib/version";

// Rechtliche Hinweise (AGPL-3.0 §5d „Appropriate Legal Notices“, §13 Quellcode) — öffentlich,
// auch vor der Anmeldung erreichbar (Login-Seite, Info-Drawer).
export default async function LegalPage() {
  const t = await getTranslations();
  return (
    <main className="mx-auto max-w-xl space-y-4 p-8 text-sm">
      <h1 className="text-2xl font-semibold tracking-tight">{t("legal.notice")}</h1>
      <p className="font-medium">{APP_NAME}</p>
      <p>{t("legal.copyright")}</p>
      <p className="text-muted-foreground">{t("legal.warranty")}</p>
      <p className="flex gap-4">
        <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer" className="font-medium underline-offset-4 hover:underline">
          {t("legal.license")}
        </a>
        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer" className="font-medium underline-offset-4 hover:underline">
          {t("legal.source")}
        </a>
      </p>
    </main>
  );
}
