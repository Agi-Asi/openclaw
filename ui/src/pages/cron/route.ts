import { definePage, type RouteLocation } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { cronRouteLocation, resolveCronRouteData, type CronRouteData } from "./route-location.ts";

export type { CronRouteData } from "./route-location.ts";

export const page = definePage({
  ...routePageSpec("cron"),
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => {
    const routeLocation = cronRouteLocation(location);
    return `${routeLocation.pathname}\u0000${routeLocation.search}\u0000${routeLocation.hash}`;
  },
  loader: (context: ApplicationContext, { location }) =>
    resolveCronRouteData(location, context.basePath),
  component: () =>
    import("./cron-page.ts").then(() => ({
      header: true,
      render: (data: CronRouteData | undefined) =>
        html`<openclaw-cron-page .routeData=${data}></openclaw-cron-page>`,
    })),
});
