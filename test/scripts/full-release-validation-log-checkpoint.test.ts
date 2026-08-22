import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  encodeFullReleaseValidationLogCheckpoint,
  parseFullReleaseValidationLogCheckpoint,
  readFullReleaseValidationLogCheckpointFromGitHub,
  recoverFullReleaseValidationLogCheckpoint,
} from "../../scripts/lib/full-release-validation-log-checkpoint.mjs";

const SHA = "a".repeat(40);
const TARGET_SHA = "b".repeat(40);

function provenance(runAttempt = 1) {
  return {
    runAttempt,
    runId: "123",
    targetSha: TARGET_SHA,
    workflowId: 456,
    workflowPath: ".github/workflows/full-release-validation.yml",
    workflowSha: SHA,
  };
}

function expected(kind: "plan" | "decision" | "drain", runAttempt = 1) {
  const producerJobKey = {
    decision: "release_decision",
    drain: "diagnostic_drain",
    plan: "release_execution_plan",
  }[kind];
  return { ...provenance(runAttempt), kind, producerJobKey };
}

function checkpointLog(kind: "plan" | "decision" | "drain", payload: unknown, runAttempt = 1) {
  return encodeFullReleaseValidationLogCheckpoint({
    kind,
    payload,
    provenance: provenance(runAttempt),
  }).join("\n");
}

describe("full release validation log checkpoints", () => {
  it("round-trips exact JSON bytes through timestamped ANSI logs", () => {
    const payload = { children: ["npm", "clawhub"], state: "passed" };
    const log = checkpointLog("decision", payload)
      .split("\n")
      .map((line) => `2026-08-21T12:34:56.000Z \u001b[32m${line}\u001b[0m`)
      .join("\r\n");
    expect(parseFullReleaseValidationLogCheckpoint(log, expected("decision"))).toMatchObject({
      payload,
    });
  });

  it("bounds payload bytes and chunks", () => {
    expect(() => checkpointLog("plan", { value: "x".repeat(128 * 1024) })).toThrow("size limit");
    const payload = { value: "x".repeat(70_000) };
    const lines = checkpointLog("plan", payload).split("\n");
    expect(lines.length).toBeGreaterThan(3);
    expect(
      parseFullReleaseValidationLogCheckpoint(lines.join("\n"), expected("plan"))?.payload,
    ).toEqual(payload);
  });

  it.each([
    ["duplicate header", (lines: string[]) => [lines[0], ...lines]],
    ["missing chunk", (lines: string[]) => lines.toSpliced(1, 1)],
    ["reordered chunk", (lines: string[]) => [lines[0], lines[2], lines[1], ...lines.slice(3)]],
    [
      "conflicting trailer",
      (lines: string[]) => [...lines.slice(0, -1), lines.at(-1)!.replace(/[a-f0-9]$/u, "f")],
    ],
    ["bad base64", (lines: string[]) => lines.with(1, `${lines[1]}=`)],
  ])("fails closed on %s", (_name, mutate) => {
    const lines = checkpointLog("drain", { value: "x".repeat(20_000) }).split("\n");
    expect(() =>
      parseFullReleaseValidationLogCheckpoint(mutate(lines).join("\n"), expected("drain")),
    ).toThrow();
  });

  it("fails closed on provenance mismatch", () => {
    expect(() =>
      parseFullReleaseValidationLogCheckpoint(
        checkpointLog("plan", { state: "sealed" }),
        expected("plan", 2),
      ),
    ).toThrow("runAttempt");
  });

  it("keeps envelope fields allowlisted and does not print ambient secret text", () => {
    const lines = encodeFullReleaseValidationLogCheckpoint({
      kind: "plan",
      payload: { state: "sealed" },
      provenance: { ...provenance(), token: "plaintext-secret" },
    });
    expect(lines.join("\n")).not.toContain("plaintext-secret");
    const parsed = parseFullReleaseValidationLogCheckpoint(lines.join("\n"), expected("plan"));
    expect(parsed?.envelope).not.toHaveProperty("token");
  });

  it("requires one exact non-matrix producer job", () => {
    const job = {
      head_sha: SHA,
      id: 7,
      name: "Release Decision",
      run_attempt: 2,
      run_id: 123,
      status: "completed",
      workflow_name: "Full Release Validation",
    };
    const read = (jobs: Record<string, unknown>[]) =>
      readFullReleaseValidationLogCheckpointFromGitHub({
        getJobLog: () => checkpointLog("decision", { state: "passed" }, 2),
        getJobs: () => jobs,
        getRun: () => ({
          event: "workflow_dispatch",
          head_sha: SHA,
          id: 123,
          path: ".github/workflows/full-release-validation.yml",
          run_attempt: 2,
          workflow_id: 456,
        }),
        kind: "decision",
        runAttempt: 2,
        runId: "123",
        targetSha: TARGET_SHA,
        workflowSha: SHA,
      });
    expect(read([job])).toMatchObject({ job });
    expect(read([])).toBeUndefined();
    expect(() => read([job, { ...job, id: 8 }])).toThrow("not unique");
    expect(() => read([{ ...job, run_id: 124 }])).toThrow("binding is invalid");
  });

  it("treats an active producer as not ready and a malformed completed producer as fatal", async () => {
    const active = {
      head_sha: SHA,
      id: 7,
      name: "Release Decision",
      run_attempt: 2,
      run_id: 123,
      status: "in_progress",
      workflow_name: "Full Release Validation",
    };
    expect(
      readFullReleaseValidationLogCheckpointFromGitHub({
        getJobs: () => [active],
        getRun: () => ({
          event: "workflow_dispatch",
          head_sha: SHA,
          id: 123,
          path: ".github/workflows/full-release-validation.yml",
          run_attempt: 2,
          workflow_id: 456,
        }),
        kind: "decision",
        getJobLog: () => {
          throw new Error("must not read");
        },
        runAttempt: 2,
        runId: "123",
        targetSha: TARGET_SHA,
        workflowSha: SHA,
      }),
    ).toBeUndefined();
    expect(
      readFullReleaseValidationLogCheckpointFromGitHub({
        getJobs: () => [{ ...active, conclusion: "success", status: "completed" }],
        getRun: () => ({
          event: "workflow_dispatch",
          head_sha: SHA,
          id: 123,
          path: ".github/workflows/full-release-validation.yml",
          run_attempt: 2,
          workflow_id: 456,
        }),
        kind: "decision",
        getJobLog: () => `${checkpointLog("decision", { state: "passed" }, 2)}\nextra`,
        runAttempt: 2,
        runId: "123",
        targetSha: TARGET_SHA,
        workflowSha: SHA,
      }),
    ).toMatchObject({ payload: { state: "passed" } });
    expect(() =>
      readFullReleaseValidationLogCheckpointFromGitHub({
        getJobs: () => [{ ...active, conclusion: "success", status: "completed" }],
        getRun: () => ({
          event: "workflow_dispatch",
          head_sha: SHA,
          id: 123,
          path: ".github/workflows/full-release-validation.yml",
          run_attempt: 2,
          workflow_id: 456,
        }),
        kind: "decision",
        getJobLog: () => "[openclaw-frv-checkpoint] chunk decision 1/1 e30",
        runAttempt: 2,
        runId: "123",
        targetSha: TARGET_SHA,
        workflowSha: SHA,
      }),
    ).toThrow("header");
  });

  it.each(["failure", "cancelled"])(
    "searches earlier attempts newest-first and falls past a %s no-marker attempt",
    async (conclusion) => {
      const attempts: number[] = [];
      const result = await recoverFullReleaseValidationLogCheckpoint({
        currentAttempt: 4,
        expected: provenance(4),
        kind: "plan",
        listJobsForAttempt: async (attempt) => {
          attempts.push(attempt);
          return [
            {
              conclusion: attempt === 3 ? conclusion : "success",
              head_sha: SHA,
              id: attempt,
              name: "Seal release execution plan",
              run_attempt: attempt,
              run_id: 123,
              status: "completed",
              workflow_name: "Full Release Validation",
            },
          ];
        },
        readJobLog: async (jobId) =>
          Number(jobId) === 3 ? "failed before emission" : checkpointLog("plan", { source: 2 }, 2),
      });
      expect(attempts).toEqual([3, 2]);
      expect(result).toMatchObject({ payload: { source: 2 }, sourceAttempt: 2 });
    },
  );

  it.each([
    "success",
    "neutral",
    "skipped",
    "timed_out",
    "action_required",
    "stale",
    "startup_failure",
    "unknown",
  ])("fails closed on a completed %s attempt without a checkpoint marker", async (conclusion) => {
    await expect(
      recoverFullReleaseValidationLogCheckpoint({
        currentAttempt: 3,
        expected: provenance(3),
        kind: "plan",
        listJobsForAttempt: async (attempt) => [
          {
            conclusion: attempt === 2 ? conclusion : "success",
            head_sha: SHA,
            id: attempt,
            name: "Seal release execution plan",
            run_attempt: attempt,
            run_id: 123,
            status: "completed",
            workflow_name: "Full Release Validation",
          },
        ],
        readJobLog: async (jobId) =>
          Number(jobId) === 2
            ? "completed without emission"
            : checkpointLog("plan", { source: 1 }, 1),
      }),
    ).rejects.toThrow("completed without a marker");
  });

  it.each([
    ["partial", "[openclaw-frv-checkpoint] chunk plan 1/1 e30"],
    [
      "duplicate",
      `${checkpointLog("plan", { source: 2 }, 2)}\n${checkpointLog("plan", { source: 2 }, 2)}`,
    ],
    ["conflicting", checkpointLog("plan", { source: 2 }, 2).replace(/[a-f0-9]$/u, "f")],
  ])(
    "fails closed on a %s newest-attempt checkpoint instead of using older state",
    async (_, log) => {
      await expect(
        recoverFullReleaseValidationLogCheckpoint({
          currentAttempt: 3,
          expected: provenance(3),
          kind: "plan",
          listJobsForAttempt: async (attempt) => [
            {
              conclusion: "success",
              head_sha: SHA,
              id: attempt,
              name: "Seal release execution plan",
              run_attempt: attempt,
              run_id: 123,
              status: "completed",
              workflow_name: "Full Release Validation",
            },
          ],
          readJobLog: async (jobId) =>
            Number(jobId) === 2 ? log : checkpointLog("plan", { source: 1 }, 1),
        }),
      ).rejects.toThrow();
    },
  );

  it("recovers Decision and Drain from independent source attempts", async () => {
    const recover = (kind: "decision" | "drain", sourceAttempt: number) =>
      recoverFullReleaseValidationLogCheckpoint({
        currentAttempt: 4,
        expected: provenance(4),
        kind,
        listJobsForAttempt: async (attempt) => [
          {
            conclusion: attempt === sourceAttempt ? "success" : "failure",
            head_sha: SHA,
            id: kind === "decision" ? 100 + attempt : 200 + attempt,
            name: kind === "decision" ? "Release Decision" : "Diagnostic Drain",
            run_attempt: attempt,
            run_id: 123,
            status: "completed",
            workflow_name: "Full Release Validation",
          },
        ],
        readJobLog: async (jobId) => {
          const attempt = Number(jobId) % 100;
          return attempt === sourceAttempt
            ? checkpointLog(kind, { kind, sourceAttempt }, sourceAttempt)
            : "failed before emission";
        },
      });
    await expect(recover("decision", 3)).resolves.toMatchObject({ sourceAttempt: 3 });
    await expect(recover("drain", 1)).resolves.toMatchObject({ sourceAttempt: 1 });
  });

  it("keeps workflow retries recovery-only and re-uploads the validated plan", () => {
    const workflow = readFileSync(".github/workflows/full-release-validation.yml", "utf8");
    expect(workflow).not.toContain("Restore immutable release execution plan");
    expect(workflow).toContain("FULL_RELEASE_RESTORE_PLAN: ${{ github.run_attempt != 1 }}");
    expect(workflow.match(/if: always\(\)/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(workflow).toContain("overwrite: true");
    expect(
      workflow.match(/scripts\/lib\/full-release-validation-log-checkpoint\.mjs/gu),
    ).toHaveLength(4);
    expect(workflow).not.toContain("gh run rerun");
  });

  it("keeps child dispatches attempt-one-only and watchers artifact-first", () => {
    const workflow = readFileSync(".github/workflows/full-release-validation.yml", "utf8");
    expect(workflow.match(/github\.run_attempt == 1/gu)?.length).toBeGreaterThanOrEqual(7);
    const atSha = readFileSync("scripts/full-release-validation-at-sha.mts", "utf8");
    const summary = readFileSync("scripts/release-ci-summary.mjs", "utf8");
    expect(atSha).toContain("tryReadReleaseDecision(");
    expect(atSha).toContain("??\n        tryReadReleaseDecisionCheckpoint(");
    expect(summary).toContain("tryReadReleaseDecisionArtifact(parent, runId, repository) ??");
    expect(summary).toContain("tryReadReleaseDecisionCheckpoint(parent, runId, repository)");
  });
});
