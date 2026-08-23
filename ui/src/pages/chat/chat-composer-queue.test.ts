/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
import { renderChatQueue } from "./components/chat-composer-queue.ts";

afterEach(async () => {
  document.body.replaceChildren();
  await i18n.setLocale("en");
  vi.restoreAllMocks();
});

describe("chat composer steering queue", () => {
  it("renders the durable steer mode without a run-bound state", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChatQueue({
        queue: [
          {
            id: "steer-1",
            text: "change course",
            createdAt: 1,
            queueMode: "steer",
            sendState: "waiting-idle",
          },
        ],
        onQueueRemove: vi.fn(),
      }),
      container,
    );

    const badges = container.querySelectorAll(".chat-queue__badge");
    expect(badges).toHaveLength(2);
    expect(badges[0]?.textContent?.trim()).toBe(t("chat.queue.steer"));
    expect(badges[1]?.textContent?.trim()).toBe(t("chat.queue.states.waitingForRun"));
  });

  it("keeps a failed steer visually classified as an error", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChatQueue({
        queue: [
          {
            id: "failed-steer",
            text: "change course",
            createdAt: 1,
            queueMode: "steer",
            sendState: "failed",
            sendError: "steer rejected",
          },
        ],
        onQueueRemove: vi.fn(),
      }),
      container,
    );

    const row = container.querySelector(".chat-queue__item");
    expect(row?.classList.contains("chat-queue__item--failed")).toBe(true);
    const icon = row?.querySelector(".chat-queue__icon");
    expect(icon?.querySelector('path[d^="m21.73 18"]')).not.toBeNull();
    expect(container.querySelector(".chat-queue__badge")?.textContent?.trim()).toBe(
      t("chat.queue.steer"),
    );
  });
});

function renderQueue(props: Parameters<typeof renderChatQueue>[0]) {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderChatQueue(props), container);
  return container;
}

const waiting = (id: string, createdAt: number) => ({
  id,
  text: id,
  createdAt,
  sendState: "waiting-reconnect" as const,
});

describe("chat composer queue reordering", () => {
  it("puts reordering on one focusable handle for pointer and keyboard alike", () => {
    const container = renderQueue({
      queue: [waiting("a", 1), waiting("b", 2)],
      onQueueMove: vi.fn(),
      onQueueRemove: vi.fn(),
    });

    const rows = container.querySelectorAll(".chat-queue__item");
    expect(rows).toHaveLength(2);
    const grips = [...container.querySelectorAll(".chat-queue__grip")];
    expect(grips).toHaveLength(2);
    expect(grips[0]?.tagName).toBe("BUTTON");
    expect(grips[0]?.getAttribute("aria-label")).toBe(t("chat.queue.reorderQueuedMessage"));
    expect(grips[0]?.getAttribute("aria-keyshortcuts")).toBe("ArrowUp ArrowDown");
    expect(grips.map((grip) => grip.getAttribute("draggable"))).toEqual(["true", "true"]);
    expect(grips[0]?.querySelector(".chat-queue__grip-state--idle")).not.toBeNull();
    expect(grips[0]?.querySelector(".chat-queue__grip-state--active")).not.toBeNull();
    expect([...rows].every((row) => !row.hasAttribute("draggable"))).toBe(true);
    expect(container.querySelectorAll("wa-dropdown.chat-queue__overflow")).toHaveLength(2);
  });

  it.each([
    { key: "ArrowUp", expected: ["c", 1] },
    { key: "ArrowDown", expected: ["c", 3] },
  ])("moves the focused row on $key", ({ key, expected }) => {
    const onQueueMove = vi.fn();
    const container = renderQueue({
      queue: [waiting("a", 1), waiting("b", 2), waiting("c", 3), waiting("d", 4)],
      onQueueMove,
      onQueueRemove: vi.fn(),
    });
    const grip = container.querySelectorAll(".chat-queue__grip")[2]!;

    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    grip.dispatchEvent(event);

    expect(onQueueMove.mock.calls).toEqual([expected]);
    // Arrow keys belong to the handle here, so the transcript must not scroll.
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves other keys alone on the handle", () => {
    const onQueueMove = vi.fn();
    const container = renderQueue({
      queue: [waiting("a", 1), waiting("b", 2)],
      onQueueMove,
      onQueueRemove: vi.fn(),
    });

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    container.querySelector(".chat-queue__grip")!.dispatchEvent(event);

    expect(onQueueMove).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("hides reorder affordances when there is nothing to reorder against", () => {
    const container = renderQueue({
      queue: [waiting("only", 1)],
      onQueueMove: vi.fn(),
      onQueueRemove: vi.fn(),
    });

    expect(container.querySelector(".chat-queue__grip")).toBeNull();
    expect(container.querySelector(".chat-queue__item")?.hasAttribute("draggable")).toBe(false);
  });

  it("reserves the handle column on every row so the pills never shift", () => {
    const container = renderQueue({
      queue: [
        { id: "pending", text: "pending", createdAt: 1, pendingRunId: "run-1" },
        waiting("b", 2),
        waiting("c", 3),
      ],
      onQueueMove: vi.fn(),
      onQueueRemove: vi.fn(),
    });

    const grips = [...container.querySelectorAll(".chat-queue__item")].map((row) =>
      row.querySelector(".chat-queue__grip"),
    );
    // Every row keeps the column; only the rows that may move keep it live.
    expect(grips.every((grip) => grip !== null)).toBe(true);
    expect(grips.map((grip) => grip!.hasAttribute("disabled"))).toEqual([true, false, false]);
    expect(grips[0]?.getAttribute("aria-label")).toBe(t("chat.queue.reorderUnavailable"));
    expect(grips[0]?.hasAttribute("aria-keyshortcuts")).toBe(false);
  });

  it("holds the column with an inert handle on the row being edited", () => {
    const onQueueMove = vi.fn();
    const container = renderQueue({
      queue: [waiting("a", 1), waiting("b", 2), waiting("c", 3)],
      editingId: "b",
      onQueueMove,
      onQueueRemove: vi.fn(),
    });

    const rows = [...container.querySelectorAll(".chat-queue__item")];
    const grips = rows.map((row) => row.querySelector(".chat-queue__grip"));
    expect(grips.every((grip) => grip !== null)).toBe(true);
    // The edited row holds the drain, so it splits the queue: neither neighbour
    // has anywhere to go, and every handle waits without leaving the column.
    expect(grips.map((grip) => grip!.hasAttribute("disabled"))).toEqual([true, true, true]);
    expect(rows[1]?.classList.contains("chat-queue__item--editing")).toBe(true);

    const event = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    grips[1]!.dispatchEvent(event);

    expect(onQueueMove).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("renders the inline editor while keeping other rows actionable", () => {
    const onQueueEdit = vi.fn();
    const onQueueSteer = vi.fn();
    const onQueueRemove = vi.fn();
    const container = renderQueue({
      canAbort: true,
      queue: [
        { id: "a", text: "a", createdAt: 1, sendState: "waiting-idle" },
        { id: "b", text: "b", createdAt: 2, sendState: "waiting-idle" },
        { id: "c", text: "c", createdAt: 3, sendState: "waiting-idle" },
      ],
      editingId: "b",
      onQueueEdit,
      onQueueSteer,
      onQueueMove: vi.fn(),
      onQueueRemove,
    });

    const rows = [...container.querySelectorAll(".chat-queue__item")];
    expect(rows[1]?.querySelector(".chat-queue__edit-input")).not.toBeNull();
    expect(rows[1]?.querySelector(".chat-queue__edit-submit")).not.toBeNull();
    expect(rows[1]?.querySelector(".chat-queue__edit-cancel")).not.toBeNull();
    expect(rows.map((row) => row.querySelector(".chat-queue__action") !== null)).toEqual([
      true,
      false,
      true,
    ]);

    const editItem = rows[0]?.querySelector("wa-dropdown-item[value='edit']");
    expect(editItem?.hasAttribute("disabled")).toBe(true);
    expect(rows[2]?.querySelector("wa-dropdown-item[value='edit']")?.hasAttribute("disabled")).toBe(
      true,
    );

    rows[2]?.querySelector<HTMLButtonElement>(".chat-queue__remove")?.click();
    expect(onQueueRemove).toHaveBeenCalledWith("c");
  });

  it("starts editing from a row double-click without stealing the reorder handle", () => {
    const onQueueEdit = vi.fn();
    const container = renderQueue({
      queue: [waiting("a", 1), waiting("b", 2)],
      onQueueEdit,
      onQueueMove: vi.fn(),
      onQueueRemove: vi.fn(),
    });

    container
      .querySelector(".chat-queue__text")
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onQueueEdit).toHaveBeenCalledWith("a");

    container
      .querySelectorAll(".chat-queue__grip")[1]
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onQueueEdit).toHaveBeenCalledTimes(1);
  });

  it("routes inline draft changes, submit, cancel, and keyboard shortcuts", () => {
    const onQueueEditChange = vi.fn();
    const onQueueEditSubmit = vi.fn();
    const onQueueEditCancel = vi.fn();
    const container = renderQueue({
      queue: [waiting("a", 1)],
      editingId: "a",
      editingText: "a draft",
      onQueueEditChange,
      onQueueEditSubmit,
      onQueueEditCancel,
      onQueueRemove: vi.fn(),
    });
    const editor = container.querySelector<HTMLTextAreaElement>(".chat-queue__edit-input")!;
    expect(editor.value).toBe("a draft");
    editor.value = "updated draft";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onQueueEditChange).toHaveBeenCalledWith("updated draft");
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onQueueEditCancel).toHaveBeenCalledOnce();
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
    );
    expect(onQueueEditSubmit).toHaveBeenCalledOnce();
  });

  it("keeps a row that already joined a run out of the reorder set", () => {
    const container = renderQueue({
      queue: [
        { id: "pending", text: "pending", createdAt: 1, pendingRunId: "run-1" },
        waiting("b", 2),
        waiting("c", 3),
      ],
      onQueueMove: vi.fn(),
      onQueueRemove: vi.fn(),
    });

    const rows = [...container.querySelectorAll(".chat-queue__item")];
    expect(
      rows.map((row) => row.querySelector(".chat-queue__grip")?.getAttribute("draggable")),
    ).toEqual(["false", "true", "true"]);
  });

  it("offers no move to a row alone between locked rows, and refuses a drop from across one", () => {
    const onQueueMove = vi.fn();
    const container = renderQueue({
      queue: [
        waiting("a", 1),
        { id: "locked", text: "locked", createdAt: 2, sendState: "unconfirmed" },
        waiting("b", 3),
        waiting("c", 4),
      ],
      onQueueMove,
      onQueueRemove: vi.fn(),
    });

    const rows = [...container.querySelectorAll(".chat-queue__item")];
    // "a" is a segment of one, so it has nothing to move against.
    expect(
      rows.map((row) => row.querySelector(".chat-queue__grip")?.getAttribute("draggable")),
    ).toEqual(["false", "false", "true", "true"]);

    const dataTransfer = {
      types: ["application/x-openclaw-queued-message"],
      getData: () => "c",
      setData: vi.fn(),
      dropEffect: "none",
      effectAllowed: "none",
    };
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    rows[0]!.dispatchEvent(drop);

    expect(onQueueMove).not.toHaveBeenCalled();
  });

  it("reports the drop position of the row the message was dropped on", () => {
    const onQueueMove = vi.fn();
    const container = renderQueue({
      queue: [waiting("a", 1), waiting("b", 2), waiting("c", 3)],
      onQueueMove,
      onQueueRemove: vi.fn(),
    });
    const rows = [...container.querySelectorAll(".chat-queue__item")];
    const dataTransfer = {
      types: ["application/x-openclaw-queued-message"],
      getData: () => "c",
      setData: vi.fn(),
      dropEffect: "none",
      effectAllowed: "none",
    };

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    rows[0]!.dispatchEvent(drop);

    expect(onQueueMove.mock.calls).toEqual([["c", 0]]);
  });
});
