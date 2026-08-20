// Covers exec sandbox host audit findings.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectSecurityAuditFindings } from "./audit.test-support.js";
import type { SecurityAuditFinding } from "./audit.types.js";

function hasFinding(
  checkId:
    | "tools.exec.host_sandbox_no_sandbox_defaults"
    | "tools.exec.host_sandbox_no_sandbox_agents",
  findings: SecurityAuditFinding[],
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === "warn");
}

describe("security audit exec sandbox host findings", () => {
  const cases: Array<{
    name: string;
    cfg: OpenClawConfig;
    checkId: Parameters<typeof hasFinding>[0];
  }> = [
    {
      name: "defaults host is sandbox",
      cfg: {
        tools: {
          exec: {
            host: "sandbox",
          },
        },
        agents: {
          ownership: "explicit",
          entries: { main: {} },
          defaults: {
            systemAgent: { agentId: "main" },
            sandbox: {
              mode: "off",
            },
          },
        },
      } satisfies OpenClawConfig,
      checkId: "tools.exec.host_sandbox_no_sandbox_defaults" as const,
    },
    {
      name: "agent override host is sandbox",
      cfg: {
        tools: {
          exec: {
            host: "gateway",
          },
        },
        agents: {
          ownership: "explicit",
          defaults: {
            systemAgent: { agentId: "ops" },
            sandbox: {
              mode: "off",
            },
          },
          entries: {
            ops: {
              tools: {
                exec: {
                  host: "sandbox",
                },
              },
            },
          },
        },
      } satisfies OpenClawConfig,
      checkId: "tools.exec.host_sandbox_no_sandbox_agents" as const,
    },
  ];

  it.each(cases)("$name", async ({ cfg, checkId }) => {
    expect(hasFinding(checkId, await collectSecurityAuditFindings(cfg))).toBe(true);
  });
});
