import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

function skillCommand(name: string) {
  return {
    name,
    textAliases: [`/${name}`],
    description: `${name} skill`,
    source: "skill",
    scope: "text",
    acceptsArgs: false,
    skillModelVisible: true,
  };
}

suite.define(() => {
  it("scopes skills to the selected agent and refreshes an open menu", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "commands.list",
        "sessions.create",
        "sessions.dispatch",
      ],
      methodResponses: {
        "agents.list": {
          agents: [{ id: "main" }, { id: "research" }],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "chat.metadata": { models: [] },
        "commands.list": {
          commands: [skillCommand("research_before")],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new?agent=research`);
      const textarea = page.locator(".new-session-page__message");
      await textarea.waitFor({ state: "visible" });
      await textarea.fill("$");
      const menu = page.locator(".skill-menu");
      await pollLocatorText(menu).toContain("research_before");
      expect((await gateway.waitForRequest("commands.list")).params).toEqual({
        agentId: "research",
        includeArgs: true,
        scope: "text",
      });

      await gateway.setMethodResponse("commands.list", {
        commands: [skillCommand("research_after")],
      });
      await gateway.emitGatewayEvent("skills.changed", {});

      await pollLocatorText(menu).toContain("research_after");
      expect(await menu.textContent()).not.toContain("research_before");
      expect(await gateway.getRequests("commands.list")).toHaveLength(2);

      await gateway.setMethodResponse("commands.list", {
        commands: [skillCommand("main_after")],
      });
      const agentPicker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").evaluate((trigger) => {
        (trigger as HTMLButtonElement).click();
      });
      await agentPicker.getByRole("menuitemradio", { name: "main", exact: true }).click();

      await pollLocatorText(menu).toContain("main_after");
      expect(await textarea.inputValue()).toBe("$");
      expect((await gateway.getRequests("commands.list")).at(-1)?.params).toEqual({
        agentId: "main",
        includeArgs: true,
        scope: "text",
      });
      expect(await menu.textContent()).not.toContain("research_after");
    } finally {
      await context.close();
    }
  });
});
