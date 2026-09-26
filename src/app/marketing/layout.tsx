import "../globals.css";
import "./landing.css";
import { BRAND_ICON_URL } from "@/lib/brand";

// Eigenes Root-Layout für die PT-Landingpage (#33): feste Sprache pt-PT, ohne App-Provider.
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-PT">
      <head>
        <link rel="icon" href={BRAND_ICON_URL} />
      </head>
      <body className="landing min-h-full">{children}</body>
    </html>
  );
}
