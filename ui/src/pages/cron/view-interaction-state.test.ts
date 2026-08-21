// Control UI tests cover Automations interaction state and selected values.
import { describe, expect, it, vi } from "vitest";
import {
  createCronViewJob as createJob,
  renderCronView as renderView,
} from "./view.test-support.ts";

function getElement<T extends Element>(
  container: Element,
  selector: string,
  constructor: new () => T,
): T {
  const element = container.querySelector<T>(selector);
  expect(element).toBeInstanceOf(constructor);
  if (!(element instanceof constructor)) {
    throw new Error(`Expected ${selector} to match ${constructor.name}`);
  }
  return element;
}

describe("cron view interaction state", () => {
  it("locks the editor and back navigation while a save is pending", () => {
    const job = createJob("job-1", { name: "Nightly digest" });
    const container = renderView({ jobs: [job], editingJob: job, busy: true });

    const editor = getElement(container, ".cron-editor", HTMLFieldSetElement);
    const name = getElement(container, "#cron-name", HTMLInputElement);
    const back = getElement(container, '[data-test-id="cron-back"]', HTMLButtonElement);
    const submit = getElement(container, '[data-test-id="cron-submit"]', HTMLButtonElement);

    expect(editor.disabled).toBe(true);
    expect(editor.getAttribute("aria-busy")).toBe("true");
    expect(name.matches(":disabled")).toBe(true);
    expect(back.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain("Saving");
  });

  it("shows run history instead of the editor on the history tab", () => {
    const job = createJob("job-1", {
      name: "Nightly digest",
      description: "Saved description stays visible in history",
    });
    const container = renderView({
      jobs: [job],
      editingJob: job,
      detailTab: "history",
      runs: [
        {
          ts: 5,
          jobId: "job-1",
          action: "finished",
          jobName: "Nightly digest",
          status: "ok",
          summary: "ran",
        },
      ],
    });
    expect(container.querySelector(".cron-run-entry")).not.toBeNull();
    expect(container.querySelector(".cron-editor")).toBeNull();
    const description = container.querySelector('[data-test-id="cron-detail-description"]');
    expect(description?.textContent).toContain(job.description);
  });

  it("shows the paused switch state for disabled jobs", () => {
    const onToggle = vi.fn();
    const job = createJob("job-1", { enabled: false });
    const container = renderView({
      jobs: [],
      editingJob: job,
      onToggle,
    });
    const toggle = getElement(container, '[data-test-id="cron-toggle-enabled"]', HTMLSpanElement);
    const toggleInput = getElement(toggle, "wa-switch", HTMLElement) as HTMLElement & {
      checked: boolean;
    };
    expect(toggleInput.checked).toBe(false);
    expect(toggle.textContent).toContain("Paused");
    toggleInput.checked = true;
    toggleInput.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onToggle).toHaveBeenCalledWith(job, true);
  });

  it("renders model-picker suggestions with the remaining text datalists", () => {
    const container = renderView({
      createOpen: true,
      agentSuggestions: ["main"],
      modelSuggestions: ["openai/gpt-5.2"],
      thinkingSuggestions: ["low"],
      timezoneSuggestions: ["UTC"],
      deliveryToSuggestions: ["+15551234"],
      accountSuggestions: ["default"],
    });
    for (const id of [
      "cron-agent-suggestions",
      "cron-thinking-suggestions",
      "cron-tz-suggestions",
      "cron-delivery-to-suggestions",
      "cron-delivery-account-suggestions",
    ]) {
      expect(container.querySelector(`datalist#${id}`)).not.toBeNull();
    }
    const model = getElement(container, "#cron-payload-model-picker", HTMLElement);
    expect(model.querySelector('wa-option[value="openai/gpt-5.2"]')).not.toBeNull();
    expect(model.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>("#cron-payload-model")?.hidden).toBe(true);
    // The inherit option must resolve to a real catalog string — a missing key
    // renders the raw "common.default" literal to every locale.
    const inheritText = model.querySelector('wa-option[value=""]')?.textContent ?? "";
    expect(inheritText).toContain("Default");
    expect(inheritText).not.toContain("common.default");
  });
});

describe("cron view selects", () => {
  it("shows authoritative form values instead of first options in the create form", () => {
    const container = renderView({ createOpen: true });
    const action = getElement(
      container,
      "wa-select#cron-payload-kind",
      HTMLElement,
    ) as HTMLElement & {
      value: string;
    };
    expect(action.querySelector("wa-option[selected]")?.getAttribute("value")).toBe("agentTurn");
    const runsIn = getElement(
      container,
      "wa-select#cron-session-target",
      HTMLElement,
    ) as HTMLElement & { value: string };
    expect(runsIn.querySelector("wa-option[selected]")?.getAttribute("value")).toBe("isolated");
    const unit = Array.from(
      container.querySelectorAll<HTMLElement & { value: string }>("wa-select"),
    ).find((select) => select.querySelector('[slot="label"]')?.textContent === "Unit");
    expect(unit?.querySelector("wa-option[selected]")?.getAttribute("value")).toBe("minutes");
    // Negative control: the delivery-mode default is also the first option, so
    // this passes before and after the fix and proves the harness reads selects.
    const delivery = getElement(
      container,
      "wa-select#cron-delivery-mode",
      HTMLElement,
    ) as HTMLElement & { value: string };
    expect(delivery.querySelector("wa-option[selected]")?.getAttribute("value")).toBe("announce");
  });

  it("shows persisted non-first values in jobs filters and runs sort", () => {
    const activity = renderView({ listTab: "activity", runsSortDir: "asc" });
    const sort = getElement(activity, "select.cron-run-sort", HTMLSelectElement);
    expect(sort.value).toBe("asc");
    expect(sort.querySelector('option[value="asc"]')?.hasAttribute("selected")).toBe(true);
    const tasks = renderView({ jobsLastStatusFilter: "error" });
    const lastStatus = getElement(
      tasks,
      'select[data-test-id="cron-jobs-last-status-filter"]',
      HTMLSelectElement,
    );
    expect(lastStatus.value).toBe("error");
  });
});
