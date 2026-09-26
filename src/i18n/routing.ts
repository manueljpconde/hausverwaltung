import { defineRouting } from "next-intl/routing";
import { APP_DEFAULT_LOCALE } from "@/lib/brand";

export const routing = defineRouting({
  locales: ["de", "en", "pt"],
  defaultLocale: APP_DEFAULT_LOCALE,
});
