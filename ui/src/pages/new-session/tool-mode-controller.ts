import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import type {
  PluginSessionToolMode,
  PluginsUiDescriptorsResult,
  SessionToolModeSelection,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import { syncDropdownItemRadio } from "../../components/web-awesome.ts";
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

  renderPicker(place: DraftPlaceState, context: ApplicationContext | undefined, disabled: boolean) {
    if (this.modes.length === 0) {
      return nothing;
    }
    const selection = this.selectionTarget.toolMode;
    const current = selection
      ? this.modes.find(
          (mode) => mode.pluginId === selection.pluginId && mode.id === selection.modeId,
        )
      : this.modes.find((mode) => mode.default === true);
    const runtimeId = place.modelControl
      .resolveAgentRuntime({ agent: place.selectedAgent(), context })
      ?.id.trim()
      .toLowerCase();
    const compatible = this.modes.some((mode) =>
      runtimeId ? mode.supportedRuntimeIds.includes(runtimeId) : true,
    );
    const title = compatible
      ? current?.controlLabel
      : `Available for ${this.modes.flatMap((mode) => mode.supportedRuntimeIds).join(", ")} sessions`;
    return html`<wa-dropdown class="new-session-page__select" placement="bottom-start">
      <button
        slot="trigger"
        type="button"
        class="new-session-page__trigger new-session-page__tool-mode-trigger"
        ?disabled=${!compatible || disabled}
        title=${title ?? "Tool mode"}
        aria-label=${`${current?.controlLabel ?? "Tool mode"}: ${current?.label ?? "Standard"}`}
      >
        <span class="new-session-page__trigger-label">${current?.label ?? "Standard"}</span>
        <span class="new-session-page__trigger-chevron" aria-hidden="true"
          >${icons.chevronDown}</span
        >
      </button>
      ${this.modes.map((mode) => {
        const checked = current?.pluginId === mode.pluginId && current.id === mode.id;
        return html`<wa-dropdown-item
          value=${`${mode.pluginId}:${mode.id}`}
          role="menuitemradio"
          aria-checked=${String(checked)}
          ${ref((element) => syncDropdownItemRadio(element, checked))}
          ?disabled=${checked}
          @click=${() => this.select({ pluginId: mode.pluginId, modeId: mode.id })}
        >
          ${mode.label}
        </wa-dropdown-item>`;
      })}
    </wa-dropdown>`;
  }

  private select(selection: SessionToolModeSelection | undefined): void {
    this.selectionTarget.toolMode = selection;
    this.requestUpdate();
  }
}
