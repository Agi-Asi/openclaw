import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";
import { buildThreadResumeParams, buildThreadStartParams } from "./thread-requests.js";
import { buildTurnStartParams } from "./turn-params.js";

const FROZEN_PARENT = "2d25f59b4a50b9f6579ae6d203f68616888f4fec";
const CODEX_COMMIT = "758ef40f50c1a458425c7cfbf1eb12cbc07af0b0";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REPO_ROOT_URL = new URL("../../../../", import.meta.url);
const REPO_ROOT = fileURLToPath(REPO_ROOT_URL);
const PROOF_FIXTURE_PATH =
  "extensions/codex/src/app-server/fixtures/approval-policy-v0.149.proof.json";
const REQUIRED_APPROVAL_SURFACES = [
  "extensions/codex/openclaw.plugin.json",
  "extensions/codex/doctor-contract-api.ts",
] as const;

type CommandReceipt = {
  command: string;
  durationMs: number;
  exitCode: number;
  outputSha256: string;
};

type ApprovalProof = {
  schemaVersion: number;
  bindingSha256: string;
  openclaw: {
    frozenParent: string;
    adapterSources: Array<{ path: string; sha256: string }>;
    candidateDiffSha256: string;
  };
  codex: {
    version: string;
    tag: string;
    commit: string;
    toolchain: { cargo: string; rustc: string; host: string };
    checkedInLock: {
      sha256: string;
      lockedPreflight: CommandReceipt;
    };
    generatedLock: {
      sha256: string;
      diffSha256: string;
      derivation: CommandReceipt;
    };
  };
  upstreamReceipts: Array<
    CommandReceipt & {
      case: string;
      test: string;
      contract: string;
      source: string;
    }
  >;
  openclawAdapter: {
    approvalPolicy: "on-request";
    requestMethods: string[];
  };
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("approval proof contains an unsupported value");
  }
  return serialized;
}

function computeBinding(proof: ApprovalProof): string {
  const { bindingSha256: _bindingSha256, ...bound } = proof;
  return sha256(canonicalJson(bound));
}

type CandidateSurface = {
  parent: string;
  diffSha256: string;
};

function gitOutput(args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readCandidateSurface(): CandidateSurface {
  const diff = execFileSync(
    "git",
    [
      "diff",
      "--binary",
      "--full-index",
      FROZEN_PARENT,
      "HEAD",
      "--",
      ".",
      `:(exclude)${PROOF_FIXTURE_PATH}`,
    ],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  return { parent: gitOutput(["rev-parse", "HEAD^"]), diffSha256: sha256(diff) };
}

function verifyApprovalProof(proof: ApprovalProof, candidate = readCandidateSurface()): void {
  if (proof.schemaVersion !== 3) {
    throw new Error("unsupported approval proof schema");
  }
  if (proof.bindingSha256 !== computeBinding(proof)) {
    throw new Error("approval proof binding mismatch");
  }
  if (proof.openclaw.frozenParent !== FROZEN_PARENT) {
    throw new Error("approval proof frozen parent mismatch");
  }
  if (candidate.parent !== proof.openclaw.frozenParent) {
    throw new Error("approval proof candidate parent mismatch");
  }
  if (candidate.diffSha256 !== proof.openclaw.candidateDiffSha256) {
    throw new Error("approval proof candidate surface mismatch");
  }
  const adapterPaths = new Set(proof.openclaw.adapterSources.map((source) => source.path));
  for (const path of REQUIRED_APPROVAL_SURFACES) {
    if (!adapterPaths.has(path)) {
      throw new Error(`approval proof omits required surface: ${path}`);
    }
  }
  if (
    proof.codex.version !== "0.149.0" ||
    proof.codex.tag !== "rust-v0.149.0" ||
    proof.codex.commit !== CODEX_COMMIT
  ) {
    throw new Error("approval proof Codex source mismatch");
  }
  for (const source of proof.openclaw.adapterSources) {
    const actual = sha256(fs.readFileSync(new URL(source.path, REPO_ROOT_URL)));
    if (source.sha256 !== actual) {
      throw new Error(`approval proof adapter source is stale: ${source.path}`);
    }
  }
  const commandReceipts = [
    proof.codex.checkedInLock.lockedPreflight,
    proof.codex.generatedLock.derivation,
    ...proof.upstreamReceipts,
  ];
  for (const receipt of commandReceipts) {
    if (
      receipt.durationMs <= 0 ||
      !Number.isInteger(receipt.exitCode) ||
      !SHA256_PATTERN.test(receipt.outputSha256)
    ) {
      throw new Error(`invalid command receipt: ${receipt.command}`);
    }
  }
  if (
    proof.codex.checkedInLock.lockedPreflight.exitCode === 0 ||
    proof.codex.generatedLock.derivation.exitCode !== 0 ||
    !SHA256_PATTERN.test(proof.codex.checkedInLock.sha256) ||
    !SHA256_PATTERN.test(proof.codex.generatedLock.sha256) ||
    !SHA256_PATTERN.test(proof.codex.generatedLock.diffSha256)
  ) {
    throw new Error("invalid Cargo.lock derivation receipt");
  }
  if (
    proof.upstreamReceipts.length !== 3 ||
    proof.upstreamReceipts.some((receipt) => receipt.exitCode !== 0)
  ) {
    throw new Error("incomplete upstream approval matrix");
  }
}

const proof = JSON.parse(
  fs.readFileSync(new URL("./fixtures/approval-policy-v0.149.proof.json", import.meta.url), "utf8"),
) as ApprovalProof;
const pluginPackage = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { dependencies?: Record<string, string> };

afterEach(() => resetThreadLifecycleTestFixtures());

describe("Codex 0.149 approval policy proof", () => {
  it("binds machine receipts to the complete frozen candidate surface", () => {
    verifyApprovalProof(proof);
    expect(pluginPackage.dependencies?.["@openai/codex"]).toBe(proof.codex.version);
    expect(proof.upstreamReceipts.map((receipt) => [receipt.case, receipt.test])).toEqual([
      ["safe-sandboxed", "git_status_obeys_approval_policy_and_explicit_rules"],
      ["dangerous", "dangerous_rm_rf_requires_approval_in_danger_full_access"],
      ["escalated", "exec_approval_requirement_prompts_for_known_safe_escalation_under_on_request"],
    ]);

    const params = createParams("/tmp/openclaw-codex-approval-proof.jsonl", "/tmp");
    const appServer = createAppServerOptions();
    appServer.approvalPolicy = proof.openclawAdapter.approvalPolicy;
    const start = buildThreadStartParams(params, {
      cwd: "/tmp",
      dynamicTools: [],
      appServer,
    });
    const resume = buildThreadResumeParams(params, {
      threadId: "thread-proof",
      cwd: "/tmp",
      dynamicTools: [],
      appServer,
    });
    const turn = buildTurnStartParams(params, {
      threadId: "thread-proof",
      cwd: "/tmp",
      appServer,
    });

    expect({
      "thread/start": start.approvalPolicy,
      "thread/resume": resume.approvalPolicy,
      "turn/start": turn.approvalPolicy,
    }).toEqual({
      "thread/start": "on-request",
      "thread/resume": "on-request",
      "turn/start": "on-request",
    });
  });

  it("rejects tampered receipts and stale adapter bindings", () => {
    const tampered = structuredClone(proof);
    tampered.upstreamReceipts[0]!.outputSha256 = "0".repeat(64);
    expect(() => verifyApprovalProof(tampered)).toThrow("binding mismatch");

    const stale = structuredClone(proof);
    stale.openclaw.adapterSources[0]!.sha256 = "0".repeat(64);
    stale.bindingSha256 = computeBinding(stale);
    expect(() => verifyApprovalProof(stale)).toThrow("adapter source is stale");

    const candidate = readCandidateSurface();
    expect(() =>
      verifyApprovalProof(proof, {
        ...candidate,
        parent: "0".repeat(40),
      }),
    ).toThrow("candidate parent mismatch");

    const staleSurface = structuredClone(proof);
    staleSurface.openclaw.candidateDiffSha256 = "0".repeat(64);
    staleSurface.bindingSha256 = computeBinding(staleSurface);
    expect(() => verifyApprovalProof(staleSurface, candidate)).toThrow(
      "candidate surface mismatch",
    );
  });
});
