import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Developer Mode Tool mode" });
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "developer-mode");

const toolModes = [
  {
    pluginId: "developer-mode",
    pluginName: "Developer Mode",
    id: "standard",
    label: "Standard",
    description: "Best for most work",
    sectionLabel: "Developer",
    controlLabel: "Tool mode",
    default: true,
    supportedRuntimeIds: ["openclaw"],
    toolProfile: "coding",
    codeMode: "direct",
  },
  {
    pluginId: "developer-mode",
    pluginName: "Developer Mode",
    id: "code",
    label: "Code",
    description: "Combine several actions efficiently",
    sectionLabel: "Developer",
    controlLabel: "Tool mode",
    supportedRuntimeIds: ["openclaw"],
    toolProfile: "coding",
    codeMode: "code",
  },
  {
    pluginId: "developer-mode",
    pluginName: "Developer Mode",
    id: "minimal",
    label: "Minimal",
    description: "Use a smaller, focused toolset",
    sectionLabel: "Developer",
    controlLabel: "Tool mode",
    supportedRuntimeIds: ["openclaw"],
    toolProfile: "minimal",
    codeMode: "direct",
  },
];

suite.define(() => {
  it("selects Tool mode from the session menu", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "plugins.uiDescriptors": { ok: true, descriptors: [], toolModes },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      await page.locator(".chat-header-session-menu__trigger").click();
      const toolMode = page.getByRole("menuitem", { name: "Tool mode" });
      await toolMode.waitFor();
      await toolMode.hover();
      if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
        await mkdir(proofDir, { recursive: true });
        await page.screenshot({ path: path.join(proofDir, "session-menu-code.png") });
      }
      await page.getByRole("menuitemradio", { name: "Code" }).click();

      const patch = await gateway.waitForRequest("sessions.patch");
      expect(patch.params).toMatchObject({
        toolMode: { pluginId: "developer-mode", modeId: "code" },
      });
    });
  });

  it("selects Tool mode before creating a session", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "plugins.uiDescriptors": { ok: true, descriptors: [], toolModes },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const picker = page.locator(".new-session-page__tool-mode-trigger");
      await picker.waitFor();
      await picker.click();
      await page.getByRole("menuitemradio", { name: "Minimal" }).click();
      if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
        await mkdir(proofDir, { recursive: true });
        await page.screenshot({ path: path.join(proofDir, "new-session-minimal.png") });
      }
      await page.locator(".new-session-page__message").fill("Start a focused session");
      await page.getByRole("button", { name: "Start session" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        toolMode: { pluginId: "developer-mode", modeId: "minimal" },
      });
    });
  });
});
