import type { RouteLocation } from "@openclaw/uirouter";
import { automationRouteFromPath } from "../../app-automation-paths.runtime.ts";
import { INTERNAL_ROUTE_PATH_PARAM } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { CronDetailTab } from "./view.ts";

export type CronRouteData = {
  jobId: string | null;
  detailTab: CronDetailTab;
};

export function loadCronRouteData(
  context: ApplicationContext,
  { location }: { location: RouteLocation },
): CronRouteData {
  const pathname =
    new URLSearchParams(location.search).get(INTERNAL_ROUTE_PATH_PARAM) ?? location.pathname;
  const route = automationRouteFromPath(pathname, context.basePath);
  return {
    jobId: route?.jobId ?? null,
    detailTab: route?.tab === "runs" ? "history" : "settings",
  };
}
