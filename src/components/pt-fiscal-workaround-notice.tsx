import { getTranslations } from "next-intl/server";
import type { TenantMarket } from "@prisma/client";
import { Card, CardContent } from "@/components/ui/card";

/** Shown when Tenant.market=PT — documents fiscal workarounds (issue #1 Phase 2). */
export async function PtFiscalWorkaroundNotice({ market }: { market: TenantMarket }) {
  if (market !== "PT") return null;
  const t = await getTranslations("fiscalWorkaround");
  return (
    <Card className="border-dashed bg-muted/30">
      <CardContent className="space-y-2 p-4 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{t("title")}</p>
        <ul className="list-inside list-disc space-y-1">
          <li>{t("saft")}</li>
          <li>{t("einvoice")}</li>
          <li>{t("imi")}</li>
        </ul>
        <p className="text-xs">{t("footnote")}</p>
      </CardContent>
    </Card>
  );
}
