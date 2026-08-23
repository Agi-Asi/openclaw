import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import {
  DEFAULT_MAIN_KEY,
  isReservedSessionRest,
  normalizeControlUiBasePath,
  parseShortSessionRef,
} from "./grammar.js";

export { normalizeControlUiBasePath };
export * from "./focus.js";

// Control UI session URL grammar shared by browser and plugin consumers.
export type ControlUiSessionNamespace = "chat" | "dashboard";

type BuildControlUiSessionPathParams = {
  namespace: ControlUiSessionNamespace;
  sessionKey: string;
  fallbackAgentId?: string;
  basePath?: string;
  displayName?: string;
  exactKey?: boolean;
  mainKey?: string;
  shortIdLength?: number;
};

type BuildControlUiCatalogSessionUrlParams = {
  namespace: ControlUiSessionNamespace;
  agentId: string;
  basePath?: string;
  catalog: string;
  host: string;
  thread: string;
};

export type ControlUiAutomationTab = "settings" | "runs";

export type ControlUiAutomationRoute = {
  jobId: string;
  tab: ControlUiAutomationTab;
};

type BuildControlUiAutomationPathParams = {
  basePath?: string;
  tab?: ControlUiAutomationTab;
};

export const CONTROL_UI_AUTOMATIONS_PATH = "/automations";
export const CONTROL_UI_AUTOMATIONS_PATH_ALIAS = "/cron";

export const SESSION_UUID_SUFFIX_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
export const SHORT_SESSION_ID_RE = /^[0-9a-f]{8,32}$/iu;
const SESSION_SLUG_MAX_LENGTH = 48;

function agentSessionKeyParts(sessionKey: string): { agentId: string; rest: string } | null {
  const parts = sessionKey.split(":");
  if (parts.length < 3 || parts[0]?.toLowerCase() !== "agent") {
    return null;
  }
  const agentId = normalizeNullableString(parts[1]);
  const restSegments = parts.slice(2);
  if (!agentId || restSegments.some((segment) => !segment)) {
    return null;
  }
  return { agentId: normalizeAgentId(agentId), rest: restSegments.join(":") };
}

function encodePathSegment(segment: string): string {
  if (segment === ".") {
    return "~dot";
  }
  if (segment === "..") {
    return "~dotdot";
  }
  // encodeURIComponent leaves "." alone, so a key segment like "release.js" would
  // reach the server looking like a static asset request and never hit the SPA.
  // pathForWorkboardBoard escapes dots for the same reason.
  const encoded = encodeURIComponent(segment).replaceAll(".", "%2E");
  return encoded.startsWith("~") ? `~${encoded}` : encoded;
}

function decodePathSegment(segment: string): string | null {
  const escaped = segment === "~dot" ? "." : segment === "~dotdot" ? ".." : segment;
  const encoded = escaped.startsWith("~~") ? escaped.slice(1) : escaped;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function buildControlUiAutomationPath(
  jobId: string,
  params: BuildControlUiAutomationPathParams = {},
): string | null {
  const normalizedJobId = normalizeNullableString(jobId);
  if (!normalizedJobId) {
    return null;
  }
  const basePath = normalizeControlUiBasePath(params.basePath);
  const path = `${basePath}${CONTROL_UI_AUTOMATIONS_PATH}/${encodePathSegment(normalizedJobId)}`;
  return params.tab === "runs" ? `${path}/runs` : path;
}

export function parseControlUiAutomationPath(
  pathname: string,
  basePath = "",
): ControlUiAutomationRoute | null {
  const normalizedBasePath = normalizeControlUiBasePath(basePath);
  const normalizedPath = pathname.trim().replace(/\/+$/u, "") || "/";
  const roots = [CONTROL_UI_AUTOMATIONS_PATH, CONTROL_UI_AUTOMATIONS_PATH_ALIAS].map(
    (path) => `${normalizedBasePath}${path}`,
  );
  const root = roots.find((candidate) =>
    normalizedPath.toLowerCase().startsWith(`${candidate.toLowerCase()}/`),
  );
  if (!root) {
    return null;
  }
  const segments = normalizedPath.slice(root.length + 1).split("/");
  if (segments.length > 2 || !segments[0] || (segments[1] && segments[1] !== "runs")) {
    return null;
  }
  const jobId = decodePathSegment(segments[0]);
  if (jobId === null || !jobId.trim()) {
    return null;
  }
  return { jobId, tab: segments[1] === "runs" ? "runs" : "settings" };
}

export function controlUiSessionSlug(displayName: string | undefined | null): string {
  const tokens = (displayName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .split("-")
    .filter(Boolean);
  while (tokens.length > 0 && /^[0-9a-f]+$/u.test(tokens.at(-1) ?? "")) {
    tokens.pop();
  }
  return tokens.join("-").slice(0, SESSION_SLUG_MAX_LENGTH).replace(/-+$/gu, "");
}

export function buildControlUiSessionPath(params: BuildControlUiSessionPathParams): string | null {
  const rawKey = normalizeNullableString(params.sessionKey);
  const parsed = rawKey ? agentSessionKeyParts(rawKey) : null;
  const fallbackAgentId = normalizeNullableString(params.fallbackAgentId);
  const agentId = parsed?.agentId ?? (fallbackAgentId ? normalizeAgentId(fallbackAgentId) : null);
  if (!rawKey || !agentId || (!parsed && rawKey.toLowerCase().startsWith("agent:"))) {
    return null;
  }
  const namespace = `${normalizeControlUiBasePath(params.basePath)}/${params.namespace}`;
  const encodedAgentId = encodePathSegment(agentId);
  const rest = parsed?.rest ?? rawKey;
  const normalizedRest = rest.toLowerCase();
  const mainKey = normalizeNullableString(params.mainKey)?.toLowerCase() ?? DEFAULT_MAIN_KEY;
  if (
    (!parsed && normalizedRest === DEFAULT_MAIN_KEY) ||
    normalizedRest === mainKey ||
    normalizedRest === "global"
  ) {
    return `${namespace}/${encodedAgentId}`;
  }
  const segments = rest.split(":");
  if (segments.some((segment) => !segment)) {
    return null;
  }
  if (params.exactKey) {
    const segment = segments[0] ?? "";
    return segments.length === 1 &&
      (isReservedSessionRest(segment, params.mainKey) || parseShortSessionRef(segment))
      ? `${namespace}/${encodedAgentId}/~key/${encodePathSegment(segment)}`
      : `${namespace}/${encodedAgentId}/${segments.map(encodePathSegment).join("/")}`;
  }
  const matchedUuid = parsed?.rest.match(SESSION_UUID_SUFFIX_RE)?.[1];
  const uuid = matchedUuid?.toLowerCase().replaceAll("-", "") ?? null;
  if (uuid) {
    const requestedLength = params.shortIdLength ?? 8;
    let length = Math.min(uuid.length, Math.max(8, Math.floor(requestedLength)));
    const slug = controlUiSessionSlug(params.displayName);
    let sessionRef = `${slug ? `${slug}-` : ""}${uuid.slice(0, length)}`;
    while (length < uuid.length && isReservedSessionRest(sessionRef, params.mainKey)) {
      length += 1;
      sessionRef = `${slug ? `${slug}-` : ""}${uuid.slice(0, length)}`;
    }
    return isReservedSessionRest(sessionRef, params.mainKey)
      ? null
      : `${namespace}/${encodedAgentId}/${sessionRef}`;
  }
  if (segments.length === 1) {
    const segment = segments[0] ?? "";
    if (!isReservedSessionRest(segment, params.mainKey) && parseShortSessionRef(segment)) {
      return `${namespace}/${encodedAgentId}/~key/${encodePathSegment(segment)}`;
    }
  }
  return `${namespace}/${encodedAgentId}/${segments.map(encodePathSegment).join("/")}`;
}

export function buildControlUiCatalogSessionUrl(
  params: BuildControlUiCatalogSessionUrlParams,
): string | null {
  const catalog = normalizeNullableString(params.catalog);
  const host = normalizeNullableString(params.host);
  const thread = normalizeNullableString(params.thread);
  const path = buildControlUiSessionPath({
    namespace: params.namespace,
    sessionKey: DEFAULT_MAIN_KEY,
    fallbackAgentId: params.agentId,
    basePath: params.basePath,
  });
  if (!path || !catalog || !host || !thread) {
    return null;
  }
  return `${path}?${new URLSearchParams({ catalog, host, thread }).toString()}`;
}
