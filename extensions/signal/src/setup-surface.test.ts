// Signal setup tests cover hosted first-account linking and manual fallbacks.
import type { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk/setup";
import { WizardCancelledError } from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SIGNAL_LINK_COMPLETED_CREDENTIAL } from "./setup-core.js";
import { signalSetupWizard } from "./setup-surface.js";

const mocks = vi.hoisted(() => ({
  detectBinary: vi.fn(),
  installSignalCli: vi.fn(),
  createLinkClient: vi.fn(),
  linkStop: vi.fn(async () => {}),
  rpc: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/setup-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/setup-tools")>()),
  detectBinary: mocks.detectBinary,
}));
vi.mock("./install-signal-cli.js", () => ({ installSignalCli: mocks.installSignalCli }));
vi.mock("./link-rpc.js", () => ({ createSignalLinkRpcClient: mocks.createLinkClient }));

type PrepareParams = Parameters<NonNullable<typeof signalSetupWizard.prepare>>[0];

function createPrompter(
  params: {
    confirm?: boolean;
    qrCode?: (value: Parameters<NonNullable<WizardPrompter["qrCode"]>>[0]) => Promise<unknown>;
    selectedAccount?: string;
  } = {},
) {
  const note = vi.fn(async () => {});
  const select = vi.fn(async () => params.selectedAccount ?? "+15555550123");
  const qrCode = params.qrCode
    ? vi.fn(params.qrCode)
    : vi.fn(async (value: Parameters<NonNullable<WizardPrompter["qrCode"]>>[0]) => value.settled);
  return {
    note,
    qrCode,
    select,
    prompter: {
      confirm: vi.fn(async () => params.confirm ?? false),
      note,
      qrCode,
      select,
    } as unknown as WizardPrompter,
  };
}

async function prepareSignal(params: {
  cfg?: OpenClawConfig;
  prompter?: WizardPrompter;
  signal?: AbortSignal;
  includeSignal?: boolean;
  beforePersistentEffect?: () => Promise<void>;
}) {
  const prepare = signalSetupWizard.prepare;
  if (!prepare) {
    throw new Error("expected Signal setup prepare hook");
  }
  const options: NonNullable<PrepareParams["options"]> = {
    allowSignalInstall: true,
    ...(params.includeSignal === false
      ? {}
      : { signal: params.signal ?? new AbortController().signal }),
    ...(params.beforePersistentEffect
      ? { beforePersistentEffect: params.beforePersistentEffect }
      : {}),
  };
  return await prepare({
    cfg: params.cfg ?? {},
    accountId: "default",
    credentialValues: {},
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    prompter: params.prompter ?? createPrompter().prompter,
    options,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.detectBinary.mockResolvedValue(true);
  mocks.installSignalCli.mockResolvedValue({ ok: true, cliPath: "/tools/signal-cli" });
  mocks.createLinkClient.mockImplementation(() => ({
    request: mocks.rpc,
    stop: mocks.linkStop,
  }));
});

describe("Signal hosted setup linking", () => {
  it("links the first managed-native account through one owned multi-account daemon", async () => {
    const events: string[] = [];
    const deviceLinkUri = "sgnl://linkdevice?uuid=test&pub_key=test";
    mocks.rpc.mockImplementation(async (method: string) => {
      events.push(method);
      if (method === "listAccounts") {
        return [];
      }
      if (method === "startLink") {
        return { deviceLinkUri };
      }
      if (method === "finishLink") {
        return { number: "+15555550123" };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const prompt = createPrompter({
      qrCode: async (value) => {
        events.push("qrCode");
        return await value.settled;
      },
    });

    const result = await prepareSignal({
      prompter: prompt.prompter,
    });

    expect(mocks.createLinkClient).toHaveBeenCalledWith({
      cliPath: "signal-cli",
      abortSignal: expect.any(AbortSignal),
    });
    expect(events).toEqual(["listAccounts", "startLink", "finishLink", "qrCode"]);
    expect(prompt.qrCode).toHaveBeenCalledWith({
      title: "Link Signal",
      message: "In Signal, open Settings → Linked devices and scan this QR code.",
      text: deviceLinkUri,
      expiresInMs: 120_000,
      settled: expect.any(Promise),
    });
    expect(result?.credentialValues).toEqual({
      signalNumber: "+15555550123",
      [SIGNAL_LINK_COMPLETED_CREDENTIAL]: "true",
    });
    expect(mocks.linkStop).toHaveBeenCalledOnce();

    const numberInput = signalSetupWizard.textInputs?.find(
      (input) => input.inputKey === "signalNumber",
    );
    expect(numberInput?.applyCurrentValue).toBe(true);
    expect(
      await numberInput?.shouldPrompt?.({
        cfg: {},
        accountId: "default",
        credentialValues: result?.credentialValues ?? {},
        currentValue: "+15555550123",
      }),
    ).toBe(false);
    expect(
      await signalSetupWizard.completionNote?.shouldShow?.({
        cfg: {},
        accountId: "default",
        credentialValues: result?.credentialValues ?? {},
      }),
    ).toBe(false);
  });

  it("reuses a selected local signal-cli account without starting another link", async () => {
    mocks.rpc.mockResolvedValueOnce([{ number: "+15555550125" }, { number: "+15555550123" }]);
    const prompt = createPrompter({ selectedAccount: "+15555550125" });

    const result = await prepareSignal({ prompter: prompt.prompter });

    expect(prompt.select).toHaveBeenCalledWith({
      message: "Choose the Signal account for OpenClaw",
      options: [
        { label: "+15555550123", value: "+15555550123" },
        { label: "+15555550125", value: "+15555550125" },
      ],
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(prompt.qrCode).not.toHaveBeenCalled();
    expect(result?.credentialValues?.signalNumber).toBe("+15555550125");
  });

  it("rejects stale hosted authority before starting device linking", async () => {
    const guardError = new Error("verified inference changed");
    const beforePersistentEffect = vi.fn(async () => {
      throw guardError;
    });
    const prompt = createPrompter();

    await expect(
      prepareSignal({
        prompter: prompt.prompter,
        beforePersistentEffect,
      }),
    ).rejects.toBe(guardError);

    expect(beforePersistentEffect).toHaveBeenCalledOnce();
    expect(mocks.createLinkClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(prompt.qrCode).not.toHaveBeenCalled();
  });

  it.each([
    { label: "without QR support", includeSignal: true, includeQr: false, cfg: {} },
    { label: "without hosted cancellation", includeSignal: false, includeQr: true, cfg: {} },
    {
      label: "for an already configured account",
      includeSignal: true,
      includeQr: true,
      cfg: { channels: { signal: { account: "+15555550123" } } } as OpenClawConfig,
    },
    {
      label: "for an external daemon",
      includeSignal: true,
      includeQr: true,
      cfg: {
        channels: {
          signal: {
            transport: { kind: "external-native", url: "http://127.0.0.1:8080" },
          },
        },
      } as OpenClawConfig,
    },
  ])("keeps the manual setup flow $label", async ({ includeSignal, includeQr, cfg }) => {
    const prompt = createPrompter();
    const prompter = includeQr
      ? prompt.prompter
      : ({ ...prompt.prompter, qrCode: undefined } as WizardPrompter);

    const result = await prepareSignal({
      cfg,
      prompter,
      includeSignal,
    });

    expect(mocks.createLinkClient).not.toHaveBeenCalled();
    expect(result?.credentialValues?.signalNumber).toBeUndefined();
    expect(
      await signalSetupWizard.completionNote?.shouldShow?.({
        cfg,
        accountId: "default",
        credentialValues: result?.credentialValues ?? {},
      }),
    ).toBe(true);
  });

  it.each([
    {
      label: "invalid start URI",
      responses: [[], { deviceLinkUri: "https://example.invalid/private-token" }],
    },
    {
      label: "invalid finish number",
      responses: [
        [],
        { deviceLinkUri: "sgnl://linkdevice?uuid=private-token&pub_key=test" },
        { number: "private-number" },
      ],
    },
  ])("falls back without exposing dependency data for an $label", async ({ responses }) => {
    for (const response of responses) {
      mocks.rpc.mockResolvedValueOnce(response);
    }
    const prompt = createPrompter();

    const result = await prepareSignal({ prompter: prompt.prompter });

    const notes = prompt.note.mock.calls.flat().map(String).join("\n");
    expect(result).toBeUndefined();
    expect(notes).toContain("Automatic Signal linking could not complete");
    expect(notes).not.toContain("private-token");
    expect(notes).not.toContain("private-number");
    expect(mocks.linkStop).toHaveBeenCalledOnce();
  });

  it("aborts linking and reaps its daemon without showing a dependency failure", async () => {
    const controller = new AbortController();
    mocks.rpc
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ deviceLinkUri: "sgnl://linkdevice?uuid=test&pub_key=test" })
      .mockReturnValueOnce(new Promise<never>(() => {}));
    const prompt = createPrompter({
      qrCode: async () => {
        controller.abort(new WizardCancelledError());
        throw new WizardCancelledError();
      },
    });

    await expect(
      prepareSignal({
        prompter: prompt.prompter,
        signal: controller.signal,
        beforePersistentEffect: vi.fn(async () => {}),
      }),
    ).rejects.toBeInstanceOf(WizardCancelledError);

    expect(prompt.note).not.toHaveBeenCalled();
    expect(mocks.linkStop).toHaveBeenCalledOnce();
  });
});
