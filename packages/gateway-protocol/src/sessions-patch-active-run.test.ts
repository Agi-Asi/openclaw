import { describe, expect, it } from "vitest";
import { validateSessionsPatchParams } from "./index.js";

describe("sessions.patch active run policy", () => {
  it("accepts the closed policy and rejects unknown values", () => {
    expect(
      validateSessionsPatchParams({
        key: "agent:main:policy-patch",
        permissionMode: "full",
        expectedSessionId: "session-policy-patch",
        expectedLifecycleRevision: "revision-policy-patch",
        activeRunPolicy: "stop-and-continue",
      }),
    ).toBe(true);
    expect(
      validateSessionsPatchParams({
        key: "agent:main:policy-patch",
        activeRunPolicy: "continue",
      }),
    ).toBe(false);
  });
});
