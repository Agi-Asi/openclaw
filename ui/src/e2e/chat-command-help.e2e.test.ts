import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI command help" });

suite.define(() => {
  it("opens /help as a searchable guide and prefills an agent question", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        ...(artifactDir
          ? { recordVideo: { dir: artifactDir, size: { width: 1280, height: 900 } } }
          : {}),
      },
      async ({ page }) => {
        const commands = [
          {
            acceptsArgs: true,
            category: "tools",
            description: "Pair a device with this Gateway.",
            name: "pair-device",
            scope: "both",
            source: "plugin",
            textAliases: ["/pair-device"],
          },
        ];
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "chat.startup": {
              agentsList: {
                agents: [{ id: "main", identity: { name: "Molty" }, name: "Molty" }],
                defaultId: "main",
                mainKey: "main",
                scope: "agent",
              },
              messages: [],
              metadata: { commands, models: [] },
              sessionId: "command-help-session",
              thinkingLevel: null,
            },
            "commands.list": { commands },
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible" });
        await expect.poll(() => composer.isEnabled()).toBe(true);
        await composer.fill("/help");
        await composer.press("Enter");

        const dialog = page.locator("openclaw-modal-dialog.command-help-dialog");
        await dialog.waitFor({ state: "visible" });
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await page.getByText("Available Commands", { exact: false }).count()).toBe(0);
        await dialog.getByRole("tab", { name: "Tools" }).click();
        await dialog.getByRole("button", { name: /pair-device/u }).click();
        await expect.poll(() => dialog.locator("code").textContent()).toContain("/pair-device");

        const search = dialog.getByRole("searchbox", { name: "Search commands" });
        await search.fill("pair device");
        await dialog
          .locator(".command-help-dialog__list")
          .getByText("Pair a device with this Gateway.")
          .waitFor();
        if (artifactDir) {
          await page.screenshot({
            path: path.join(artifactDir, "command-help-search.png"),
            fullPage: true,
          });
        }

        await dialog.getByRole("button", { name: /^Ask .+ about this$/u }).click();
        await dialog.waitFor({ state: "detached" });
        await expect.poll(() => composer.inputValue()).toContain("What does /pair-device do");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });
});
