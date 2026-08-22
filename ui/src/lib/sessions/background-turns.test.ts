import { describe, expect, it, vi } from "vitest";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { SessionBackgroundTurnOutcome } from "./background-turn-contract.ts";
import { createSessionBackgroundTurns } from "./background-turns.runtime.ts";
import type { SessionCreateOutcome } from "./create.ts";

function chatTerminal(params: {
  runId: string;
  sessionKey: string;
  state: "aborted" | "error" | "final";
  errorKind?: "timeout";
  errorMessage?: string;
  yielded?: true;
}): GatewayEventFrame {
  return {
    type: "event",
    event: "chat",
    payload: {
      seq: 1,
      ...params,
    },
  };
}

describe("session background turns", () => {
  it("matches a terminal event that arrives before sessions.create responds", async () => {
    let resolveCreate!: (result: SessionCreateOutcome) => void;
    const create = vi.fn(
      () =>
        new Promise<SessionCreateOutcome>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const tracker = createSessionBackgroundTurns(create);
    const outcomes: SessionBackgroundTurnOutcome[] = [];
    tracker.subscribe((outcome) => outcomes.push(outcome));

    const created = tracker.create({ agentId: "main", message: "Inspect this." });
    tracker.observe(
      chatTerminal({
        runId: "run-background",
        sessionKey: "agent:main:dashboard:background",
        state: "final",
      }),
    );
    resolveCreate({
      key: "agent:main:dashboard:background",
      initialRun: { status: "started", runId: "run-background" },
    });

    await expect(created).resolves.toMatchObject({
      key: "agent:main:dashboard:background",
    });
    expect(outcomes).toEqual([
      {
        agentId: "main",
        key: "agent:main:dashboard:background",
        runId: "run-background",
        status: "completed",
      },
    ]);
  });

  it("ignores unrelated and yielded terminals, then consumes the exact run once", async () => {
    const tracker = createSessionBackgroundTurns(async () => ({
      key: "agent:main:dashboard:background",
      initialRun: { status: "started", runId: "run-background" },
    }));
    const listener = vi.fn();
    tracker.subscribe(listener);
    await tracker.create({ agentId: "main", message: "Inspect this." });

    tracker.observe(
      chatTerminal({
        runId: "run-other",
        sessionKey: "agent:main:dashboard:background",
        state: "final",
      }),
    );
    tracker.observe(
      chatTerminal({
        runId: "run-background",
        sessionKey: "agent:main:dashboard:background",
        state: "final",
        yielded: true,
      }),
    );
    tracker.observe(
      chatTerminal({
        runId: "run-background",
        sessionKey: "agent:main:dashboard:background",
        state: "error",
        errorKind: "timeout",
        errorMessage: "Model timed out",
      }),
    );
    tracker.observe(
      chatTerminal({
        runId: "run-background",
        sessionKey: "agent:main:dashboard:background",
        state: "final",
      }),
    );

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      agentId: "main",
      errorKind: "timeout",
      errorMessage: "Model timed out",
      key: "agent:main:dashboard:background",
      runId: "run-background",
      status: "error",
    });
  });

  it.each([
    {
      initialRun: { status: "idle" as const },
      expected: { status: "initial-turn-idle" },
    },
    {
      initialRun: { status: "rejected" as const, error: "No model available" },
      expected: {
        status: "initial-turn-rejected",
        errorMessage: "No model available",
      },
    },
  ])("reports a visible $initialRun.status outcome", async ({ initialRun, expected }) => {
    const tracker = createSessionBackgroundTurns(async () => ({
      key: "agent:main:dashboard:background",
      initialRun,
    }));
    const listener = vi.fn();
    tracker.subscribe(listener);

    await tracker.create({ agentId: "main", message: "Inspect this." });

    expect(listener).toHaveBeenCalledWith({
      agentId: "main",
      key: "agent:main:dashboard:background",
      ...expected,
    });
  });

  it("reports connection replacement without inferring a later completion", async () => {
    const tracker = createSessionBackgroundTurns(async () => ({
      key: "agent:main:dashboard:background",
      initialRun: { status: "started", runId: "run-background" },
    }));
    const listener = vi.fn();
    tracker.subscribe(listener);
    await tracker.create({ agentId: "main", message: "Inspect this." });

    tracker.interrupt();
    tracker.observe(
      chatTerminal({
        runId: "run-background",
        sessionKey: "agent:main:dashboard:background",
        state: "final",
      }),
    );

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      agentId: "main",
      key: "agent:main:dashboard:background",
      runId: "run-background",
      status: "tracking-interrupted",
      reason: "connection-replaced",
    });
  });
});
