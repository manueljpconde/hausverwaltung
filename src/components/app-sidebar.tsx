"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { navGroups } from "@/lib/nav";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { APP_VERSION_LABEL, APP_VERSION_FULL } from "@/lib/version";
import { APP_NAME, BRAND_ICON_URL } from "@/lib/brand";

export function AppSidebar({
  logoUrl,
  superAdmin = false,
  market = "DE",
}: {
  logoUrl?: string;
  superAdmin?: boolean;
  market?: "DE" | "PT";
}) {
  const t = useTranslations();
  const pathname = usePathname();
  const labelKey = (key: string) => (key === "nav.weg" && market === "PT" ? "nav.condominio" : key);

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoUrl ?? BRAND_ICON_URL} alt={APP_NAME} className="size-8 rounded-md object-contain" />
          <div className="grid leading-tight">
            <span className="font-semibold">{APP_NAME}</span>
            <span className="text-xs text-muted-foreground">{t("app.tagline")}</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {navGroups.map((group) => (
          <SidebarGroup key={group.labelKey}>
            <SidebarGroupLabel>{t(group.labelKey)}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.filter((item) => !item.superAdmin || superAdmin).map((item) => {
                  const active =
                    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                  const key = labelKey(item.key);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        render={<Link href={item.href} />}
                        isActive={active}
                        tooltip={t(key)}
                      >
                        <item.icon />
                        <span>{t(key)}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <div className="px-2 py-1 text-xs text-muted-foreground" title={APP_VERSION_FULL}>
          {APP_VERSION_LABEL}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
