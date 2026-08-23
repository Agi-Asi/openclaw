import type { RouteLocation } from "@openclaw/uirouter";
import { automationRouteFromPath, INTERNAL_AUTOMATION_PATH_PARAM } from "../../app-route-paths.ts";
import type { CronDetailTab } from "./view.ts";

export type CronRouteData = {
  jobId: string | null;
  detailTab: CronDetailTab;
};

export function cronRouteLocation(location: RouteLocation): RouteLocation {
  const params = new URLSearchParams(location.search);
  const pathname = params.get(INTERNAL_AUTOMATION_PATH_PARAM) ?? location.pathname;
  params.delete(INTERNAL_AUTOMATION_PATH_PARAM);
  const search = params.toString();
  return { pathname, search: search ? `?${search}` : "", hash: location.hash };
}

export function resolveCronRouteData(location: RouteLocation, basePath = ""): CronRouteData {
  const route = automationRouteFromPath(cronRouteLocation(location).pathname, basePath);
  return {
    jobId: route?.jobId ?? null,
    detailTab: route?.tab === "runs" ? "history" : "settings",
  };
}
