import type { SessionPermissionMode } from "../../../../packages/gateway-protocol/src/index.js";

export class NewSessionPermissionSelection {
  value: SessionPermissionMode | undefined;

  constructor(private readonly requestUpdate: () => void) {}

  set(value: SessionPermissionMode | undefined) {
    this.value = value;
    this.requestUpdate();
  }

  reset() {
    this.value = undefined;
  }
}
