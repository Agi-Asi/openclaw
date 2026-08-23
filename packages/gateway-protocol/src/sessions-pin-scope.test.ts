// Session pin-scope schema tests protect the additive single and bulk patch contract.
import { expect, it } from "vitest";
import {
  validateSessionsPatchManyParams,
  validateSessionsPatchParams,
} from "./validator-registry.js";

it("validates additive session pin scopes", () => {
  for (const pinScope of ["group", "global", null]) {
    expect(validateSessionsPatchParams({ key: "agent:main:main", pinScope })).toBe(true);
  }
  expect(validateSessionsPatchParams({ key: "agent:main:main", pinScope: "workspace" })).toBe(
    false,
  );

  for (const pinScope of ["group", null]) {
    expect(
      validateSessionsPatchManyParams({
        targets: [{ key: "agent:main:main" }],
        patch: { pinScope },
      }),
    ).toBe(true);
  }
  expect(
    validateSessionsPatchManyParams({
      targets: [{ key: "agent:main:main" }],
      patch: { pinScope: "workspace" },
    }),
  ).toBe(false);
});
