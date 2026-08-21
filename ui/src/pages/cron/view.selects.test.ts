// Control UI tests cover authoritative values in Automations (cron) selects.
import { describe, expect, it } from "vitest";
import { renderCronView as renderView } from "./view.test-support.ts";

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
