import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("keeps rail privacy visible and shows the mobile footer mode without hover", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        hasTouch: true,
        viewport: { height: 740, width: 364 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          models: [
            {
              id: "gpt-5.6-luna",
              name: "GPT 5.6 Luna",
              provider: "openai",
              contextWindow: 400_000,
            },
            {
              id: "claude-sonnet-4-6",
              name: "Claude Sonnet 4.6",
              provider: "anthropic",
              contextWindow: 200_000,
            },
          ],
          allowedSessionVisibilities: ["shared", "draft"],
          hasMultipleSessionSharingIdentities: true,
        });
        await page.goto(`${suite.server.baseUrl}new`);
        const footer = page.locator(".new-session-page__composer .agent-chat__composer-footer");
        const attach = page.getByRole("button", { name: "Add attachment" });
        const takePhoto = page.getByRole("menuitem", { name: "Take photo" });
        const permission = page.locator(".chat-controls__permission-trigger");
        const draft = page.locator('.new-session-page__visibility--draft[aria-label="Draft"]');
        const incognito = page.getByRole("switch", { name: "Incognito" });
        const model = page.locator(".new-session-page__composer .chat-composer-model-control");
        const effort = page.locator('[data-chat-thinking-select="true"]');
        const microphone = page.locator(".chat-send-btn--voice");
        const microphonePicker = page.locator(".chat-talk-input-picker__trigger");
        const start = page.locator(".new-session-page__start-submit");
        await Promise.all([
          footer.waitFor(),
          attach.waitFor(),
          permission.waitFor(),
          draft.waitFor({ state: "attached" }),
          incognito.waitFor(),
          model.waitFor(),
          effort.waitFor(),
          microphone.waitFor(),
          microphonePicker.waitFor(),
          start.waitFor(),
        ]);

        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.mouse.move(0, 0);
        await expect
          .poll(() => incognito.evaluate((element) => getComputedStyle(element).opacity))
          .toBe("1");
        await expect
          .poll(() => draft.evaluate((element) => getComputedStyle(element).opacity))
          .toBe("1");
        expect(
          await incognito.evaluate(
            (element) => element.closest(".new-session-page__incognito-rail") != null,
          ),
        ).toBe(true);

        const [
          footerBox,
          attachBox,
          permissionBox,
          draftBox,
          modelBox,
          microphoneBox,
          microphonePickerBox,
          startBox,
        ] = await Promise.all([
          footer.boundingBox(),
          attach.boundingBox(),
          permission.boundingBox(),
          draft.boundingBox(),
          model.boundingBox(),
          microphone.boundingBox(),
          microphonePicker.boundingBox(),
          start.boundingBox(),
        ]);
        expect(footerBox).not.toBeNull();
        expect(attachBox).not.toBeNull();
        expect(permissionBox).not.toBeNull();
        expect(draftBox).not.toBeNull();
        expect(modelBox).not.toBeNull();
        expect(microphoneBox).not.toBeNull();
        expect(microphonePickerBox).not.toBeNull();
        expect(startBox).not.toBeNull();
        const sequence = [attachBox, permissionBox, draftBox, modelBox, microphoneBox, startBox];
        for (let index = 1; index < sequence.length; index += 1) {
          const previous = sequence[index - 1];
          const next = sequence[index];
          expect(next?.x ?? 0).toBeGreaterThanOrEqual(
            (previous?.x ?? 0) + (previous?.width ?? 0) - 2,
          );
          expect(
            Math.abs(
              (next?.y ?? 0) +
                (next?.height ?? 0) / 2 -
                ((attachBox?.y ?? 0) + (attachBox?.height ?? 0) / 2),
            ),
          ).toBeLessThanOrEqual(2);
        }
        expect(
          (draftBox?.x ?? 0) - ((permissionBox?.x ?? 0) + (permissionBox?.width ?? 0)),
        ).toBeLessThanOrEqual(2);
        for (const control of [
          attachBox,
          permissionBox,
          draftBox,
          modelBox,
          microphoneBox,
          startBox,
        ]) {
          expect(control?.x ?? 0).toBeGreaterThanOrEqual(footerBox?.x ?? 0);
          expect((control?.x ?? 0) + (control?.width ?? 0)).toBeLessThanOrEqual(
            (footerBox?.x ?? 0) + (footerBox?.width ?? 0),
          );
        }
        expect(await footer.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(
          0,
        );
        expect(microphonePickerBox?.x ?? 0).toBeGreaterThanOrEqual(
          (microphoneBox?.x ?? 0) +
            (microphoneBox?.width ?? 0) -
            (microphonePickerBox?.width ?? 0) -
            4,
        );
        expect(
          (microphonePickerBox?.x ?? 0) + (microphonePickerBox?.width ?? 0),
        ).toBeLessThanOrEqual((microphoneBox?.x ?? 0) + (microphoneBox?.width ?? 0) + 4);

        expect(await effort.locator(".chat-controls__effort-icon svg").count()).toBe(1);
        await expect
          .poll(() =>
            effort
              .locator(".chat-controls__inline-select-chevron")
              .evaluate((element) => getComputedStyle(element).display),
          )
          .toBe("none");
        await effort.click();
        await page.locator(".chat-controls__effort-menu").waitFor();
        const [composerBox, effortMenuBox] = await Promise.all([
          page.locator(".new-session-page__composer").boundingBox(),
          page.locator(".chat-controls__effort-menu").boundingBox(),
        ]);
        expect(composerBox).not.toBeNull();
        expect(effortMenuBox).not.toBeNull();
        expect((effortMenuBox?.y ?? 0) + (effortMenuBox?.height ?? 0)).toBeLessThanOrEqual(
          (composerBox?.y ?? 0) - 5,
        );
        expect(await page.locator('.chat-controls__effort-menu input[type="range"]').count()).toBe(
          1,
        );
        await page.keyboard.press("Escape");

        await attach.click();
        await expect.poll(() => takePhoto.isVisible()).toBe(true);
        const attachGlyphSine = () =>
          attach.evaluate((element) => {
            const { transform } = getComputedStyle(element.querySelector("svg") as SVGElement);
            return transform === "none"
              ? 0
              : Number(transform.slice(transform.indexOf("(") + 1).split(",")[1]);
          });
        await expect.poll(attachGlyphSine).toBeCloseTo(-Math.SQRT1_2, 3);
        await page.keyboard.press("Escape");
        await expect.poll(attachGlyphSine).toBe(0);
        await incognito.click();
        await expect.poll(() => incognito.getAttribute("aria-checked")).toBe("true");
      },
    );
  });

  it("creates the first turn with Draft and selected capabilities atomically", async () => {
    await suite.withPage({ viewport: { width: 555, height: 1200 } }, async ({ page }) => {
      const config = {
        mcp: {
          servers: {
            github: { enabled: true, url: "https://mcp.example.test" },
          },
        },
        tools: { web: { search: { provider: "brave" } } },
      };
      const gateway = await installMockGateway(page, {
        allowedSessionVisibilities: ["shared", "draft"],
        hasMultipleSessionSharingIdentities: true,
        operatorScopes: ["operator.read", "operator.write", "operator.admin"],
        methodResponses: {
          "config.get": {
            raw: JSON.stringify(config),
            hash: "new-session-capabilities",
            sourceConfig: config,
            runtimeConfig: config,
            config,
          },
          "skills.status": {
            workspaceDir: "/tmp/openclaw-e2e/workspace",
            managedSkillsDir: "/tmp/openclaw-e2e/skills",
            skills: [
              {
                name: "Release",
                description: "Prepare a release",
                source: "test",
                filePath: "/tmp/openclaw-e2e/skills/release/SKILL.md",
                baseDir: "/tmp/openclaw-e2e/skills/release",
                skillKey: "release",
                always: false,
                disabled: false,
                blockedByAllowlist: false,
                eligible: true,
                requirements: { anyBins: [], bins: [], env: [], config: [], os: [] },
                missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
                configChecks: [],
                install: [],
              },
            ],
          },
          "sessions.create": {
            key: "agent:main:new-session-capabilities",
            runStarted: true,
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      const composer = page.locator(".new-session-page__composer");
      const menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
      await composer.getByRole("button", { name: "Add attachment" }).click();
      await expect.poll(() => menu.getAttribute("data-view")).toBe("root");

      await menu.getByRole("menuitem", { name: "Draft" }).click();
      await menu.getByRole("menuitem", { name: /^Skills/ }).click();
      await expect.poll(() => menu.getAttribute("data-view")).toBe("skills");
      const release = menu.getByRole("menuitem", { name: "Release" });
      await expect.poll(() => release.isEnabled()).toBe(true);
      await release.click();
      await menu.getByRole("menuitem", { name: "Back" }).click();

      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await expect.poll(() => menu.getAttribute("data-view")).toBe("connectors");
      await menu.getByRole("menuitem", { name: /^github/ }).click();
      await menu.getByRole("menuitem", { name: "Back" }).click();
      await menu.getByRole("menuitemcheckbox", { name: "Web search" }).click();

      await expect
        .poll(async () =>
          (await composer.locator(".new-session-page__selection-status").allTextContents()).map(
            (text) => text.replace(/\s+/g, " ").trim(),
          ),
        )
        .toEqual(["3 overrides"]);
      await page.locator(".new-session-page__message").fill("prepare the release");
      await composer.getByRole("button", { name: "Start session" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "prepare the release",
        visibility: "draft",
        toolOverrides: {
          mcpServers: { github: false },
          skills: { release: false },
          webSearch: false,
        },
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    });
  });
});
