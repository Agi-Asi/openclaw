import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import type { ChatProps } from "../chat-view.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import { deriveSubagentActivity } from "./chat-subagent-activity.ts";
import type { TaskDetailHost } from "./chat-task-detail-state.ts";
import { renderTaskDetailPanel } from "./chat-task-detail.ts";
import type { ChatTranscriptController } from "./chat-transcript-controller.ts";

function backgroundTasks(
  task: TaskSummary,
  options: {
    tasks?: TaskSummary[];
    onOpenTaskDetail?: (task: TaskSummary) => void;
    onNavigateToSession?: (sessionKey: string) => void;
  } = {},
): BackgroundTasksProps {
  return {
    sessionKey: "agent:main:main",
    statusRowId: "chat-tasks-status-test",
    collapsed: false,
    narrowLayout: false,
    connected: true,
    canCancel: false,
    loading: false,
    error: null,
    tasks: options.tasks ?? [task],
    subagentActivity: deriveSubagentActivity({
      tasks: [],
      sessionKey: "agent:main:main",
      terminalObservedAtByTask: new Map(),
      canonicalizeSessionKey: (sessionKey) => sessionKey ?? "",
    }),
    taskDetails: new Map([[task.id, { ...task, prompt: "Inspect the current task." }]]),
    taskDetailErrors: new Map(),
    taskDetailLoadingIds: new Set(),
    cancellingTaskIds: new Set(),
    finishedCollapsed: false,
    onToggleCollapsed: () => undefined,
    onToggleFinished: () => undefined,
    onRefresh: () => undefined,
    onCancel: () => undefined,
    ...(options.onOpenTaskDetail ? { onOpenTaskDetail: options.onOpenTaskDetail } : {}),
    ...(options.onNavigateToSession ? { onNavigateToSession: options.onNavigateToSession } : {}),
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("task detail panel", () => {
  it("uses the inspector for the pane's canonical session and identifies the runtime", () => {
    const task: TaskSummary = {
      id: "task-cli",
      taskId: "task-cli",
      status: "completed",
      runtime: "cli",
      agentId: "main",
      title: "Current-session command",
      sessionKey: "agent:main:main",
      terminalSummary: "Command complete",
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const request = vi.fn();
    const host: TaskDetailHost = {
      sessionKey: "main",
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      hello: null,
    };
    const container = document.createElement("div");
    document.body.append(container);

    render(
      html`${renderTaskDetailPanel({
        backgroundTasks: backgroundTasks(task),
        chat: { paneId: "pane-1" } as ChatProps,
        host,
        task,
        transcript: {} as ChatTranscriptController,
      })}`,
      container,
    );

    const panel = container.querySelector("[data-task-detail-panel]");
    expect(panel?.textContent).toContain("Current-session command");
    expect(panel?.textContent).toContain("CLI");
    expect(panel?.textContent).toContain("Inspect the current task.");
    expect(panel?.textContent).toContain("Command complete");
    expect(panel?.textContent).not.toContain("Loading task transcript");
    expect(request).not.toHaveBeenCalled();
  });

  it("never treats a subagent's requester session as its transcript", () => {
    const task: TaskSummary = {
      id: "task-queued-subagent",
      taskId: "task-queued-subagent",
      status: "queued",
      runtime: "subagent",
      agentId: "main",
      title: "Queued child work",
      // Requester is another conversation; no child session exists yet.
      sessionKey: "agent:main:other-session",
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const request = vi.fn();
    const host: TaskDetailHost = {
      sessionKey: "main",
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      hello: null,
    };
    const container = document.createElement("div");
    document.body.append(container);

    render(
      html`${renderTaskDetailPanel({
        backgroundTasks: backgroundTasks(task),
        chat: { paneId: "pane-1" } as ChatProps,
        host,
        task,
        transcript: {} as ChatTranscriptController,
      })}`,
      container,
    );

    const panel = container.querySelector("[data-task-detail-panel]");
    expect(panel?.textContent).toContain("Inspect the current task.");
    expect(panel?.textContent).not.toContain("Loading task transcript");
    expect(request).not.toHaveBeenCalled();
  });

  it("explains authoritative queue blockers and opens a named blocker", () => {
    const blocker: TaskSummary = {
      id: "task-running",
      taskId: "task-running",
      status: "running",
      runtime: "cli",
      title: "Build release assets",
      createdAt: 1_000,
      startedAt: 1_200,
      updatedAt: 2_000,
    };
    const task: TaskSummary = {
      id: "task-waiting",
      taskId: "task-waiting",
      status: "queued",
      runtime: "subagent",
      title: "Publish the release",
      createdAt: 1_000,
      updatedAt: 2_000,
      queueWait: {
        since: 1_500,
        queuedAhead: 2,
        busySlots: 3,
        capacity: 4,
        activeBlockers: [{ taskId: blocker.id, title: blocker.title ?? "Running task" }],
        aheadBlockers: [{ taskId: "task-ahead", title: "Run checks" }],
      },
    };
    const onOpenTaskDetail = vi.fn();
    const host: TaskDetailHost = {
      sessionKey: "main",
      client: { request: vi.fn() } as unknown as GatewayBrowserClient,
      connected: true,
      hello: null,
    };
    const container = document.createElement("div");
    document.body.append(container);

    render(
      html`${renderTaskDetailPanel({
        backgroundTasks: backgroundTasks(task, {
          tasks: [task, blocker],
          onOpenTaskDetail,
        }),
        chat: { paneId: "pane-1" } as ChatProps,
        host,
        task,
        transcript: {} as ChatTranscriptController,
      })}`,
      container,
    );

    const panel = container.querySelector("[data-task-detail-panel]");
    expect(panel?.textContent).toContain("Waiting for");
    expect(panel?.textContent).toContain("Execution slots occupied · 3/4");
    expect(panel?.textContent).toContain("Tasks ahead · 2");
    expect(panel?.textContent).toContain("+2 more");
    expect(panel?.textContent).toContain("+1 more");
    panel?.querySelector<HTMLButtonElement>(".chat-task-detail__wait-blocker")?.click();
    expect(onOpenTaskDetail).toHaveBeenCalledWith(blocker);
  });

  it("navigates to a cross-session blocker that is not in the scoped task list", () => {
    const task: TaskSummary = {
      id: "task-waiting-cross-session",
      taskId: "task-waiting-cross-session",
      status: "queued",
      runtime: "cron",
      title: "Publish the release",
      createdAt: 1_000,
      updatedAt: 2_000,
      queueWait: {
        since: 1_500,
        queuedAhead: 0,
        busySlots: 1,
        capacity: 1,
        activeBlockers: [
          {
            taskId: "task-in-another-session",
            title: "Build release assets",
            sessionKey: "agent:main:other-session",
          },
        ],
        aheadBlockers: [],
      },
    };
    const onNavigateToSession = vi.fn();
    const host: TaskDetailHost = {
      sessionKey: "main",
      client: { request: vi.fn() } as unknown as GatewayBrowserClient,
      connected: true,
      hello: null,
    };
    const container = document.createElement("div");
    document.body.append(container);

    render(
      html`${renderTaskDetailPanel({
        backgroundTasks: backgroundTasks(task, { onNavigateToSession }),
        chat: { paneId: "pane-1" } as ChatProps,
        host,
        task,
        transcript: {} as ChatTranscriptController,
      })}`,
      container,
    );

    container.querySelector<HTMLButtonElement>(".chat-task-detail__wait-blocker")?.click();
    expect(onNavigateToSession).toHaveBeenCalledWith("agent:main:other-session");
  });
});
