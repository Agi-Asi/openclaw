import { html, nothing, render } from "lit";
import type { GatewayAgentRow, ModelCatalogEntry, SessionsListResult } from "../api/types.ts";
import { loadSettings, patchSettings } from "../app/settings.ts";
import "../components/web-awesome.ts";
import "../components/web-awesome-popover.ts";
import "../components/tooltip.ts";
import { i18n, t } from "../i18n/index.ts";
import {
  buildFallbackSlashCommands,
  replaceSlashCommands,
  type SlashCommandDef,
} from "../lib/chat/commands.ts";
import type { ChatAttachment, ChatQueueItem } from "../lib/chat/chat-types.ts";
import type { TaskSummary } from "../lib/tasks/task-summary.ts";
import type { SessionToolOverrides } from "../lib/sessions/patch.ts";
import { renderExecApprovalCard } from "../components/exec-approval-card.ts";
import { renderBackgroundTasksStatusRow } from "../pages/chat/components/chat-background-tasks-status.ts";
import { renderChatComposer, resetChatComposerState } from "../pages/chat/components/chat-composer.ts";
import { getChatComposerState } from "../pages/chat/components/chat-composer-state.ts";
import type { ComposerDictationController } from "../pages/chat/composer-dictation.ts";
import { renderChatModelControls } from "../pages/chat/components/chat-model-controls.ts";
import { renderChatPermissionPicker } from "../pages/chat/components/chat-permission-picker.ts";
import { renderChatPullRequests } from "../pages/chat/components/chat-pull-requests.ts";
import { renderChatSessionSuggestions } from "../pages/chat/components/chat-session-suggestions.ts";
import { renderWelcomeState } from "../pages/chat/components/chat-welcome.ts";
import { renderChatViewNotices } from "../pages/chat/chat-view-notices.ts";
import { RealtimeTalkLevelSignal } from "../pages/chat/realtime-talk-level.ts";
import { NewSessionAttachmentDraft } from "../pages/new-session/attachment-draft.ts";
import { renderBar as renderNewSessionTargetBar } from "../pages/new-session/catalog-target.ts";
import {
  NewSessionComposerTextareaController,
  renderDraftError,
  renderNewSessionDraftComposer,
} from "../pages/new-session/composer.ts";
import { renderDetailChip, resolveDetailChip } from "../pages/new-session/detail-chip.ts";
import {
  renderNewSessionIncognitoControl,
  renderNewSessionIncognitoNotice,
} from "../pages/new-session/incognito-control.ts";
import type { NewSessionModelControl } from "../pages/new-session/model-control.ts";
import { renderProjectChip, resolveProjectChip } from "../pages/new-session/project-chip.ts";
import { renderAgentSelect } from "../pages/new-session/target-controls.ts";
import { renderWhereChip, resolveWhereChip } from "../pages/new-session/where-chip.ts";
import "../styles.css";
import "../styles/chat.css";
import "../styles/new-session.css";

type BenchState = {
  surface: "chat" | "new";
  visibility: "normal" | "draft" | "incognito";
  queue: "none" | "one" | "three" | "six";
  queueOrder: string[];
  queueEdit: "closed" | "editing";
  queueEditingId: string | null;
  queueEditingText: string;
  queueTexts: Record<string, string>;
  queueState:
    | "ready"
    | "waiting-model"
    | "waiting-idle"
    | "executing-command"
    | "waiting-reconnect"
    | "unconfirmed"
    | "failed";
  queueRow: "text" | "attachments" | "command" | "member" | "run-attached";
  run: "idle" | "running" | "steering" | "approval" | "interrupted";
  access: "normal" | "members" | "read-only";
  followUpMode: "queue" | "steer" | "collect" | "interrupt";
  tasks: "none" | "one" | "three";
  plan: "none" | "active" | "complete";
  inset:
    | "none"
    | "reply"
    | "progress"
    | "goal"
    | "compaction"
    | "fallback"
    | "banner-archived"
    | "banner-restart"
    | "banner-model"
    | "question";
  permission: "default" | "read-only" | "guarded" | "workspace" | "full";
  usage: "context" | "plan";
  model: "default" | "opus" | "gpt";
  reasoning: "default" | "off" | "low" | "medium" | "high";
  fastMode: "off" | "on";
  capabilities: "attachments" | "available" | "overrides";
  toolOverrides: SessionToolOverrides | null;
  voice:
    | "off"
    | "connecting"
    | "listening"
    | "thinking"
    | "camera"
    | "camera-pending"
    | "camera-error"
    | "error";
  dictate: "off" | "connecting" | "recording" | "finalizing";
  voiceInput:
    | "available"
    | "unsupported"
    | "none"
    | "permission"
    | "busy"
    | "inactive"
    | "failed";
  content: "empty" | "one" | "multiline" | "skill-inline" | "skill-inline-mobile" | "giant";
  attachments: "none" | "image" | "annotation" | "mixed";
  menu: "closed" | "slash" | "skills";
  plusMenuOpen: boolean;
  status: "focused" | "sending" | "disabled" | "catalog" | "error" | "offline";
  newAction:
    | "start"
    | "terminal"
    | "blocked"
    | "locked"
    | "invalid-worktree"
    | "outcome-unknown"
    | "placement-interrupted"
    | "catalog";
  neighbor:
    | "none"
    | "approval"
    | "session-suggestion"
    | "pull-request"
    | "disk-warning"
    | "disk-critical"
    | "workspace-conflict"
    | "placement"
    | "placement-failed"
    | "error";
  width: number;
  theme: "dark" | "light";
};

const defaultQueueOrder = [
  "bench-queue-1",
  "bench-queue-2",
  "bench-queue-3",
  "bench-queue-4",
  "bench-queue-5",
  "bench-queue-6",
];
const queueSeed = [
  "Audit the composer spacing against the desktop reference.",
  "Keep the queue attached to the composer in both themes.",
  "Verify keyboard reordering before the final visual pass.",
  "Confirm the permission picker keeps its active state.",
  "Check the attachment rail at narrow widths.",
  "Capture the final queue interaction pass.",
];
const defaultQueueTexts = Object.fromEntries(
  defaultQueueOrder.map((id, index) => [id, queueSeed[index] ?? ""]),
);
const defaults: BenchState = {
  surface: "chat",
  visibility: "normal",
  queue: "none",
  queueOrder: defaultQueueOrder,
  queueEdit: "closed",
  queueEditingId: null,
  queueEditingText: "",
  queueTexts: defaultQueueTexts,
  queueState: "ready",
  queueRow: "text",
  run: "idle",
  access: "normal",
  followUpMode: "queue",
  tasks: "none",
  plan: "none",
  inset: "none",
  permission: "default",
  usage: "context",
  model: "default",
  reasoning: "default",
  fastMode: "off",
  capabilities: "attachments",
  toolOverrides: null,
  voice: "off",
  dictate: "off",
  voiceInput: "available",
  content: "multiline",
  attachments: "none",
  menu: "closed",
  plusMenuOpen: false,
  status: "focused",
  newAction: "start",
  neighbor: "none",
  width: 1200,
  theme: "dark",
};

const content: Record<BenchState["content"], string> = {
  empty: "",
  one: "Tailor the composer spacing.",
  multiline: "Tailor the composer spacing.\nKeep the controls aligned.\nPreserve the real send flow.",
  "skill-inline":
    "Tailor the composer spacing with deliberate care across every footer control before using $bench_skill_05 to finish the final visual pass and re-check the complete send flow.",
  "skill-inline-mobile":
    "Review with $bench_skill_05 before checking the send flow again on a compact mobile surface.",
  giant: Array.from(
    { length: 18 },
    (_, index) => `Line ${index + 1}: inspect wrapping, internal scroll, and footer stability.`,
  ).join("\n"),
};

function seededDraft(
  contentKey: BenchState["content"],
  menu: BenchState["menu"],
): string {
  if (menu === "slash") return "/";
  if (menu === "skills") {
    return contentKey === "one" ? "Use $bench_skill_0" : "Use $bench_";
  }
  return content[contentKey];
}

const imageAttachment: ChatAttachment = {
  id: "bench-image",
  mimeType: "image/svg+xml",
  fileName: "composer-reference.svg",
  dataUrl:
    "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect width='100' height='100' rx='18' fill='%234d7cff'/%3E%3C/svg%3E",
};
const annotationAttachment: ChatAttachment = {
  ...imageAttachment,
  id: "bench-browser-annotation",
  fileName: "composer-browser-annotation.svg",
  browserAnnotation: {
    modelContext: "Inspect the marked composer footer alignment.",
    title: "Composer footer",
    displayUrl: "openclaw.local/chat",
    markedRegionCount: 2,
    inspectedElement: true,
  },
};
const mixedAttachments: ChatAttachment[] = [
  imageAttachment,
  { id: "bench-pdf", mimeType: "application/pdf", fileName: "composer-notes.pdf" },
  { id: "bench-text", mimeType: "text/markdown", fileName: "composer-notes.md" },
  { id: "bench-video", mimeType: "video/mp4", fileName: "interaction-pass.mp4" },
  { id: "bench-audio", mimeType: "audio/mpeg", fileName: "reference-audio.mp3" },
  { id: "bench-archive", mimeType: "application/zip", fileName: "reference-files.zip" },
  {
    id: "bench-word",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileName: "composer-interface-review-notes-final-approved-version.docx",
  },
  {
    id: "bench-spreadsheet",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileName: "composer-audit.xlsx",
  },
  {
    id: "bench-presentation",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    fileName: "composer-review.pptx",
  },
];
const taskSeed = [
  "Inspect composer ownership",
  "Compare narrow footer spacing",
  "Review queued-message order",
];
const modelCatalog: ModelCatalogEntry[] = [
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    provider: "openai",
    available: true,
    contextWindow: 1_000_000,
    reasoning: true,
    thinkingDefault: "medium",
    thinkingLevels: ["off", "low", "medium", "high"].map((level) => ({ id: level, label: level })),
  },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider: "openai",
    available: true,
    contextWindow: 1_000_000,
    reasoning: true,
    thinkingDefault: "medium",
    thinkingLevels: ["off", "low", "medium", "high"].map((level) => ({ id: level, label: level })),
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    provider: "openai",
    available: true,
    contextWindow: 1_000_000,
    reasoning: true,
    thinkingDefault: "medium",
    thinkingLevels: ["off", "low", "medium", "high"].map((level) => ({ id: level, label: level })),
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    provider: "anthropic",
    available: true,
    thinkingDefault: "medium",
    thinkingLevels: ["off", "low", "medium", "high"].map((level) => ({ id: level, label: level })),
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    provider: "moonshot",
    available: true,
    contextWindow: 1_048_576,
    reasoning: true,
    thinkingDefault: "medium",
    thinkingLevels: ["off", "low", "medium", "high"].map((level) => ({ id: level, label: level })),
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    provider: "deepseek",
    available: true,
    contextWindow: 1_000_000,
    reasoning: true,
    thinkingDefault: "medium",
    thinkingLevels: ["off", "low", "medium", "high"].map((level) => ({ id: level, label: level })),
  },
];
const skillCommands: SlashCommandDef[] = Array.from({ length: 40 }, (_, index) => ({
  key: `bench-skill-${index + 1}`,
  name: `bench_skill_${String(index + 1).padStart(2, "0")}`,
  description: `Composer bench skill ${index + 1}`,
  category: "tools",
  source: "skill",
  skillDisplayName: `Bench Skill ${String(index + 1).padStart(2, "0")}`,
  skillModelVisible: true,
  tier: "standard",
}));
const newSessionAgents: GatewayAgentRow[] = [
  {
    id: "roboclaw",
    name: "Roboclaw",
    identity: { name: "Roboclaw", emoji: "🤖" },
    workspace: "/workspace/openclaw",
    workspaceGit: true,
  },
  {
    id: "reviewer",
    name: "Review Bot",
    identity: { name: "Review Bot", emoji: "🔎" },
    workspace: "/workspace/openclaw",
    workspaceGit: true,
  },
];
const newSessionProjects = [
  {
    id: "openclaw",
    displayName: "openclaw",
    repoRoot: "/workspace/openclaw",
    source: "workspace" as const,
  },
];
const newSessionRecentSeeds = [
  "Composer spacing audit",
  "Queue interaction review",
  "Mobile session layout",
  "Command menu behavior",
  "Theme comparison",
];
const presets: Record<string, Partial<BenchState>> = {
  incognito: {
    surface: "new",
    visibility: "incognito",
    content: "one",
    status: "focused",
  },
  "giant-run": {
    content: "giant",
    attachments: "mixed",
    run: "running",
    queue: "three",
    status: "focused",
    width: 900,
  },
  "skills-40": { content: "empty", menu: "skills", run: "idle", queue: "none", width: 640 },
  "mobile-full": {
    content: "multiline",
    attachments: "image",
    run: "running",
    queue: "three",
    width: 390,
  },
  "offline-paste": {
    content: "multiline",
    attachments: "mixed",
    status: "offline",
    queue: "one",
  },
};

type BenchScenario = {
  name: string;
  description: string;
  state: Partial<BenchState>;
  stress?: true;
};

const scenarios: BenchScenario[] = [
  {
    name: "Idle",
    description: "A clean composer before the first keystroke.",
    state: { content: "empty" },
  },
  {
    name: "Commands open",
    description: "The real slash-command palette opens with repository commands.",
    state: { content: "empty", menu: "slash" },
  },
  {
    name: "Skills open",
    description: "The real skill invocation sheet opens for normal navigation.",
    state: { content: "one", menu: "skills" },
  },
  {
    name: "New session",
    description: "The New surface begins with an empty real composer.",
    state: { surface: "new", content: "empty" },
  },
  {
    name: "New incognito",
    description: "A temporary New session disappears after Gateway restart.",
    state: { surface: "new", visibility: "incognito", content: "empty" },
  },
  {
    name: "Plan 2 of 3",
    description: "The current plan sits above the composer as work progresses.",
    state: { content: "multiline", plan: "active" },
  },
  {
    name: "Plan complete",
    description: "The final completed step uses the success state.",
    state: { content: "one", plan: "complete" },
  },
  {
    name: "Goal",
    description: "A session goal sits directly above the composer.",
    state: { content: "one", inset: "goal" },
  },
  {
    name: "Goal + queue",
    description: "The queue stacks above the goal in the canonical attached order.",
    state: { content: "one", run: "running", queue: "three", inset: "goal" },
  },
  {
    name: "Active steer",
    description: "A steered follow-up stays attached to the run it is redirecting.",
    state: { content: "one", run: "steering", followUpMode: "steer" },
  },
  {
    name: "Queue with 3",
    description: "Three queued messages remain attached to the composer.",
    state: { content: "one", run: "running", queue: "three" },
  },
  {
    name: "Queue with 6",
    description: "Six queued messages prove internal scrolling and reordering.",
    state: { content: "one", run: "running", queue: "six" },
  },
  {
    name: "Queue delivery uncertain",
    description: "A failed queued item owns its delivery event and retry action.",
    state: { content: "one", run: "running", queue: "three", queueState: "unconfirmed" },
  },
  {
    name: "Queue waiting for reconnect",
    description: "Offline queue items keep their normal handle and an amber status pill.",
    state: { content: "one", queue: "three", queueState: "waiting-reconnect", status: "offline" },
  },
  {
    name: "Attachments mixed",
    description: "Mixed media flows horizontally across the attachment rail.",
    state: { content: "multiline", attachments: "mixed" },
  },
  {
    name: "Skill inline",
    description: "A skill mention wraps naturally without an explicit newline.",
    state: { content: "skill-inline" },
  },
  {
    name: "Skill inline mobile",
    description: "The same atomic mention wraps naturally on a narrow surface.",
    state: { content: "skill-inline-mobile", width: 390 },
  },
  {
    name: "Plus menu open",
    description: "The real capability menu opens from the composer attachment control.",
    state: { content: "one", capabilities: "available", plusMenuOpen: true },
  },
  {
    name: "Read only",
    description: "Member access renders one blue information band with a shield.",
    state: { content: "one", access: "members" },
  },
  {
    name: "Dictation active",
    description: "The focused dictation mode removes unrelated composer controls.",
    state: { content: "one", dictate: "recording" },
  },
  {
    name: "Session suggestion",
    description: "A member suggestion uses the same composer-width rail.",
    state: { content: "one", neighbor: "session-suggestion" },
  },
  {
    name: "Pull request",
    description: "Repository status stays inside the composer-width boundary.",
    state: { content: "one", neighbor: "pull-request" },
  },
  {
    name: "Chat error",
    description: "A refresh error uses quiet composer chrome and a remote dismiss action.",
    state: { content: "one", neighbor: "error" },
  },
  {
    name: "Placement startup",
    description: "Runner startup uses the same quiet composer-neighbor chrome.",
    state: { content: "one", neighbor: "placement" },
  },
  {
    name: "Placement failed",
    description: "A failed runner startup stays aligned with the composer and offers Retry.",
    state: { content: "one", neighbor: "placement-failed" },
  },
  {
    name: "Disk warning",
    description: "Low disk space uses an amber edge without a filled warning surface.",
    state: { content: "one", neighbor: "disk-warning" },
  },
  {
    name: "Workspace conflict",
    description: "Cloud conflicts begin collapsed with commands kept out of the main view.",
    state: { content: "one", neighbor: "workspace-conflict" },
  },
  {
    name: "Disk critical",
    description: "Critical disk pressure escalates only its icon, title and edge.",
    state: { content: "one", neighbor: "disk-critical" },
  },
  {
    name: "Light composite",
    description: "A composed light-theme state closes the visual sweep.",
    state: {
      content: "multiline",
      attachments: "mixed",
      queue: "three",
      run: "running",
      theme: "light",
    },
  },
  {
    name: "Huge prompt + attachments",
    description: "A long running draft stress-tests scroll and attachment overflow.",
    state: presets["giant-run"] ?? {},
    stress: true,
  },
  {
    name: "Open 40 skills",
    description: "A full invocation sheet stress-tests search and scrolling.",
    state: presets["skills-40"] ?? {},
    stress: true,
  },
];

const params = new URLSearchParams(location.search);
let state: BenchState = readState(params.get("bench"));
let activeScenarioIndex: number | null = null;

const benchMediaDevices = new EventTarget() as EventTarget & Partial<MediaDevices>;
const benchAudioDevice = (deviceId: string, label: string): MediaDeviceInfo => ({
  deviceId,
  groupId: "composer-bench-audio",
  kind: "audioinput",
  label,
  toJSON: () => ({ deviceId, groupId: "composer-bench-audio", kind: "audioinput", label }),
});
Object.defineProperty(benchMediaDevices, "enumerateDevices", {
  configurable: true,
  get: () =>
    state.voiceInput === "unsupported"
      ? undefined
      : async () =>
          state.voiceInput === "available"
            ? [
                benchAudioDevice("studio", "Studio microphone"),
                benchAudioDevice("headset", "USB headset"),
              ]
            : [],
});
benchMediaDevices.getUserMedia = async () => {
  const errorName =
    state.voiceInput === "none"
      ? "NotFoundError"
      : state.voiceInput === "permission"
        ? "NotAllowedError"
        : state.voiceInput === "busy"
          ? "NotReadableError"
          : state.voiceInput === "inactive"
            ? "InvalidStateError"
            : "UnknownError";
  throw new DOMException("Composer bench microphone state", errorName);
};
Object.defineProperty(navigator, "mediaDevices", {
  configurable: true,
  value: benchMediaDevices,
});
let draft = seededDraft(state.content, state.menu);
let pendingMenuActivation = state.menu !== "closed";
let newAgentId = "roboclaw";
let newProjectId = "openclaw";
let newProjectQuery = "";
let newWorktree = true;
const realtimeTalkLevel = new RealtimeTalkLevelSignal();
realtimeTalkLevel.set(0.42);

// Dictation simulation: the bench cannot run a real capture session (no
// gateway client, getUserMedia is mocked to fail), so it pre-seeds the
// composer's state slot with a stub controller. `renderChatComposer` keeps it
// (`state.dictation ??=`), and the real template renders the real mode —
// border light, scrolling wave, streaming partial, stop/send — end to end.
const benchDictationLevel = new RealtimeTalkLevelSignal();
const benchDictationScript =
  "Tailor the composer spacing so every control stays aligned while I dictate this sentence".split(
    " ",
  );
let benchDictationTimer: number | null = null;
let benchDictationPartial = "";
let benchDictationTicks = 0;

function benchDictationController(): ComposerDictationController {
  const phase = state.dictate;
  const stub = {
    active: phase !== "off",
    connecting: phase === "connecting",
    finalizing: phase === "finalizing",
    locksComposer: phase !== "off",
    partial: phase === "recording" ? benchDictationPartial : "",
    elapsed: `0:${String(Math.floor(benchDictationTicks / 10) % 60).padStart(2, "0")}`,
    inputLevel: benchDictationLevel,
    finishActive: () => {
      publishState({ dictate: "off" });
      return Promise.resolve();
    },
    cancelActive: () => publishState({ dictate: "off" }),
    handleClick: () => {},
    handleContextMenu: () => {},
    handlePointerDown: () => {},
    update: () => {},
    dispose: () => {},
  };
  return stub as unknown as ComposerDictationController;
}

function syncBenchDictation(): void {
  const recording = state.surface === "chat" && state.dictate === "recording";
  if (recording && benchDictationTimer === null) {
    benchDictationTimer = window.setInterval(() => {
      benchDictationTicks += 1;
      const speaking = Math.sin(benchDictationTicks / 4) > -0.4;
      benchDictationLevel.set(
        speaking ? 0.2 + Math.random() * 0.75 : Math.random() * 0.06,
      );
      const spokenWords = Math.floor(benchDictationTicks / 4);
      const nextPartial = benchDictationScript.slice(0, spokenWords).join(" ");
      if (nextPartial !== benchDictationPartial) {
        benchDictationPartial = nextPartial;
        renderBench();
      }
    }, 100);
  } else if (!recording && benchDictationTimer !== null) {
    window.clearInterval(benchDictationTimer);
    benchDictationTimer = null;
    benchDictationLevel.set(0);
  }
  if (state.dictate === "off") {
    benchDictationPartial = "";
    benchDictationTicks = 0;
  }
}
const benchCameraStream = new MediaStream();
const newSessionTextarea = new NewSessionComposerTextareaController();
const attachmentDraft = new NewSessionAttachmentDraft(renderBench, mirrorAttachmentState);
attachmentDraft.attachments = attachmentFixtures(state.attachments);

replaceSlashCommands([...buildFallbackSlashCommands(), ...skillCommands]);

function readState(raw: string | null): BenchState {
  if (!raw || raw === "default") {
    return { ...defaults };
  }
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as Partial<BenchState>;
    const width = Number(parsed.width);
    const queueOrder = Array.isArray(parsed.queueOrder)
      ? [
          ...new Set(
            parsed.queueOrder.filter((id): id is string => defaultQueueOrder.includes(String(id))),
          ),
          ...defaultQueueOrder.filter((id) => !parsed.queueOrder?.includes(id)),
        ]
      : [...defaultQueueOrder];
    const parsedQueueTexts: Record<string, unknown> =
      parsed.queueTexts && typeof parsed.queueTexts === "object" ? parsed.queueTexts : {};
    const queueTexts = Object.fromEntries(
      defaultQueueOrder.map((id) => [
        id,
        typeof parsedQueueTexts[id] === "string" ? parsedQueueTexts[id] : defaultQueueTexts[id],
      ]),
    );
    const menu = parsed.menu === "slash" || parsed.menu === "skills" ? parsed.menu : "closed";
    const surface = parsed.surface === "new" ? "new" : "chat";
    const contentKey = [
      "empty",
      "one",
      "multiline",
      "skill-inline",
      "skill-inline-mobile",
      "giant",
    ].includes(String(parsed.content))
      ? (parsed.content as BenchState["content"])
      : surface === "new"
        ? "empty"
        : defaults.content;
    const next: BenchState = {
      ...defaults,
      ...parsed,
      surface,
      content: contentKey,
      menu,
      ...(menu === "closed" ? {} : { surface: "chat" as const, status: "focused" as const }),
      queueOrder,
      queueTexts,
      width: Number.isFinite(width) ? Math.min(1200, Math.max(360, width)) : defaults.width,
    };
    if ((parsed as { voice?: string }).voice === "on") {
      next.voice = "listening";
    }
    if (next.status === "offline" && next.run === "steering") {
      next.run = "idle";
    }
    if (
      next.queueEdit === "editing" &&
      (!next.queueEditingId || !next.queueOrder.includes(next.queueEditingId))
    ) {
      next.queueEditingId = next.queueOrder[0] ?? null;
      next.queueEditingText = next.queueEditingId
        ? (next.queueTexts[next.queueEditingId] ?? "")
        : "";
    }
    return next;
  } catch {
    return { ...defaults };
  }
}

function writeState(): void {
  const url = new URL(location.href);
  url.searchParams.set("bench", encodeURIComponent(JSON.stringify(state)));
  history.replaceState(null, "", url);
}

function attachmentFixtures(value: BenchState["attachments"]): ChatAttachment[] {
  switch (value) {
    case "image":
      return [imageAttachment];
    case "mixed":
      return mixedAttachments;
    case "annotation":
      return [annotationAttachment];
    default:
      return [];
  }
}

function queue(): ChatQueueItem[] {
  const count =
    state.queue === "six"
      ? 6
      : state.queue === "three"
        ? 3
        : state.queue === "one" || state.run === "steering"
          ? 1
          : 0;
  return state.queueOrder.slice(0, count).map((id, index) => {
    const text = state.queueTexts[id] ?? defaultQueueTexts[id];
    return {
      id,
      text: index === 0 && state.queueRow === "attachments" ? "" : (text ?? ""),
      createdAt: Date.now() + index,
      orderKey: index + 1,
      ...(state.run === "steering" && index === 0 ? { queueMode: "steer" as const } : {}),
      ...(index === 0 && state.queueState !== "ready"
        ? {
            sendState: state.queueState as Exclude<BenchState["queueState"], "ready">,
            ...(state.queueState === "waiting-reconnect"
              ? { sendError: "The connection closed before confirmation." }
              : state.queueState === "failed" || state.queueState === "unconfirmed"
                ? { sendError: "The queued message was not accepted." }
                : {}),
          }
        : {}),
      ...(index === 0 && state.queueRow === "attachments"
        ? { attachments: [imageAttachment] }
        : {}),
      ...(index === 0 && state.queueRow === "command"
        ? { text: "/compact", localCommandName: "compact", localCommandArgs: "" }
        : {}),
      ...(index === 0 && state.queueRow === "member"
        ? { sender: { id: "reviewer", name: "Reviewer" } }
        : {}),
      ...(index === 0 && state.queueRow === "run-attached"
        ? { pendingRunId: "composer-bench-run" }
        : {}),
    };
  });
}

function backgroundTasks(): TaskSummary[] {
  const count = state.tasks === "three" ? 3 : state.tasks === "one" ? 1 : 0;
  const now = Date.now();
  return taskSeed.slice(0, count).map((title, index) => ({
    id: `bench-task-${index + 1}`,
    taskId: `bench-task-${index + 1}`,
    kind: "exec",
    runtime: "process",
    status: "running",
    title,
    sessionKey: "agent:main:main",
    createdAt: now - (index + 1) * 90_000,
    startedAt: now - (index + 1) * 90_000,
    updatedAt: now - index * 15_000,
  }));
}

function renderBenchTasksStatus() {
  const tasks = backgroundTasks();
  if (tasks.length === 0) return nothing;
  return html`<div class="composer-bench__tasks-status" data-composer-bench-tasks>
    ${renderBackgroundTasksStatusRow({
      sessionKey: "agent:main:main",
      statusRowId: "composer-bench-tasks-status",
      collapsed: true,
      narrowLayout: state.width <= 640,
      connected: state.status !== "offline",
      canCancel: false,
      loading: false,
      error: null,
      tasks,
      subagentActivity: {
        rows: [],
        overflowWorking: 0,
        taskIds: new Set<string>(),
        nextExpiryAt: null,
      },
      taskDetails: new Map(),
      taskDetailErrors: new Map(),
      taskDetailLoadingIds: new Set(),
      cancellingTaskIds: new Set(),
      finishedCollapsed: false,
      onToggleCollapsed: () => {},
      onToggleFinished: () => {},
      onRefresh: () => {},
      onCancel: () => {},
    })}
  </div>`;
}

function attachmentAxis(attachments: ChatAttachment[]): BenchState["attachments"] {
  if (attachments.length === 0) return "none";
  if (attachments.length === 1 && attachments[0]?.browserAnnotation) return "annotation";
  if (attachments.length === 1 && attachments[0]?.mimeType.startsWith("image/")) return "image";
  return "mixed";
}

function mirrorAttachmentState(): void {
  state = { ...state, attachments: attachmentAxis(attachmentDraft.attachments) };
  writeState();
  syncControls();
}

function replaceLiveAttachments(attachments: ChatAttachment[]): void {
  state = { ...state, attachments: attachmentAxis(attachments) };
  writeState();
  syncControls();
  attachmentDraft.restore(attachments);
}

function moveQueueItem(id: string, toIndex: number): void {
  const visible = queue().map((item) => item.id);
  const fromIndex = visible.indexOf(id);
  const targetIndex = Math.max(0, Math.min(visible.length - 1, toIndex));
  if (fromIndex < 0 || fromIndex === targetIndex) return;
  const nextVisible = [...visible];
  nextVisible.splice(fromIndex, 1);
  nextVisible.splice(targetIndex, 0, id);
  publishState({
    queueOrder: [...nextVisible, ...state.queueOrder.filter((candidate) => !nextVisible.includes(candidate))],
  });
}

function beginQueueEdit(id: string): void {
  publishState({
    queueEdit: "editing",
    queueEditingId: id,
    queueEditingText: state.queueTexts[id] ?? defaultQueueTexts[id] ?? "",
  });
}

function updateQueueEdit(text: string): void {
  state = { ...state, queueEditingText: text };
  writeState();
}

function closeQueueEdit(): void {
  publishState({ queueEdit: "closed", queueEditingId: null, queueEditingText: "" });
}

function submitQueueEdit(): void {
  const id = state.queueEditingId;
  const text = state.queueEditingText.trim();
  if (!id || !text) return;
  publishState({
    queueTexts: { ...state.queueTexts, [id]: text },
    queueEdit: "closed",
    queueEditingId: null,
    queueEditingText: "",
  });
}

function sessions(): SessionsListResult {
  const model = state.model === "opus" ? "claude-opus-4-8" : state.model === "gpt" ? "gpt-5.6-sol" : undefined;
  const modelProvider = state.model === "opus" ? "anthropic" : state.model === "gpt" ? "openai" : undefined;
  return {
    now: Date.now(),
    path: "",
    count: 1,
    defaults: {
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      contextTokens: 100_000,
      thinkingDefault: "medium",
      thinkingLevels: ["off", "low", "medium", "high"].map((level) => ({ id: level, label: level })),
    },
    sessions: [
      {
        key: "agent:main:main",
        kind: "direct",
        updatedAt: Date.now(),
        model,
        modelProvider,
        totalTokens: 26_000,
        contextTokens: 100_000,
        totalTokensFresh: true,
        permissionMode: state.permission === "default" ? undefined : state.permission,
        fastMode: state.fastMode === "on",
        effectiveFastMode: state.fastMode === "on",
        ...(state.reasoning === "default" ? {} : { thinkingLevel: state.reasoning }),
        sessionRoot: "/workspace/openclaw",
        ...(state.inset === "goal"
          ? {
              goal: {
                schemaVersion: 1,
                id: "bench-goal",
                objective: "Finish the composer interaction audit",
                status: "active" as const,
                createdAt: Date.now() - 45_000,
                updatedAt: Date.now(),
                tokenStart: 0,
                tokensUsed: 12_400,
                tokenBudget: 50_000,
                continuationTurns: 0,
              },
            }
          : {}),
      },
    ],
  } as SessionsListResult;
}

function newSessionSessions(): SessionsListResult {
  const now = Date.now();
  return {
    ts: now,
    path: "",
    count: newSessionRecentSeeds.length,
    defaults: { model: "gpt-5.6-sol", modelProvider: "openai" },
    sessions: newSessionRecentSeeds.map((displayName, index) => ({
      key: `agent:${newAgentId}:bench-recent-${index + 1}`,
      kind: "direct" as const,
      displayName,
      updatedAt: now - index * 180_000,
      totalTokens: 0,
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      ...(index === 3
        ? { execCwd: "/workspace/openclaw", worktree: { branch: "bench/menu-behavior" } }
        : {}),
    })),
  } as SessionsListResult;
}

function renderBenchModelPicker(sessionList: SessionsListResult) {
  const overrides =
    state.model === "default"
      ? {}
      : {
          "agent:main:main":
            state.model === "opus" ? "anthropic/claude-opus-4-8" : "openai/gpt-5.6-sol",
        };
  return renderChatModelControls({
      activeRunId:
        state.run === "running" || state.run === "steering" || state.run === "approval"
          ? "composer-bench-run"
          : null,
      agentDefaultModel: "openai/gpt-5.6-sol",
      connected: state.status !== "offline",
      gatewayAvailable: true,
      loading: false,
      modelCatalog,
      modelCatalogState: { hasSnapshot: true, status: "ready", onRetry: () => {} },
      modelOverrides: overrides,
      modelSwitching: false,
      sending: state.status === "sending",
      sessionKey: "agent:main:main",
      sessionsResult: sessionList,
      stream:
        state.run === "running" || state.run === "steering" || state.run === "approval"
          ? "Adjusting the composer surface live..."
          : null,
      onModelSelect: (value) => {
        publishState({
          model: value.includes("opus") ? "opus" : value.includes("gpt") ? "gpt" : "default",
        });
      },
      onFastModeSelect: (value) => {
        publishState({ fastMode: value === "on" || value === "auto" ? "on" : "off" });
      },
      onThinkingSelect: (value) => {
        publishState({ reasoning: value ? (value as BenchState["reasoning"]) : "default" });
      },
      onRequestUpdate: renderBench,
    });
}

function modelControls(sessionList: SessionsListResult) {
  return html`<div class="chat-composer-model-control">
    ${renderBenchModelPicker(sessionList)}
  </div>`;
}

const newSessionModelControl = {
  render: () => renderBenchModelPicker(sessions()),
} as unknown as NewSessionModelControl;

function toggleVoice(): void {
  publishState({ voice: state.voice === "off" ? "listening" : "off" });
}

function menuForDraft(value: string): BenchState["menu"] {
  if (/^\s*\/[^\s]*$/.test(value)) return "slash";
  if (/(?:^|\s)\$[^\s]*$/.test(value)) return "skills";
  return "closed";
}

function updateChatDraft(next: string): void {
  draft = next;
  const menu = menuForDraft(next);
  if (menu === state.menu) return;
  state = { ...state, menu };
  writeState();
  syncControls();
}

function publishToolOverrides(next: SessionToolOverrides | null): void {
  const hasOverrides = Boolean(
    next &&
      (Object.keys(next.skills ?? {}).length > 0 ||
        Object.keys(next.mcpServers ?? {}).length > 0 ||
        Object.keys(next.mcpToolsDeny ?? {}).length > 0 ||
        next.webSearch !== undefined),
  );
  publishState({
    toolOverrides: next,
    capabilities: hasOverrides ? "overrides" : "available",
  });
}

function renderBenchNeighbor() {
  if (state.neighbor === "none") return nothing;
  const clear = () => publishState({ neighbor: "none" });
  let surface = nothing;
  if (state.neighbor === "approval") {
    surface = renderExecApprovalCard({
      approval: {
        id: "bench-approval",
        kind: "exec",
        request: {
          command: "pnpm lint",
          agentId: "main",
          sessionKey: "agent:main:main",
          commandSpans: [],
        },
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      },
      busy: false,
      canGrant: state.status !== "offline",
      unavailableMessage:
        state.status === "offline"
          ? "Reconnecting… you can answer when the connection returns"
          : undefined,
      error: null,
      nowMs: Date.now(),
      variant: "inline",
      onDecision: clear,
    });
  } else if (state.neighbor === "session-suggestion") {
    surface = renderChatSessionSuggestions({
      suggestions: [
        {
          id: "bench-session-suggestion",
          sessionKey: "agent:main:main",
          agentId: "main",
          author: { type: "human", id: "review-member", label: "Review member" },
          text: "Keep the composer footer aligned while the queue grows.",
          createdAt: Date.now(),
          state: "pending",
        },
      ],
      role: "owner",
      busyIds: new Set(),
      archived: false,
      canResolve: true,
      onResolve: clear,
    });
  } else if (state.neighbor === "pull-request") {
    surface = renderChatPullRequests({
      pullRequests: [
        {
          number: 124,
          owner: "openclaw",
          repo: "openclaw",
          branch: "bench/composer-state-machine",
          title: "Refine composer interactions",
          url: "https://example.invalid/openclaw/pull/124",
          state: "open",
          additions: 18,
          deletions: 7,
          checks: { state: "passing", passed: 5, failed: 0, skipped: 1, running: 0 },
        },
      ],
      rateLimited: false,
      expanded: false,
      onExpand: () => {},
      onDismiss: clear,
    });
  } else {
    const notice =
      state.neighbor === "disk-warning"
        ? { diskSpace: { status: "warning" as const, availableBytes: 2_000_000_000, totalBytes: 20_000_000_000 } }
        : state.neighbor === "disk-critical"
          ? { diskSpace: { status: "critical" as const, availableBytes: 500_000_000, totalBytes: 20_000_000_000 } }
          : state.neighbor === "workspace-conflict"
            ? {
                workspaceConflict: {
                  paths: ["ui/src/styles/chat/layout.css", "ui/src/pages/chat/chat-view.ts"],
                  stagedResultRef: "refs/openclaw/worker-results/composer-bench",
                },
                onDismissWorkspaceConflict: clear,
              }
            : state.neighbor === "placement" || state.neighbor === "placement-failed"
              ? {
                  placementStartup: {
                    sessionKey: "agent:main:main",
                    phase: state.neighbor === "placement-failed" ? ("failed" as const) : ("provisioning" as const),
                    startedAt: Date.now() - 12_000,
                    ...(state.neighbor === "placement-failed"
                      ? { error: "The workspace could not be prepared.", retryable: true }
                      : {}),
                  },
                  onRetrySessionPlacementStartup: clear,
                }
              : {
                  error: "The session could not refresh its current state.",
                  onDismissError: clear,
                };
    surface = renderChatViewNotices(notice);
  }
  return html`<div class="composer-bench__neighbor" data-composer-bench-neighbor=${state.neighbor}>
    ${surface}
  </div>`;
}

function renderChatSurface(sessionList: SessionsListResult) {
  const running =
    state.run === "running" || state.run === "steering" || state.run === "approval";
  const insetBanner =
    state.inset === "banner-archived"
      ? {
          kind: "composer-replacement" as const,
          text: t("chat.archivedSessionDisabled"),
          icon: "archive" as const,
          actionLabel: t("common.unarchive"),
          onAction: () => publishState({ inset: "none" }),
        }
      : state.inset === "banner-restart"
        ? {
            kind: "composer-replacement" as const,
            title: t("chat.restartRecoveryTitle"),
            text: t("chat.restartRecoveryDisabled"),
            tone: "neutral" as const,
            icon: "warning" as const,
            actionLabel: t("chat.resumeInNewSession"),
            actionStyle: "primary" as const,
            onAction: () => publishState({ inset: "none" }),
          }
        : state.inset === "banner-model"
          ? {
              kind: "composer-replacement" as const,
              text: t("modelSetup.required.body"),
              actionLabel: t("modelSetup.required.action"),
              onAction: () => publishState({ inset: "none" }),
            }
          : undefined;
  // Seed the composer's dictation slot before render; `??=` inside keeps the
  // stub alive across rerenders. Clearing only our own stub (marked) lets the
  // real controller path own the slot whenever the axis is off.
  const composerState = getChatComposerState("composer-bench");
  composerState.capabilityMenuOpen = state.plusMenuOpen;
  if (state.plusMenuOpen) {
    composerState.capabilityMenuView = "root";
  }
  if (state.dictate !== "off") {
    const stub = benchDictationController() as ComposerDictationController & {
      benchStub?: boolean;
    };
    stub.benchStub = true;
    composerState.dictation = stub;
  } else if ((composerState.dictation as { benchStub?: boolean } | null)?.benchStub) {
    composerState.dictation = null;
  }
  const disabledReasonTone =
    state.access === "members" || state.access === "read-only" ? "info" : "danger";
  if (
    (state.access === "members" || state.access === "read-only") &&
    disabledReasonTone === "danger"
  ) {
    throw new Error("Composer bench invariant: read-only access must render as info");
  }
  const composer = renderChatComposer({
    paneId: "composer-bench",
    sessionKey: "agent:main:main",
    currentAgentId: "main",
    connected: state.status !== "offline",
    offline: state.status === "offline",
    queuedOutboxCount: state.status === "offline" ? queue().length : 0,
    canSend:
      state.status !== "disabled" && state.status !== "catalog" && state.access === "normal",
    disabledReason:
      state.access === "members" || state.access === "read-only"
        ? t("chat.sessionSharing.readOnlyNotice")
        : state.status === "disabled"
        ? t("chat.sessionSharing.readOnlyNotice")
        : state.status === "catalog"
          ? t("chat.catalog.unsupportedViewOnly")
          : null,
    disabledReasonTone,
    disabledBanner: insetBanner,
    runError: state.status === "error" ? { summary: "Send failed" } : null,
    sending: state.status === "sending",
    canAbort: running,
    waitingApproval: state.run === "approval",
    runStatus:
      state.run === "interrupted"
        ? {
            phase: "interrupted",
            runId: "composer-bench-interrupted",
            sessionKey: "agent:main:main",
            occurredAt: Date.now(),
          }
        : null,
    messages:
      state.run === "interrupted"
        ? [
            {
              role: "assistant",
              content: [{ type: "text", text: "The previous response ended before completion." }],
              timestamp: Date.now() - 5_000,
            },
          ]
        : [],
    stream: running ? "Adjusting the composer surface live..." : null,
    compactionStatus:
      state.inset === "compaction"
        ? { phase: "active", runId: "composer-bench-run", startedAt: Date.now(), completedAt: null }
        : null,
    fallbackStatus:
      state.inset === "fallback"
        ? {
            selected: "openai/gpt-5.6-sol",
            active: "anthropic/claude-opus-4-8",
            attempts: ["openai/gpt-5.6-sol: unavailable"],
            occurredAt: Date.now(),
          }
        : null,
    progressCard:
      state.plan !== "none"
        ? {
            sessionKey: "agent:main:main",
            revision: 1,
            updatedAt: Date.now(),
            steps: [
              { step: "Map composer states across the full chat surface", status: "completed" },
              {
                step: "Review interaction gaps across queue, voice, and sheets",
                status: state.plan === "complete" ? "completed" : "in_progress",
              },
              {
                step: "Capture final proof in both themes",
                status: state.plan === "complete" ? "completed" : "pending",
              },
            ],
          }
        : null,
    gatewayQuestionPrompts:
      state.inset === "question"
        ? [
            {
              id: "bench-question",
              questions: [
                {
                  questionId: "choice",
                  header: "Composer choice",
                  question: "Keep this queued message for the next run?",
                  options: [{ label: "Keep" }, { label: "Remove" }],
                  isOther: true,
                },
              ],
              sessionKey: "agent:main:main",
              createdAtMs: Date.now(),
              expiresAtMs: Date.now() + 60_000,
              status: "pending" as const,
              answeredElsewhere: false,
              localResolutionConfirmed: false,
              locallyExpired: false,
              submitting: false,
              error: null,
              drafts: new Map(),
              revision: 1,
            },
          ]
        : [],
    queue: queue(),
    draft,
    sessions: sessionList,
    providerUsage:
      state.usage === "plan"
        ? {
            basePath: "",
            modelAuthStatusResult: {
              ts: Date.now(),
              providers: [
                {
                  provider: "openai",
                  displayName: "OpenAI",
                  status: "ok",
                  profiles: [{ profileId: "openai", type: "oauth", status: "ok" }],
                  usage: {
                    providerId: "openai",
                    windows: [
                      {
                        label: "Week",
                        usedPercent: 42,
                        resetAt: Date.now() + 3 * 3_600_000,
                      },
                    ],
                  },
                },
              ],
            },
          }
        : undefined,
    toolOverrides: state.toolOverrides,
    capabilityMenu:
      state.capabilities === "attachments" || state.status === "catalog"
        ? undefined
        : {
            basePath: "",
            skills: [
              {
                key: "composer-review",
                name: "Composer review",
                baseEnabled: true,
                enabled: state.toolOverrides?.skills?.["composer-review"] ?? true,
              },
              {
                key: "queue-audit",
                name: "Queue audit",
                baseEnabled: false,
                enabled: state.toolOverrides?.skills?.["queue-audit"] ?? false,
              },
            ],
            skillsLoading: false,
            skillsError: false,
            mcpServers: [],
            toolsEffectiveResult: null,
            toolsEffectiveLoading: false,
            toolsEffectiveError: false,
            toolAccessMutationBlockedReason: null,
            webSearchBaseEnabled: true,
            mutationBlockedReason: null,
            canAdmin: false,
            adminBlockedReason: "Administrator access is required.",
            onLoadSkills: () => {},
            onPatchToolOverrides: publishToolOverrides,
            onNavigate: () => {},
          },
    assistantName: "OpenClaw",
    sendShortcut: "enter",
    followUpMode: state.followUpMode,
    suggestionComposer: false,
    composerHoldToRecord: loadSettings().composerHoldToRecord,
    attachments: attachmentDraft.attachments,
    pendingAttachmentReads: 0,
    getPendingAttachmentReads: () => 0,
    composerControls: state.status === "catalog" ? nothing : modelControls(sessionList),
    permissionPicker:
      state.status === "catalog"
        ? undefined
        : {
            canSelectFull: true,
            mode: state.permission === "default" ? undefined : state.permission,
            sessionRoot: "/workspace/openclaw",
            onSelect: (mode) => publishState({ permission: mode ?? "default" }),
          },
    realtimeTalkActive: !["off", "error"].includes(state.voice),
    realtimeTalkStatus:
      state.voice === "camera" || state.voice === "camera-pending" || state.voice === "camera-error"
        ? "listening"
        : state.voice,
    realtimeTalkDetail:
      state.voice === "error"
        ? "Voice session could not start."
        : state.voice === "connecting"
          ? "Connecting to voice…"
          : null,
    realtimeTalkInputLevel: realtimeTalkLevel,
    realtimeTalkVideoCapable:
      state.voice === "camera" || state.voice === "camera-pending" || state.voice === "camera-error",
    realtimeTalkVideoStream: state.voice === "camera" ? benchCameraStream : null,
    realtimeTalkCameraDevices:
      state.voice === "camera"
        ? [
            { deviceId: "front", label: "Front camera" },
            { deviceId: "back", label: "Back camera" },
          ]
        : [],
    realtimeTalkVideoPending: state.voice === "camera-pending",
    realtimeTalkCameraError: state.voice === "camera-error",
    onToggleRealtimeTalk: toggleVoice,
    onToggleRealtimeCamera: () =>
      publishState({ voice: state.voice === "camera" ? "listening" : "camera" }),
    onSwitchRealtimeCamera: () => {},
    onDismissRealtimeTalkError: () => publishState({ voice: "off" }),
    onAttachmentsChange: replaceLiveAttachments,
    onDraftChange: updateChatDraft,
    onRequestUpdate: renderBench,
    onSend: (followUpModeOverride) =>
      publishState({
        status: "sending",
        ...(followUpModeOverride === "steer" ? { run: "steering" as const } : {}),
      }),
    onDismissProgressCard: () => publishState({ plan: "none" }),
    onCompact: () => publishState({ inset: "compaction" }),
    onAbort: () => publishState({ run: "idle" }),
    onQueueRemove: (id) => {
      const remaining = state.queueOrder.filter((candidate) => candidate !== id);
      publishState({
        queue:
          remaining.length === 0
            ? "none"
            : remaining.length === 1
              ? "one"
              : remaining.length > 3
                ? "six"
                : "three",
        queueOrder: remaining,
        ...(state.queueEditingId === id
          ? { queueEdit: "closed" as const, queueEditingId: null, queueEditingText: "" }
          : {}),
      });
    },
    onQueueSteer: () => publishState({ run: "steering" }),
    onQueueRetry: () => publishState({ queueState: "ready" }),
    onQueueMove: moveQueueItem,
    queuedEdit: {
      editingId: state.queueEdit === "editing" ? state.queueEditingId : null,
      editingText: state.queueEditingText,
      onEdit: beginQueueEdit,
      onEditChange: updateQueueEdit,
      onEditSubmit: submitQueueEdit,
      onCancel: closeQueueEdit,
    },
    replyTarget:
      state.inset === "reply"
        ? {
            messageId: "bench-reply",
            senderLabel: "Reviewer",
            text: "Keep the queue attached while the composer grows.",
          }
        : null,
    onClearReply: () => publishState({ inset: "none" }),
    onGoalCommand: () => publishState({ inset: "none" }),
    onGatewayQuestionChange: renderBench,
    onGatewayQuestionSubmit: () => publishState({ inset: "none" }),
    onGatewayQuestionSkip: () => publishState({ inset: "none" }),
    onSlashIntent: () => {},
  });
  return html`${renderBenchNeighbor()}<div class="composer-bench__composer-stack">
      ${renderBenchTasksStatus()}${composer}
    </div>`;
}

function renderNewTargetBar() {
  const selectedAgent =
    newSessionAgents.find((agent) => agent.id === newAgentId) ?? newSessionAgents[0]!;
  const whereState = resolveWhereChip({
    environments: [],
    cloudProfiles: [],
    cloudProfileId: "",
    deviceId: "",
  });
  const projectState = resolveProjectChip({
    folder: "/workspace/openclaw",
    workspace: "/workspace/openclaw",
    projectId: newProjectId,
    selectedRemoteProject: null,
    projects: newSessionProjects,
    recents: [],
    projectQuery: newProjectQuery,
  });
  const detailState = resolveDetailChip({
    destination: "local",
    worktree: newWorktree,
    worktreeAvailable: true,
  });
  const popoverState = {
    popoverOpen: false,
    popoverHiding: false,
    onGuardTransition: () => {},
    onPopoverShow: () => {},
    onPopoverHide: () => {},
    onPopoverAfterHide: () => {},
  };
  return renderNewSessionTargetBar({
    agentSelect: renderAgentSelect({
      agents: newSessionAgents,
      agentId: selectedAgent.id,
      disabled: state.status === "sending" || state.status === "disabled",
      onSelect: (agentId) => {
        newAgentId = agentId;
        renderBench();
      },
    }),
    placeSelect: html`${renderWhereChip({
      state: whereState,
      gatewayName: "Local",
      cloudProfileId: "",
      deviceId: "",
      worktreeAvailable: true,
      submitting: state.status === "sending",
      pendingPlacement: false,
      isAdmin: false,
      ...popoverState,
      onSelectDevice: () => {},
      onSelectCloudProfile: () => {},
      onConnectMachine: () => {},
    })}${renderProjectChip({
      state: projectState,
      browseAvailable: false,
      isAdmin: false,
      canWrite: true,
      folder: "/workspace/openclaw",
      workspace: "/workspace/openclaw",
      projects: newSessionProjects,
      projectQuery: newProjectQuery,
      projectSearchAvailable: false,
      projectAddAvailable: false,
      remoteProjects: [],
      selectedRemoteProject: null,
      projectSearchCredentialMissing: false,
      projectSearchLoading: false,
      projectSearchError: null,
      projectId: newProjectId,
      gatewayLabel: "Local",
      remotePlacement: false,
      branches: null,
      branchesLoading: false,
      baseRef: "main",
      worktreeName: "",
      submitting: state.status === "sending",
      pendingPlacement: false,
      ...popoverState,
      browserTarget: null,
      browserListing: null,
      browserLoading: false,
      browserError: null,
      browserPathDraft: "",
      usableBrowserPath: null,
      registerProjectPath: null,
      registeringProject: false,
      onSelectProject: (projectId) => {
        newProjectId = projectId;
        renderBench();
      },
      onProjectQueryInput: (query) => {
        newProjectQuery = query;
        renderBench();
      },
      onSelectRemoteProject: () => {},
      onApplyFolder: () => {
        newProjectId = "";
        renderBench();
      },
      onBaseRefInput: () => {},
      onWorktreeNameInput: () => {},
      onBrowse: () => {},
      onBrowserPathDraftChange: () => {},
      onBrowserNavigate: () => {},
      onBrowserBack: () => {},
      onRegisterProject: () => {},
      onClose: () => {},
    })}${detailState
      ? renderDetailChip({
          state: detailState,
          worktree: newWorktree,
          worktreeAvailable: true,
          branches: null,
          branchesLoading: false,
          baseRef: "main",
          worktreeName: "",
          submitting: state.status === "sending",
          pendingPlacement: false,
          ...popoverState,
          onToggleWorktree: () => {
            newWorktree = !newWorktree;
            renderBench();
          },
          onBaseRefInput: () => {},
          onWorktreeNameInput: () => {},
        })
      : nothing}`,
    retrying: false,
    onRetry: () => {},
  });
}

function renderNewSurface() {
  const canSubmit =
    state.status !== "disabled" &&
    state.status !== "sending" &&
    state.newAction !== "blocked" &&
    state.newAction !== "locked" &&
    Boolean(draft.trim() || attachmentDraft.attachments.length);
  const selectedAgent =
    newSessionAgents.find((agent) => agent.id === newAgentId) ?? newSessionAgents[0]!;
  const composer = html`<div class="new-session-page__draft">
    ${renderNewTargetBar()}
    ${state.status === "error" ? renderDraftError("Start failed") : nothing}
    ${state.newAction === "invalid-worktree"
      ? renderDraftError(t("newSession.worktreeNameInvalid"))
      : state.newAction === "outcome-unknown"
        ? renderDraftError(t("newSession.createOutcomeUnknown"))
        : state.newAction === "placement-interrupted"
          ? renderDraftError(t("newSession.placementSetupInterrupted"))
          : nothing}
    ${renderNewSessionDraftComposer({
      agent: selectedAgent,
      agentId: selectedAgent.id,
      attachmentDraft,
      canSubmit,
      context: undefined,
      isCatalogTarget: state.newAction === "catalog",
      message: draft,
      modelControl: newSessionModelControl,
      permissionControl: renderChatPermissionPicker({
        canSelectFull: true,
        mode: state.permission === "default" ? undefined : state.permission,
        onSelect: (mode) =>
          publishState({ permission: mode === undefined || mode === null ? "default" : mode }),
      }),
      requiresModifier: false,
      requestUpdate: renderBench,
      submitting: state.status === "sending",
      messageLocked: state.newAction === "locked",
      visibility: state.visibility,
      draftAvailable: true,
      submitDisabledReason:
        state.newAction === "blocked"
          ? "Preparing the selected workspace."
          : state.status === "disabled"
          ? "This action requires operator.write access."
          : state.status === "offline"
            ? "Offline"
            : undefined,
      blockedSubmitNotice:
        state.newAction === "blocked" ? "Preparing the selected workspace." : undefined,
      terminalAction:
        state.newAction === "terminal"
          ? { canStart: true, onStart: () => publishState({ status: "sending" }) }
          : undefined,
      textareaController: newSessionTextarea,
      onInput: (next) => {
        draft = next;
        renderBench();
      },
      onVisibilityChange: (visibility) => publishState({ visibility }),
      onSubmit: () => publishState({ status: "sending" }),
    })}
    ${renderNewSessionIncognitoNotice(state.visibility === "incognito")}
  </div>`;
  return html`<div
    class="new-session-page ${state.visibility === "incognito"
      ? "new-session-page--incognito"
      : ""}"
  >
    ${renderNewSessionIncognitoControl({
      visibility: state.visibility,
      submitting: state.status === "sending",
      pendingPlacement: { sessionKey: "" },
      incognitoDisabledReason: () => undefined,
      setVisibility: (visibility) =>
        publishState({ visibility: visibility === "incognito" ? "incognito" : "normal" }),
    })}
    <div class="new-session-page__scroll">
      ${renderWelcomeState({
        assistantName: selectedAgent.name ?? selectedAgent.id,
        assistantAvatar: selectedAgent.identity?.emoji ?? null,
        hint: t("newSession.hint"),
        composer,
        hideSecondaryContent: state.visibility === "incognito",
        fadeSecondaryContent: draft.trim().length > 0,
        sessions: newSessionSessions(),
        sessionKey: `agent:${selectedAgent.id}:main`,
        sessionHost: {
          assistantAgentId: selectedAgent.id,
          agentsList: {
            agents: newSessionAgents,
            defaultId: selectedAgent.id,
            mainKey: "main",
            scope: "agent",
          },
          hello: null,
        },
        onDraftChange: (next) => {
          draft = next;
          renderBench();
        },
        onSend: () => publishState({ status: "sending" }),
        onOpenSession: () => {},
      })}
    </div>
  </div>`;
}

function renderBench(): void {
  const stage = document.querySelector<HTMLElement>("[data-composer-bench-stage]");
  if (!stage) {
    return;
  }
  syncBenchDictation();
  const sessionList = sessions();
  stage.style.setProperty("--composer-bench-width", `${state.width}px`);
  stage.dataset.composerBenchSurface = state.surface;
  stage.dataset.composerBenchWidth = state.width === 1200 ? "desktop" : "custom";
  stage.dataset.composerBenchMenu = state.menu;
  stage.dataset.composerBenchAttachments = state.attachments;
  stage.dataset.composerProductionOwner =
    state.surface === "chat"
      ? "renderChatComposer"
      : "renderWelcomeState+renderNewSessionDraftComposer+renderNewSessionIncognitoControl";
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.themeMode = state.theme;
  document.documentElement.dataset.themeResolved = state.theme;
  document.documentElement.classList.toggle("wa-light", state.theme === "light");
  document.documentElement.classList.toggle("wa-dark", state.theme === "dark");
  document.documentElement.style.colorScheme = state.theme;

  render(
    html`<section class="composer-bench__surface" data-composer-production-surface>
        ${state.surface === "chat" ? renderChatSurface(sessionList) : renderNewSurface()}
      </section>`,
    stage,
  );
  requestAnimationFrame(applyTransientState);
}

function applyTransientState(): void {
  const surface = document.querySelector<HTMLElement>(".composer-bench__surface");
  const composerShell = surface?.querySelector<HTMLElement>(".agent-chat__composer-shell");
  if (surface && composerShell) {
    surface.style.setProperty(
      "--composer-bench-composer-width",
      `${Math.round(composerShell.getBoundingClientRect().width)}px`,
    );
  }
  const textarea = document.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox textarea");
  if (!textarea) {
    return;
  }
  textarea.readOnly = true;
  if (pendingMenuActivation) {
    pendingMenuActivation = false;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }),
    );
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  }
  if (state.surface === "chat" && state.status === "focused") {
    textarea.focus({ preventScroll: true });
  }
}

function commitState(next: Partial<BenchState>, markScenarioCustom = true): void {
  if (markScenarioCustom) activeScenarioIndex = null;
  const previousMenu = state.menu;
  const contentChanged = next.content !== undefined && next.content !== state.content;
  state = { ...state, ...next };
  if (next.status === "offline" && state.run === "steering") {
    state.run = "idle";
  } else if (next.run === "steering" && state.status === "offline") {
    state.status = "focused";
  }
  if (next.surface === "new") {
    state.menu = "closed";
    pendingMenuActivation = false;
  } else if (next.surface === "chat") {
    state.visibility = "normal";
  }
  if (next.newAction !== undefined) {
    state.surface = "new";
    state.menu = "closed";
    pendingMenuActivation = false;
  }
  if (next.status === "catalog") {
    state.surface = "chat";
    state.menu = "closed";
    pendingMenuActivation = false;
  }
  if (
    next.neighbor !== undefined ||
    next.voice !== undefined ||
    next.dictate !== undefined ||
    next.voiceInput !== undefined
  ) {
    state.surface = "chat";
    state.visibility = "normal";
  }
  if (next.visibility === "incognito" || next.visibility === "draft") {
    state.surface = "new";
    state.menu = "closed";
    pendingMenuActivation = false;
  } else if (next.menu === "slash" || next.menu === "skills") {
    state.surface = "chat";
    state.status = "focused";
    pendingMenuActivation = true;
  } else if (next.status && next.status !== "focused" && state.menu !== "closed") {
    state.menu = "closed";
    pendingMenuActivation = false;
  } else if (next.content && next.menu === undefined && state.menu !== "closed") {
    state.menu = "closed";
    pendingMenuActivation = false;
  }
  if (next.queue) {
    state.queueOrder = [
      ...state.queueOrder,
      ...defaultQueueOrder.filter((id) => !state.queueOrder.includes(id)),
    ];
  }
  if (next.queueEdit === "editing") {
    if (state.queue === "none") state.queue = "one";
    state.queueEditingId = queue()[0]?.id ?? state.queueOrder[0] ?? null;
    state.queueEditingText = state.queueEditingId
      ? (state.queueTexts[state.queueEditingId] ?? "")
      : "";
  } else if (next.queueEdit === "closed") {
    state.queueEditingId = null;
    state.queueEditingText = "";
  }
  if (
    next.queueRow === "command" ||
    next.queueRow === "run-attached" ||
    (next.queueState !== undefined && next.queueState !== "ready")
  ) {
    state.queueEdit = "closed";
    state.queueEditingId = null;
    state.queueEditingText = "";
  }
  if (next.capabilities === "attachments" || next.capabilities === "available") {
    state.toolOverrides = null;
  } else if (next.capabilities === "overrides") {
    state.toolOverrides = { skills: { "queue-audit": true }, webSearch: false };
  }
  if (next.attachments) {
    attachmentDraft.restore(attachmentFixtures(next.attachments));
  }
  if (next.theme) {
    patchSettings({ themeMode: next.theme });
  }
  if (contentChanged || state.menu !== previousMenu || next.menu !== undefined) {
    draft = seededDraft(state.content, state.menu);
  }
  resetChatComposerState("composer-bench");
  writeState();
  syncControls();
  renderBench();
}

function publishState(next: Partial<BenchState>): void {
  activeScenarioIndex = null;
  state = { ...state, ...next };
  writeState();
  syncControls();
  renderBench();
}

function syncControls(): void {
  const chatOnlyAxes = new Set<keyof BenchState>([
    "run",
    "followUpMode",
    "tasks",
    "plan",
    "inset",
    "queue",
    "queueEdit",
    "queueState",
    "queueRow",
    "status",
    "usage",
    "neighbor",
    "voice",
    "dictate",
    "voiceInput",
  ]);
  const newOnlyAxes = new Set<keyof BenchState>(["visibility", "newAction"]);
  document.querySelectorAll<HTMLButtonElement>("[data-bench-axis][data-bench-value]").forEach((button) => {
    const axis = button.dataset.benchAxis as keyof BenchState;
    const value = button.dataset.benchValue;
    button.toggleAttribute("data-active", state[axis] === button.dataset.benchValue);
    button.disabled =
      (chatOnlyAxes.has(axis) && state.surface !== "chat") ||
      (newOnlyAxes.has(axis) && state.surface !== "new") ||
      (axis === "followUpMode" && state.run !== "running" && state.run !== "steering") ||
      (axis === "usage" && value === "plan" && state.plan === "none");
  });
  const slider = document.querySelector<HTMLElement>("[data-bench-slider=width]");
  const output = document.querySelector<HTMLOutputElement>("[data-bench-width-value]");
  const order = document.querySelector<HTMLOutputElement>("[data-bench-queue-order]");
  const voiceOptions = document.querySelector<HTMLElement>("[data-bench-voice-options]");
  const voiceUnavailable = document.querySelector<HTMLElement>("[data-bench-voice-unavailable]");
  const scenario = activeScenarioIndex === null ? null : scenarios[activeScenarioIndex];
  const scenarioName = document.querySelector<HTMLOutputElement>("[data-bench-scenario-name]");
  const scenarioDescription = document.querySelector<HTMLElement>("[data-bench-scenario-description]");
  const scenarioKind = document.querySelector<HTMLElement>("[data-bench-scenario-kind]");
  const voiceApplies = state.surface === "chat";
  if (voiceOptions) voiceOptions.hidden = !voiceApplies;
  if (voiceUnavailable) voiceUnavailable.hidden = voiceApplies;
  document
    .querySelectorAll<HTMLElement>(".composer-bench__row, .composer-bench__choice")
    .forEach((control) => {
      const buttons = [...control.querySelectorAll<HTMLButtonElement>("[data-bench-axis]")];
      const disabled = buttons.length > 0 && buttons.every((button) => button.disabled);
      control.classList.toggle("is-disabled", disabled);
      control.toggleAttribute("aria-disabled", disabled);
      if (disabled && control instanceof HTMLDetailsElement) control.open = false;
  });
  document.querySelectorAll<HTMLElement>("[data-bench-when]").forEach((conditional) => {
    const condition = conditional.dataset.benchWhen;
    conditional.hidden =
      (condition === "content" && state.content === "empty") ||
      (condition === "surface-new" && state.surface !== "new") ||
      (condition === "plan" && state.plan === "none") ||
      (condition === "queue" && state.queue === "none");
  });
  if (scenarioName) scenarioName.value = scenario?.name ?? "Custom";
  if (scenarioDescription) {
    scenarioDescription.textContent =
      scenario?.description ?? "Adjust any control or browse the demo sequence.";
  }
  if (scenarioKind) scenarioKind.dataset.visible = String(Boolean(scenario?.stress));
  if (slider) {
    const fill = ((state.width - 390) / (1200 - 390)) * 100;
    const widthLabel = state.width <= 768 ? "Mobile" : "Desktop";
    slider.style.setProperty("--bench-slider-fill", `${fill}%`);
    slider.setAttribute("aria-valuenow", String(state.width));
    slider.setAttribute("aria-valuetext", widthLabel);
    if (output) output.value = widthLabel;
  }
  document.querySelectorAll<HTMLOutputElement>("[data-bench-choice-value]").forEach((choiceOutput) => {
    const axis = choiceOutput.dataset.benchChoiceValue;
    const active = axis
      ? document.querySelector<HTMLButtonElement>(`[data-bench-axis="${axis}"][data-active]`)
      : null;
    choiceOutput.value = active?.textContent?.trim() ?? "";
  });
  if (order) {
    order.value = queue()
      .map((item) => String(defaultQueueOrder.indexOf(item.id) + 1))
      .join(" → ") || "—";
  }
}

function selectScenario(index: number): void {
  const nextIndex = (index + scenarios.length) % scenarios.length;
  const scenario = scenarios[nextIndex];
  if (!scenario) return;
  activeScenarioIndex = nextIndex;
  state = {
    ...defaults,
    ...scenario.state,
    queueOrder: [...(scenario.state.queueOrder ?? defaultQueueOrder)],
    queueTexts: { ...defaultQueueTexts, ...(scenario.state.queueTexts ?? {}) },
  };
  draft = seededDraft(state.content, state.menu);
  pendingMenuActivation = state.menu !== "closed";
  attachmentDraft.restore(attachmentFixtures(state.attachments));
  patchSettings({ themeMode: state.theme });
  resetChatComposerState("composer-bench");
  writeState();
  syncControls();
  renderBench();
}

function moveScenario(delta: -1 | 1): void {
  if (activeScenarioIndex === null) {
    selectScenario(delta > 0 ? 0 : scenarios.length - 1);
    return;
  }
  selectScenario(activeScenarioIndex + delta);
}

document.querySelectorAll<HTMLButtonElement>("[data-bench-axis][data-bench-value]").forEach((button) => {
  button.addEventListener("click", () => {
    const axis = button.dataset.benchAxis as keyof BenchState;
    const value = button.dataset.benchValue;
    if (axis === "surface" && value === "new" && state.surface !== "new") {
      commitState({ surface: "new", content: "empty" });
      return;
    }
    commitState({ [axis]: value } as Partial<BenchState>);
  });
});

const widthSlider = document.querySelector<HTMLElement>("[data-bench-slider=width]");
const setWidthFromPointer = (event: PointerEvent) => {
  if (!widthSlider) return;
  const bounds = widthSlider.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
  commitState({ width: Math.round((360 + ratio * (1200 - 360)) / 10) * 10 });
};
widthSlider?.addEventListener("pointerdown", (event) => {
  widthSlider.setPointerCapture(event.pointerId);
  setWidthFromPointer(event);
});
widthSlider?.addEventListener("pointermove", (event) => {
  if (widthSlider.hasPointerCapture(event.pointerId)) setWidthFromPointer(event);
});
widthSlider?.addEventListener("keydown", (event) => {
  const key = event.key;
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
  event.preventDefault();
  const width = key === "Home" ? 360 : key === "End" ? 1200 : state.width + (key === "ArrowLeft" ? -10 : 10);
  commitState({ width: Math.min(1200, Math.max(360, width)) });
});

document.querySelector<HTMLButtonElement>("[data-bench-scenario-prev]")?.addEventListener("click", () => {
  moveScenario(-1);
});
document.querySelector<HTMLButtonElement>("[data-bench-scenario-next]")?.addEventListener("click", () => {
  moveScenario(1);
});
document.addEventListener("keydown", (event) => {
  if (
    event.defaultPrevented ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    !["ArrowLeft", "ArrowRight", "<", ">"].includes(event.key)
  ) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  moveScenario(event.key === "ArrowLeft" || event.key === "<" ? -1 : 1);
}, { capture: true });

const benchControls = document.querySelector<HTMLElement>("[data-composer-bench-controls]");
const syncBenchControlFades = () => {
  if (!benchControls) return;
  const scrollable = benchControls.scrollHeight > benchControls.clientHeight + 1;
  benchControls.dataset.scrollable = String(scrollable);
  benchControls.dataset.atStart = String(!scrollable || benchControls.scrollTop <= 1);
  benchControls.dataset.atEnd = String(
    !scrollable ||
      benchControls.scrollTop + benchControls.clientHeight >= benchControls.scrollHeight - 1,
  );
};
benchControls?.addEventListener("scroll", syncBenchControlFades, { passive: true });
if (benchControls && typeof ResizeObserver !== "undefined") {
  new ResizeObserver(syncBenchControlFades).observe(benchControls);
}
requestAnimationFrame(syncBenchControlFades);

const benchDisclosures = [...document.querySelectorAll<HTMLDetailsElement>("[data-bench-disclosure]")];
benchDisclosures.forEach((disclosure) => {
  disclosure.addEventListener("toggle", () => {
    if (!disclosure.open) return;
    benchDisclosures.forEach((other) => {
      if (other !== disclosure) other.open = false;
    });
  });
  disclosure.addEventListener("keydown", (event) => {
    if (!disclosure.open || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    const options = [
      ...disclosure.querySelectorAll<HTMLButtonElement>(
        "[data-bench-axis][data-bench-value]:not(:disabled)",
      ),
    ];
    if (options.length === 0) return;
    event.preventDefault();
    const activeIndex = options.findIndex((option) => option.hasAttribute("data-active"));
    const direction = event.key === "ArrowUp" ? -1 : 1;
    const nextIndex = (Math.max(activeIndex, 0) + direction + options.length) % options.length;
    const nextOption = options[nextIndex];
    nextOption?.click();
    nextOption?.focus({ preventScroll: true });
  });
});
document.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (target instanceof Node && benchDisclosures.some((disclosure) => disclosure.contains(target))) return;
  benchDisclosures.forEach((disclosure) => {
    disclosure.open = false;
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  benchDisclosures.forEach((disclosure) => {
    disclosure.open = false;
  });
});

patchSettings({ locale: "en", themeMode: state.theme });
await i18n.setLocale("en");
writeState();
syncControls();
renderBench();
