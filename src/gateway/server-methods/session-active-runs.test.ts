// Tests gateway active-run matching by logical session key and backing id.
import { expect, it } from "vitest";
import type { EmbeddedAgentQueueHandle } from "../../agents/embedded-agent-runner/run-state.js";
import {
  abortEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunActive,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import {
  buildProjectedAgentRunIndex,
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import type { CommandQueueWorkProjection } from "../../process/command-queue.js";
import {
  collectTrackedActiveSessionRuns,
  hasRegisteredChatRunForSessionKey,
  hasTrackedActiveSessionRun,
  resolveVisibleActiveSessionRunState,
} from "./session-active-runs.js";

function queueProjection(
  params: {
    waits?: CommandQueueWorkProjection["waits"];
    revisionByWorkId?: CommandQueueWorkProjection["revisionByWorkId"];
  } = {},
): CommandQueueWorkProjection {
  return {
    epoch: "test-queue",
    waits: params.waits ?? new Map(),
    revisionByWorkId: params.revisionByWorkId ?? new Map(),
  };
}

it("keeps prebuilt active-run indexes in parity with per-row scans", () => {
  const context = {
    chatAbortControllers: new Map([
      ["run-main", { sessionKey: "agent:main:main", sessionId: "session-main" }],
      ["run-global", { sessionKey: "global", agentId: "work" }],
      ["run-hidden", { sessionKey: "agent:main:hidden", projectSessionActive: false }],
    ]),
  } as never;
  registerAgentRunContext("projected-key", {
    projectSessionActive: true,
    sessionKey: "agent:main:projected",
  });
  registerAgentRunContext("projected-id", {
    projectSessionActive: true,
    agentId: "main",
    sessionId: "session-projected",
  });
  try {
    const trackedActiveRuns = collectTrackedActiveSessionRuns(context);
    const projectedAgentRunIndex = buildProjectedAgentRunIndex();
    const cases = [
      { requestedKey: "agent:main:main", canonicalKey: "agent:main:main" },
      { requestedKey: "agent:main:projected", canonicalKey: "agent:main:projected" },
      {
        requestedKey: "agent:main:by-id",
        canonicalKey: "agent:main:by-id",
        sessionId: "session-projected",
      },
      {
        requestedKey: "global",
        canonicalKey: "global",
        agentId: "work",
        defaultAgentId: "main",
      },
      { requestedKey: "agent:main:missing", canonicalKey: "agent:main:missing" },
    ];
    for (const activeCase of cases) {
      expect(
        resolveVisibleActiveSessionRunState({
          context,
          ...activeCase,
          trackedActiveRuns,
          projectedAgentRunIndex,
        }),
      ).toEqual(resolveVisibleActiveSessionRunState({ context, ...activeCase }));
    }
  } finally {
    clearAgentRunContext("projected-key");
    clearAgentRunContext("projected-id");
  }
});

it("matches session-id-only gateway runs during archive admission", () => {
  const context = {
    chatAbortControllers: new Map([
      [
        "run-1",
        {
          sessionId: "session-1",
          controlUiVisible: true,
          projectSessionActive: true,
        },
      ],
    ]),
  } as never;

  expect(
    resolveVisibleActiveSessionRunState({
      context,
      requestedKey: "agent:main:child",
      canonicalKey: "agent:main:child",
      sessionId: "session-1",
      defaultAgentId: "main",
    }).active,
  ).toBe(true);
});

it("excludes the replacement run from an internal active-session check", () => {
  const sessionKey = "agent:main:main";
  const context = {
    chatAbortControllers: new Map([
      [
        "replacement-run",
        {
          sessionKey,
          controlUiVisible: true,
          projectSessionActive: true,
        },
      ],
    ]),
  } as never;

  expect(
    hasTrackedActiveSessionRun({
      context,
      requestedKey: sessionKey,
      canonicalKey: sessionKey,
      excludeRunIds: new Set(["replacement-run"]),
    }),
  ).toBe(false);
  expect(
    hasTrackedActiveSessionRun({
      context,
      requestedKey: sessionKey,
      canonicalKey: sessionKey,
    }),
  ).toBe(true);
});

it("returns deterministic visible run ids for the selected session", () => {
  const context = {
    chatAbortControllers: new Map([
      ["run-z", { sessionKey: "main" }],
      ["run-hidden", { sessionKey: "main", controlUiVisible: false }],
      ["run-other", { sessionKey: "other" }],
      ["run-a", { sessionKey: "main" }],
    ]),
  } as never;

  expect(
    resolveVisibleActiveSessionRunState({
      context,
      requestedKey: "main",
      canonicalKey: "main",
      agentId: "main",
      defaultAgentId: "main",
    }),
  ).toEqual({ active: true, runIds: ["run-a", "run-z"] });
});

it("projects a queued visible run without exposing its work identity", () => {
  const context = {
    chatAbortControllers: new Map([
      ["run-queued", { sessionKey: "agent:main:queued", taskId: "task-queued" }],
    ]),
  } as never;
  const projection = queueProjection({
    waits: new Map([
      [
        "task-queued",
        {
          lane: "main",
          since: 1_000,
          queuedAhead: 2,
          busySlots: 4,
          capacity: 4,
          blockedBy: "group-budget",
          revision: 7,
          queuedAheadWorkIds: ["private-ahead"],
          activeWorkIds: ["private-active"],
        },
      ],
    ]),
    revisionByWorkId: new Map([["task-queued", 7]]),
  });

  expect(
    resolveVisibleActiveSessionRunState({
      context,
      requestedKey: "agent:main:queued",
      canonicalKey: "agent:main:queued",
      queueProjection: projection,
    }),
  ).toEqual({
    active: true,
    runIds: ["run-queued"],
    runActivity: {
      state: "waiting",
      since: 1_000,
      queueWait: {
        queuedAhead: 2,
        busySlots: 4,
        capacity: 4,
        blockedBy: "group-budget",
      },
    },
  });
});

it("prefers working when one of several visible runs has been admitted", () => {
  const context = {
    chatAbortControllers: new Map([
      ["run-waiting", { sessionKey: "agent:main:busy" }],
      ["run-working", { sessionKey: "agent:main:busy" }],
    ]),
  } as never;
  const projection = queueProjection({
    waits: new Map([
      [
        "run-waiting",
        {
          lane: "main",
          since: 1_000,
          queuedAhead: 0,
          busySlots: 1,
          capacity: 1,
          blockedBy: "lane",
          revision: 2,
          queuedAheadWorkIds: [],
          activeWorkIds: ["run-working"],
        },
      ],
    ]),
    revisionByWorkId: new Map([
      ["run-waiting", 2],
      ["run-working", 2],
    ]),
  });

  expect(
    resolveVisibleActiveSessionRunState({
      context,
      requestedKey: "agent:main:busy",
      canonicalKey: "agent:main:busy",
      queueProjection: projection,
    }).runActivity,
  ).toEqual({ state: "working" });
});

it("projects a lifecycle-owned worker run without widening event visibility", () => {
  registerAgentRunContext("worker-run", {
    isControlUiVisible: false,
    projectSessionActive: true,
    sessionId: "worker-session",
    sessionKey: "agent:main:worker",
  });
  try {
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: "agent:main:worker",
        canonicalKey: "agent:main:worker",
        sessionId: "worker-session",
      }),
    ).toEqual({ active: true, runIds: [] });
  } finally {
    clearAgentRunContext("worker-run");
  }
});

it("does not project a terminal reply operation retained for settlement as active", () => {
  const sessionKey = "agent:main:reply-settling";
  const sessionId = "reply-settling-session";
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  const replacementHandle: EmbeddedAgentQueueHandle = {
    abort: () => undefined,
    isAborted: () => false,
    isCompacting: () => false,
    isStreaming: () => true,
    queueMessage: async () => undefined,
  };
  try {
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
      }),
    ).toEqual({ active: true, runIds: [] });

    operation.setPhase("running");
    expect(operation.abortByUser()).toBe(true);
    expect(isEmbeddedAgentRunActive(sessionId)).toBe(true);
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
      }),
    ).toEqual({ active: false, runIds: [] });

    setActiveEmbeddedRun(sessionId, replacementHandle, sessionKey);
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
      }),
    ).toEqual({ active: true, runIds: [] });
  } finally {
    clearActiveEmbeddedRun(sessionId, replacementHandle, sessionKey);
    operation.complete();
  }
});

it("preserves an independent lifecycle-owned worker while a reply operation settles", () => {
  const sessionKey = "agent:main:worker-overlap";
  const sessionId = "worker-overlap-session";
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  registerAgentRunContext("worker-overlap-run", {
    projectSessionActive: true,
    sessionId,
    sessionKey,
  });
  try {
    expect(operation.abortByUser()).toBe(true);
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
      }),
    ).toEqual({ active: true, runIds: [] });
  } finally {
    operation.complete();
    clearAgentRunContext("worker-overlap-run");
  }
});

it("prefers working when a lifecycle-owned worker overlaps a queued gateway run", () => {
  const sessionKey = "agent:main:worker-and-queue";
  const sessionId = "worker-and-queue-session";
  registerAgentRunContext("worker-and-queue-run", {
    projectSessionActive: true,
    sessionId,
    sessionKey,
  });
  try {
    expect(
      resolveVisibleActiveSessionRunState({
        context: {
          chatAbortControllers: new Map([
            ["queued-run", { sessionId, sessionKey, taskId: "queued-task" }],
          ]),
        } as never,
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
        queueProjection: queueProjection({
          waits: new Map([
            [
              "queued-task",
              {
                lane: "main",
                since: 1_000,
                queuedAhead: 1,
                busySlots: 1,
                capacity: 1,
                revision: 2,
                queuedAheadWorkIds: ["worker-and-queue-run"],
                activeWorkIds: ["worker-and-queue-run"],
              },
            ],
          ]),
        }),
      }).runActivity,
    ).toEqual({ state: "working" });
  } finally {
    clearAgentRunContext("worker-and-queue-run");
  }
});

it("prefers working when an embedded handle overlaps a queued gateway run", () => {
  const sessionKey = "agent:main:embedded-and-queue";
  const sessionId = "embedded-and-queue-session";
  const handle: EmbeddedAgentQueueHandle = {
    abort: () => undefined,
    isAborted: () => false,
    isCompacting: () => false,
    isStreaming: () => true,
    queueMessage: async () => undefined,
  };
  setActiveEmbeddedRun(sessionId, handle, sessionKey);
  try {
    expect(
      resolveVisibleActiveSessionRunState({
        context: {
          chatAbortControllers: new Map([
            ["queued-run", { sessionId, sessionKey, taskId: "queued-task" }],
          ]),
        } as never,
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
        queueProjection: queueProjection({
          waits: new Map([
            [
              "queued-task",
              {
                lane: "main",
                since: 1_000,
                queuedAhead: 0,
                busySlots: 1,
                capacity: 1,
                revision: 2,
                queuedAheadWorkIds: [],
                activeWorkIds: ["embedded-run"],
              },
            ],
          ]),
        }),
      }).runActivity,
    ).toEqual({ state: "working" });
  } finally {
    clearActiveEmbeddedRun(sessionId, handle, sessionKey);
  }
});

it("does not project an aborted embedded handle retained for cleanup as active", () => {
  const sessionKey = "agent:main:handle-settling";
  const sessionId = "handle-settling-session";
  let aborted = false;
  const handle: EmbeddedAgentQueueHandle = {
    abort: () => {
      aborted = true;
    },
    isAborted: () => aborted,
    isCompacting: () => false,
    // Prompt completion closes steering before post-turn finalization. That
    // state alone must not make a normally finishing run disappear.
    isStopped: () => true,
    isStreaming: () => false,
    queueMessage: async () => undefined,
  };
  setActiveEmbeddedRun(sessionId, handle, sessionKey);
  try {
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
      }),
    ).toEqual({ active: true, runIds: [] });

    expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
    expect(isEmbeddedAgentRunActive(sessionId)).toBe(true);
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
      }),
    ).toEqual({ active: false, runIds: [] });

    expect(
      resolveVisibleActiveSessionRunState({
        context: {
          chatAbortControllers: new Map([["new-run", { sessionId, sessionKey }]]),
        } as never,
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
      }),
    ).toEqual({ active: true, runIds: ["new-run"] });
  } finally {
    clearActiveEmbeddedRun(sessionId, handle, sessionKey);
  }
});

it("counts settled but still registered chat runs for a session key", () => {
  const context = {
    chatAbortControllers: new Map([
      [
        "run-finalizing",
        {
          sessionKey: "agent:main:main",
          sessionId: "session-main",
          projectSessionActive: false,
          controlUiVisible: false,
        },
      ],
      ["run-global-work", { sessionKey: "global", agentId: "work" }],
    ]),
  } as never;

  expect(
    hasRegisteredChatRunForSessionKey({
      context,
      sessionKey: "agent:main:main",
      agentId: undefined,
    }),
  ).toBe(true);
  expect(
    hasRegisteredChatRunForSessionKey({
      context,
      sessionKey: "agent:other:other",
      agentId: undefined,
    }),
  ).toBe(false);
  expect(
    hasRegisteredChatRunForSessionKey({ context, sessionKey: "global", agentId: "work" }),
  ).toBe(true);
  expect(
    hasRegisteredChatRunForSessionKey({ context, sessionKey: "global", agentId: "other" }),
  ).toBe(false);
  expect(
    hasRegisteredChatRunForSessionKey({ context, sessionKey: "global", agentId: undefined }),
  ).toBe(false);
  expect(
    hasRegisteredChatRunForSessionKey({
      context: {},
      sessionKey: "agent:main:main",
      agentId: undefined,
    }),
  ).toBe(false);
});

it("matches colliding bare active runs by stable owner", () => {
  const context = {
    chatAbortControllers: new Map([
      ["run-ownerless", { sessionKey: "incident-42" }],
      ["run-research", { sessionKey: "incident-42", agentId: "research" }],
    ]),
  } as never;

  expect(
    resolveVisibleActiveSessionRunState({
      context,
      requestedKey: "incident-42",
      canonicalKey: "incident-42",
      agentId: "ops",
      defaultAgentId: "ops",
    }),
  ).toEqual({ active: true, runIds: ["run-ownerless"] });
  expect(
    resolveVisibleActiveSessionRunState({
      context,
      requestedKey: "incident-42",
      canonicalKey: "incident-42",
      agentId: "research",
      defaultAgentId: "ops",
    }),
  ).toEqual({ active: true, runIds: ["run-research"] });
});

it("keeps projected bare runs agent-scoped", () => {
  registerAgentRunContext("projected-ops", {
    projectSessionActive: true,
    sessionKey: "incident-42",
    sessionId: "shared-id",
    agentId: "ops",
  });
  try {
    const index = buildProjectedAgentRunIndex();
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: "incident-42",
        canonicalKey: "incident-42",
        sessionId: "shared-id",
        agentId: "research",
        projectedAgentRunIndex: index,
      }).active,
    ).toBe(false);
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: "incident-42",
        canonicalKey: "incident-42",
        sessionId: "shared-id",
        agentId: "ops",
        projectedAgentRunIndex: index,
      }).active,
    ).toBe(true);
  } finally {
    clearAgentRunContext("projected-ops");
  }
});

it("resolves projected ownerless bare runs through the stable default owner", () => {
  registerAgentRunContext("projected-ownerless", {
    projectSessionActive: true,
    sessionKey: "incident-42",
    sessionId: "ownerless-id",
  });
  try {
    const index = buildProjectedAgentRunIndex();
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: "incident-42",
        canonicalKey: "incident-42",
        sessionId: "ownerless-id",
        agentId: "ops",
        defaultAgentId: "ops",
        projectedAgentRunIndex: index,
      }).active,
    ).toBe(true);
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: "incident-42",
        canonicalKey: "incident-42",
        sessionId: "ownerless-id",
        agentId: "research",
        defaultAgentId: "ops",
        projectedAgentRunIndex: index,
      }).active,
    ).toBe(false);
  } finally {
    clearAgentRunContext("projected-ownerless");
  }
});
