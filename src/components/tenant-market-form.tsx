"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Check, TriangleAlert } from "lucide-react";
import type { TenantMarket } from "@prisma/client";
import { updateTenantMarket } from "@/server/actions/config";
import type { ActionState } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

export function TenantMarketForm({ market, editable }: { market: TenantMarket; editable: boolean }) {
  const t = useTranslations("settings");
  const [state, action, pending] = useActionState<ActionState, FormData>(updateTenantMarket, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("market")}</CardTitle>
      </CardHeader>
      <CardContent>
        {editable ? (
          <form action={action} className="flex flex-wrap items-end gap-3">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="market">{t("marketLabel")}</Label>
              <select
                id="market"
                name="market"
                defaultValue={market}
                className="flex h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <option value="DE">{t("marketDE")}</option>
                <option value="PT">{t("marketPT")}</option>
              </select>
              <p className="text-xs text-muted-foreground">{t("marketHint")}</p>
            </div>
            <Button type="submit" disabled={pending}>
              {t("save")}
            </Button>
            {state.error && (
              <span className="flex items-center gap-1.5 text-sm text-destructive">
                <TriangleAlert className="size-4" /> {state.error}
              </span>
            )}
            {state.ok && (
              <span className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                <Check className="size-4" /> {t("saved")}
              </span>
            )}
          </form>
        ) : (
          <div className="text-lg font-medium">{market === "PT" ? t("marketPT") : t("marketDE")}</div>
        )}
      </CardContent>
    </Card>
  );
}
