import type {
  AuthorizedMemoryMutation,
  AuthorizedMemoryPlan,
  AuthorizedMemoryVirtualView,
  AuthorizedResourceHandle,
  MemoryAccessContext,
  MemoryContentAccessContext,
} from "openclaw/plugin-sdk/memory-authorization";
import type {
  MemoryBrokerAuthorizationBinding,
  MemoryBrokerHandler,
} from "openclaw/plugin-sdk/memory-broker-runtime";
import {
  builtinScopedMemoryAuthorizedRuntime,
  builtinScopedMemoryVirtualView,
} from "./scoped-memory-runtime.js";

type BrokerPayload = Readonly<{
  context: MemoryAccessContext;
  plan?: AuthorizedMemoryPlan;
  query?: string;
  sources?: unknown;
  limit?: number;
  handle?: AuthorizedResourceHandle;
  from?: number;
  lines?: number;
  mutation?: AuthorizedMemoryMutation;
  handles?: readonly AuthorizedResourceHandle[];
  view?: AuthorizedMemoryVirtualView;
  virtualPath?: string;
}>;

function asPayload(value: unknown): BrokerPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("memory broker payload is unavailable");
  }
  return value as BrokerPayload;
}

function assertBoundContext(params: {
  binding: MemoryBrokerAuthorizationBinding;
  context: MemoryAccessContext;
  plan?: AuthorizedMemoryPlan;
}): void {
  const { binding, context, plan } = params;
  const capabilitySnapshotId =
    context.delegation?.capabilitySnapshotId ?? context.hostFactsRevision;
  const policyRevision = plan?.memoryPolicyRevision ?? context.hostFactsRevision;
  if (
    context.agentId !== binding.agentId ||
    context.sessionId !== binding.sessionId ||
    context.runId !== binding.runId ||
    context.contextFingerprint !== binding.contextFingerprint ||
    context.subjectRevision !== binding.subjectRevision ||
    context.actor.evidenceRevision !== binding.actorRevision ||
    capabilitySnapshotId !== binding.capabilitySnapshotId ||
    policyRevision !== binding.policyRevision ||
    context.delivery.deliveryRevision !== binding.deliveryRevision
  ) {
    throw new Error("memory broker binding is unavailable");
  }
}

function readContentContext(context: MemoryAccessContext): MemoryContentAccessContext {
  if (context.operation !== "read" && context.operation !== "derive") {
    throw new Error("memory broker content operation is unavailable");
  }
  return context;
}

function readPlan(payload: BrokerPayload): AuthorizedMemoryPlan {
  if (!payload.plan) {
    throw new Error("memory broker plan is unavailable");
  }
  return payload.plan;
}

/**
 * This entry is loaded only by the Gateway-owned broker child. It owns the selected runtime's
 * process-local plan and handle maps, so Gateway and workers can retain only opaque DTOs.
 */
export function createMemoryBrokerHandler(): MemoryBrokerHandler {
  return async ({ binding, request, signal }) => {
    const payload = asPayload(request.payload);
    const plan = payload.plan;
    assertBoundContext({ binding, context: payload.context, ...(plan ? { plan } : {}) });
    switch (request.method) {
      case "memory.authorize":
        return await builtinScopedMemoryAuthorizedRuntime.authorize(payload.context);
      case "memory.search": {
        const context = readContentContext(payload.context);
        if (typeof payload.query !== "string" || !Number.isSafeInteger(payload.limit)) {
          throw new Error("memory broker search is unavailable");
        }
        return await builtinScopedMemoryAuthorizedRuntime.searchAuthorized({
          context,
          plan: readPlan(payload) as never,
          query: payload.query,
          limit: payload.limit,
          ...(Array.isArray(payload.sources) ? { sources: payload.sources as never } : {}),
          // The local broker aborts its controller when the Gateway connection closes or the
          // signed deadline elapses. Forward that lifecycle fence into the content runtime so
          // cancellation stops work rather than merely withholding the eventual response.
          signal,
        });
      }
      case "memory.read": {
        const context = readContentContext(payload.context);
        if (!payload.handle) {
          throw new Error("memory broker read is unavailable");
        }
        return await builtinScopedMemoryAuthorizedRuntime.readAuthorized({
          context,
          plan: readPlan(payload) as never,
          handle: payload.handle,
          ...(Number.isSafeInteger(payload.from) ? { from: payload.from } : {}),
          ...(Number.isSafeInteger(payload.lines) ? { lines: payload.lines } : {}),
        });
      }
      case "memory.virtual-view": {
        const context = readContentContext(payload.context);
        if (context.operation !== "read") {
          throw new Error("memory broker virtual view is unavailable");
        }
        return await builtinScopedMemoryVirtualView.materializeAuthorizedVirtualView({
          context,
          plan: readPlan(payload) as never,
        });
      }
      case "memory.virtual-file": {
        const context = readContentContext(payload.context);
        if (
          context.operation !== "read" ||
          !payload.view ||
          typeof payload.virtualPath !== "string"
        ) {
          throw new Error("memory broker virtual file is unavailable");
        }
        return await builtinScopedMemoryVirtualView.readAuthorizedVirtualFile({
          context,
          plan: readPlan(payload) as never,
          view: payload.view,
          virtualPath: payload.virtualPath,
        });
      }
      case "memory.write":
        if (!payload.mutation) {
          throw new Error("memory broker write is unavailable");
        }
        return await builtinScopedMemoryAuthorizedRuntime.writeAuthorized({
          context: payload.context,
          plan: readPlan(payload),
          mutation: payload.mutation,
        } as never);
      case "memory.import":
        if (!payload.mutation || payload.mutation.kind !== "import") {
          throw new Error("memory broker import is unavailable");
        }
        return await builtinScopedMemoryAuthorizedRuntime.importAuthorized({
          context: payload.context,
          plan: readPlan(payload),
          mutation: payload.mutation,
        } as never);
      case "memory.sync":
        return await builtinScopedMemoryAuthorizedRuntime.syncAuthorized({
          context: payload.context,
          plan: readPlan(payload),
        } as never);
      case "memory.export":
        if (!Array.isArray(payload.handles)) {
          throw new Error("memory broker export is unavailable");
        }
        return await builtinScopedMemoryAuthorizedRuntime.exportAuthorized({
          context: payload.context,
          plan: readPlan(payload),
          handles: payload.handles,
        } as never);
      case "memory.status":
        return await builtinScopedMemoryAuthorizedRuntime.statusAuthorized({
          context: payload.context,
          plan: readPlan(payload),
        } as never);
      default:
        throw new Error("memory broker operation is unavailable");
    }
  };
}
