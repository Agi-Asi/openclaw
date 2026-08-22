import type {
  PluginSessionToolMode,
  PluginsUiDescriptorsResult,
  SessionToolModeSelection,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";

export class NewSessionToolModeController {
  modes: PluginSessionToolMode[] = [];
  private client: GatewayBrowserClient | null = null;

  constructor(
    private readonly selectionTarget: { toolMode: SessionToolModeSelection | undefined },
    private readonly requestUpdate: () => void,
  ) {}

  async synchronize(client: GatewayBrowserClient | null): Promise<void> {
    if (!client || this.client === client) {
      return;
    }
    this.client = client;
    try {
      const result = await client.request<PluginsUiDescriptorsResult>("plugins.uiDescriptors", {});
      if (this.client !== client) {
        return;
      }
      this.modes = result.toolModes;
      const defaultMode = this.modes.find((mode) => mode.default === true);
      this.select(
        defaultMode ? { pluginId: defaultMode.pluginId, modeId: defaultMode.id } : undefined,
      );
    } catch {
      if (this.client === client) {
        this.modes = [];
        this.select(undefined);
      }
    }
  }

  synchronizeGateway(
    gateway: ApplicationContext["gateway"],
    draftGateway: DraftGatewayState,
  ): void {
    draftGateway.synchronize(gateway);
    void this.synchronize(gateway.snapshot.client ?? null);
  }

  composerOptions(place: DraftPlaceState, context: ApplicationContext | undefined) {
    return {
      toolModes: this.modes,
      toolMode: this.selectionTarget.toolMode,
      toolModeRuntimeId: place.modelControl.resolveAgentRuntime({
        agent: place.selectedAgent(),
        context,
      })?.id,
      onToolModeChange: (selection: SessionToolModeSelection) => this.select(selection),
    };
  }

  private select(selection: SessionToolModeSelection | undefined): void {
    this.selectionTarget.toolMode = selection;
    this.requestUpdate();
  }
}
