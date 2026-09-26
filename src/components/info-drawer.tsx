"use client";

import { Info, Building2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { APP_VERSION, APP_VERSION_LABEL, APP_BUILD, APP_SHA, SOURCE_URL, LICENSE_URL } from "@/lib/version";
import { APP_NAME, BRAND_LOGO_URL } from "@/lib/brand";

export function InfoDrawer({ tenantName }: { tenantName: string }) {
  const t = useTranslations("about");
  const legal = useTranslations("legal");

  return (
    <Sheet>
      <SheetTrigger
        render={<Button variant="ghost" size="icon" aria-label={t("title", { app: APP_NAME })} title={t("title", { app: APP_NAME })} />}
      >
        <Info className="size-5" />
      </SheetTrigger>
      <SheetContent side="right" className="w-[92vw] gap-0 overflow-y-auto p-0 sm:max-w-sm">
        {/* Kopf: satter Verlauf (unabhängig von der Brandfarbe) + großes Logo */}
        <div className="relative overflow-hidden bg-gradient-to-br from-violet-600 via-indigo-600 to-blue-700 p-6 text-white">
          <div className="pointer-events-none absolute -right-10 -top-12 size-48 rounded-full bg-white/15 blur-2xl" />
          <div className="pointer-events-none absolute -bottom-14 -left-8 size-40 rounded-full bg-fuchsia-500/25 blur-3xl" />
          <div className="relative flex flex-col items-center text-center">
            <div className="grid size-56 place-items-center rounded-3xl bg-white p-4 shadow-lg ring-1 ring-white/30">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={BRAND_LOGO_URL} alt={APP_NAME} className="size-48 rounded-2xl object-contain" />
            </div>
            <SheetTitle className="mt-4 text-2xl font-semibold tracking-tight text-white">
              {APP_NAME}
            </SheetTitle>
            <p className="text-sm text-white/80">{t("tagline")}</p>
          </div>
          <div className="relative mt-4 flex items-center justify-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-400 px-2.5 py-1 text-xs font-semibold text-amber-950 shadow-sm">
              <span className="size-1.5 animate-pulse rounded-full bg-amber-950" />
              {t("beta")}
            </span>
            <span className="rounded-full bg-white/15 px-2.5 py-1 font-mono text-xs backdrop-blur">
              {APP_VERSION_LABEL}
            </span>
          </div>
        </div>

        <div className="space-y-5 p-5">
          {/* Beta-Hinweis */}
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
            {t("betaNote")}
          </p>

          {/* Version & Mandant */}
          <dl className="rounded-xl border bg-card">
            <div className="flex items-center justify-between gap-3 border-b px-3 py-2.5">
              <dt className="text-xs text-muted-foreground">{t("version")}</dt>
              <dd className="font-mono text-xs">v{APP_VERSION}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 border-b px-3 py-2.5">
              <dt className="text-xs text-muted-foreground">{t("build")}</dt>
              <dd className="font-mono text-xs">
                {APP_BUILD}
                {APP_SHA ? ` · ${APP_SHA}` : ""}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 px-3 py-2.5">
              <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Building2 className="size-3.5" /> {t("tenant")}
              </dt>
              <dd className="truncate text-right text-xs font-medium">{tenantName}</dd>
            </div>
          </dl>

          {/* Quellcode, Lizenz und rechtliche Hinweise (AGPL-3.0 §5d, §13) — Hinweis aufklappbar, ohne Seitenwechsel */}
          <div className="space-y-2 px-1 text-xs">
            <p className="flex flex-wrap gap-x-4 gap-y-1">
              <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer" className="font-medium underline-offset-4 hover:underline">
                {legal("source")}
              </a>
              <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer" className="font-medium underline-offset-4 hover:underline">
                {legal("license")}
              </a>
            </p>
            <details>
              <summary className="cursor-pointer font-medium underline-offset-4 hover:underline">{legal("notice")}</summary>
              <div className="mt-2 space-y-1.5 text-muted-foreground">
                <p>{legal("copyright")}</p>
                <p>{legal("warranty")}</p>
              </div>
            </details>
          </div>
        </div>

      </SheetContent>
    </Sheet>
  );
}
