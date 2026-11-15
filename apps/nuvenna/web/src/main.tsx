import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
  useParams,
} from "@tanstack/react-router";
import { BrandingSettings, Frame, mountApp, SystemSettings } from "@tvn/ui";
import "@tvn/ui/styles.css";
import { BookOpen, Palette, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import * as texts from "./texts.js";
import { LabelPage } from "./extras.js";
import { PageView } from "./page.js";
import { SharedPage } from "./share.js";
import { SpacePage, SpacesPage, useSpaces } from "./spaces.js";

const PREFIX = "/nuvenna";
const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

function Layout() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const admin = pathname.startsWith("/admin");
  const spaces = useSpaces().data ?? [];
  const current = spaces.find((sp) => pathname.startsWith(`/spaces/${sp.key}`));
  const adminPages = [
    ["/admin/system", t("system.title"), <Wrench {...icon} />],
    ["/admin/branding", t("branding.title"), <Palette {...icon} />],
  ] as const;
  return (
    <Frame
      title={
        adminPages.find(([path]) => path === pathname)?.[1] ??
        current?.name ??
        t("app.home")
      }
      sections={[
        {
          items: [
            {
              label: t("app.home"),
              href: `${PREFIX}/`,
              icon: <BookOpen {...icon} />,
              active: pathname === "/",
            },
          ],
        },
        ...(spaces.length
          ? [
              {
                label: t("app.home"),
                items: spaces.map((sp) => ({
                  label: sp.name,
                  href: `${PREFIX}/spaces/${sp.key}`,
                  icon: (
                    <span className="font-mono text-xs text-fg-3">
                      {sp.key.slice(0, 2)}
                    </span>
                  ),
                  active: pathname.startsWith(`/spaces/${sp.key}`),
                })),
              },
            ]
          : []),
        ...(admin
          ? [
              {
                label: t("shell.admin"),
                items: adminPages.map(([path, label, i]) => ({
                  label,
                  href: `${PREFIX}${path}`,
                  icon: i,
                  active: pathname === path,
                })),
              },
            ]
          : []),
      ]}
    >
      <Outlet />
    </Frame>
  );
}

function LabelRoute() {
  const { label } = useParams({ from: "/labels/$label" });
  return <LabelPage label={label} />;
}

const root = createRootRoute({ component: Layout });
const routeTree = root.addChildren([
  createRoute({ getParentRoute: () => root, path: "/", component: SpacesPage }),
  createRoute({
    getParentRoute: () => root,
    path: "/spaces/$key",
    component: SpacePage,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/labels/$label",
    component: LabelRoute,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/spaces/$key/pages/$id",
    component: PageView,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/share",
    component: SharedPage,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/admin/branding",
    component: BrandingSettings,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/admin/system",
    component: SystemSettings,
  }),
]);
const router = createRouter({ routeTree, basepath: PREFIX });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

mountApp({
  prefix: PREFIX,
  texts,
  app: <RouterProvider router={router} />,
  adminPath: "/admin/system",
  publicPages: { "/share": <SharedPage /> },
});
