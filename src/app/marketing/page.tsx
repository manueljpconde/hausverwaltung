import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { APP_NAME, BRAND_LOGO_URL } from "@/lib/brand";
import { SOURCE_URL } from "@/lib/version";
import { listBackgroundVideos } from "@/lib/videos";
import { BackgroundVideo } from "@/components/background-video";
import { LANDING_CTA_URL, LANDING_FEATURES, LANDING_TRUST, LANDING_SCREENSHOT, landingIcon, posterFor } from "@/lib/landing";

// Pro Anfrage rendern: Canonical/OG-URL werden absolut aus AUTH_URL (Laufzeit, je Deployment).
export const dynamic = "force-dynamic";

const texts = () => getTranslations({ locale: "pt", namespace: "landing" });

export async function generateMetadata(): Promise<Metadata> {
  const t = await texts();
  const title = t("meta.title", { app: APP_NAME });
  const description = t("meta.description");
  return {
    metadataBase: process.env.AUTH_URL ? new URL(process.env.AUTH_URL) : undefined,
    title,
    description,
    alternates: { canonical: "/marketing" },
    openGraph: { title, description, url: "/marketing", locale: "pt_PT", type: "website" },
  };
}

// PT-Landingpage (#33) — Kundengewinnung; alle CTAs → LANDING_CTA_URL.
export default async function MarketingPage() {
  const t = await texts();
  const videos = await listBackgroundVideos();
  const poster = videos[0] ? posterFor(videos[0]) : undefined;

  return (
    <>
      <a href="#conteudo" className="cw-skip">
        {t("skip")}
      </a>

      <header className="sticky top-0 z-50 border-b border-black/10 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <Link href="/marketing" aria-label={APP_NAME}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={BRAND_LOGO_URL} alt={APP_NAME} className="h-8 w-auto" />
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/pt/login" className="hidden underline-offset-4 hover:underline sm:inline">
              {t("nav.login")}
            </Link>
            <a href={LANDING_CTA_URL} className="cw-btn">
              {t("nav.contact")}
            </a>
          </nav>
        </div>
      </header>

      <main id="conteudo">
        <section className="relative isolate overflow-hidden text-white">
          {poster && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={poster} alt="" className="absolute inset-0 -z-20 size-full object-cover" />
          )}
          <BackgroundVideo
            sources={videos}
            poster={poster}
            className="absolute inset-0 -z-10"
            mediaQuery="(min-width: 768px) and (prefers-reduced-motion: no-preference)"
            controls
            pauseLabel={t("video.pause")}
            playLabel={t("video.play")}
            controlsClassName="absolute bottom-4 right-4 z-10 rounded border border-white/80 bg-black/50 px-3 py-1 text-xs"
          />
          <div className="absolute inset-0 -z-10 bg-gradient-to-r from-black/85 via-black/70 to-black/40" />
          <div className="mx-auto max-w-6xl px-4 py-24 md:py-32">
            <h1 className="max-w-2xl text-3xl font-bold leading-tight md:text-5xl">{t("hero.title")}</h1>
            <p className="mt-4 max-w-2xl text-lg">{t("hero.subtitle")}</p>
            <p className="mt-3 max-w-2xl text-sm text-white/90">{t("hero.fit")}</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a href={LANDING_CTA_URL} className="cw-btn text-center">
                {t("hero.cta")}
              </a>
              <a href="#funcionalidades" className="cw-btn-outline text-center">
                {t("hero.secondary")}
              </a>
            </div>
          </div>
        </section>

        <section id="funcionalidades" className="mx-auto max-w-6xl px-4 py-16" aria-labelledby="funcionalidades-titulo">
          <h2 id="funcionalidades-titulo" className="text-2xl font-bold">
            {t("features.title")}
          </h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {LANDING_FEATURES.map((f) => (
              <article key={f.key} className="cw-card">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={landingIcon(f.icon)} alt="" className="size-8" />
                <h3 className="mt-4 text-lg font-bold">{t(`features.${f.key}.title`)}</h3>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
                  <li>{t(`features.${f.key}.p1`)}</li>
                  <li>{t(`features.${f.key}.p2`)}</li>
                  <li>{t(`features.${f.key}.p3`)}</li>
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section className="bg-[var(--cw-beige)]" aria-labelledby="produto-titulo">
          <div className="mx-auto max-w-6xl px-4 py-16">
            <h2 id="produto-titulo" className="text-2xl font-bold">
              {t("product.title")}
            </h2>
            <figure className="mt-8">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={LANDING_SCREENSHOT}
                alt={t("product.alt")}
                width={1440}
                height={900}
                loading="lazy"
                className="h-auto w-full rounded-lg shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
              />
              <figcaption className="mt-3 text-sm">{t("product.caption")}</figcaption>
            </figure>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-16" aria-labelledby="porque-titulo">
          <h2 id="porque-titulo" className="text-2xl font-bold">
            {t("trust.title", { app: APP_NAME })}
          </h2>
          <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
            {LANDING_TRUST.map((item) => (
              <li key={item.key} className="cw-card text-sm">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={landingIcon(item.icon)} alt="" className="size-7" />
                <p className="mt-3 font-bold">{t(`trust.${item.key}`)}</p>
                {item.key === "openSource" && (
                  <a href={SOURCE_URL} className="mt-2 inline-block underline underline-offset-4">
                    {t("trust.openSourceLink")}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="bg-[var(--cw-teal)]" aria-labelledby="fecho-titulo">
          <div className="mx-auto max-w-6xl px-4 py-16 text-center">
            <h2 id="fecho-titulo" className="text-2xl font-bold">
              {t("closing.title")}
            </h2>
            <a href={LANDING_CTA_URL} className="cw-btn mt-6 bg-white hover:bg-[var(--cw-beige)]">
              {t("closing.cta")}
            </a>
          </div>
        </section>
      </main>

      <footer className="border-t border-black/10">
        <div className="mx-auto flex max-w-6xl flex-wrap gap-x-6 gap-y-2 px-4 py-6 text-sm">
          <span>{t("footer.copyright", { app: APP_NAME })}</span>
          <Link href="/pt/legal" className="underline underline-offset-4">
            {t("footer.legal")}
          </Link>
          <a href={SOURCE_URL} className="underline underline-offset-4">
            {t("footer.source")}
          </a>
          <Link href="/pt/login" className="underline underline-offset-4">
            {t("footer.login")}
          </Link>
        </div>
      </footer>
    </>
  );
}
