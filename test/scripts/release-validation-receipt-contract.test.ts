import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalReleaseJson,
  createReleasePlanLock,
  releaseCanonicalDigest,
} from "../../scripts/release-plan-contract.mjs";
import {
  canonicalReleaseValidationReceiptJson,
  canonicalReleaseValidationReceiptLocatorJson,
  createReleaseValidationReceiptLocator,
  parseReleaseValidationReceiptJson,
  parseReleaseValidationReceiptLocatorJson,
  releaseValidationReceiptDigest,
  sealReleaseValidationReceipt,
  validateReleaseValidationExecutionPlanSource,
  validateReleaseValidationReceipt,
  validateReleaseValidationReceiptLocatorForReceipt,
  validateReleaseValidationStateSource,
  verifyReleaseValidationReceipt,
  verifyReleaseValidationReceiptLineage,
} from "../../scripts/release-validation-receipt-contract.mjs";
import type {
  ReleaseValidationExecutionPlanSource,
  ReleaseValidationReceiptSealInput,
  ReleaseValidationSourceArtifact,
  ReleaseValidationStateGroup,
  ReleaseValidationStateJob,
  ReleaseValidationStateSource,
} from "../../scripts/release-validation-receipt-contract.mjs";

const TARGET_SHA = "a".repeat(40);
const TOOLING_SHA = "b".repeat(40);
const PARENT_RUN_ID = "9001";
const PARENT_RUN_URL = `https://github.com/openclaw/openclaw/actions/runs/${PARENT_RUN_ID}`;
const sourceFixture = JSON.parse(
  readFileSync(resolve("test/fixtures/release-plan-v1.source.json"), "utf8"),
) as Record<string, unknown>;

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString().replace(".000Z", "Z");
}

function job(
  runId: string,
  id: string,
  name: string,
  policy: "advisory" | "blocking",
  status: "completed" | "in_progress",
  conclusion: "failure" | "success" | null,
  completedAt: string | null,
): ReleaseValidationStateJob {
  return {
    name,
    policy,
    status,
    conclusion,
    started_at: "2026-08-21T09:05:00Z",
    completed_at: completedAt,
    url: `https://github.com/openclaw/openclaw/actions/runs/${runId}/job/${id}`,
  };
}

function stateGroup(
  id: string,
  runId: string,
  status: "completed" | "in_progress",
  conclusion: "failure" | "success" | null,
  completedAt: string | null,
  jobs: ReleaseValidationStateJob[],
): ReleaseValidationStateGroup {
  return {
    id,
    run_id: runId,
    run_attempt: 1,
    status,
    conclusion,
    completed_at: completedAt,
    url: `https://github.com/openclaw/openclaw/actions/runs/${runId}`,
    jobs,
  };
}

function executionPlanFixture(): ReleaseValidationExecutionPlanSource {
  return {
    schema: "openclaw.full-release-execution-plan.v1",
    parent_run_id: PARENT_RUN_ID,
    parent_run_attempt: 1,
    workflow_ref: `refs/tags/release-publish/${TOOLING_SHA.slice(0, 12)}-123`,
    workflow_sha: TOOLING_SHA,
    target_sha: TARGET_SHA,
    release_profile: "beta",
    rerun_group: "all",
    fail_fast: false,
    started_at: "2026-08-21T09:00:00Z",
    groups: [
      {
        id: "normal-ci",
        mode: "blocking",
        policy: "required-success",
        workflow_path: ".github/workflows/ci.yml",
        run_id: "9101",
        run_attempt: 1,
        workflow_sha: TOOLING_SHA,
        url: "https://github.com/openclaw/openclaw/actions/runs/9101",
      },
      {
        id: "performance",
        mode: "diagnostic",
        policy: "advisory",
        workflow_path: ".github/workflows/openclaw-performance.yml",
        run_id: "9102",
        run_attempt: 1,
        workflow_sha: TOOLING_SHA,
        url: "https://github.com/openclaw/openclaw/actions/runs/9102",
      },
      {
        id: "release-checks",
        mode: "blocking",
        policy: "required-success",
        workflow_path: ".github/workflows/openclaw-release-checks.yml",
        run_id: "9103",
        run_attempt: 1,
        workflow_sha: TOOLING_SHA,
        url: "https://github.com/openclaw/openclaw/actions/runs/9103",
      },
    ],
  };
}

function decisionFixture(
  executionPlan: ReleaseValidationExecutionPlanSource,
): ReleaseValidationStateSource {
  return {
    schema: "openclaw.full-release-decision.v2",
    parent_run_id: PARENT_RUN_ID,
    parent_run_attempt: 2,
    source_parent_run_attempt: 1,
    workflow_ref: executionPlan.workflow_ref,
    workflow_sha: TOOLING_SHA,
    target_sha: TARGET_SHA,
    execution_plan_digest: releaseCanonicalDigest(executionPlan),
    observed_at: "2026-08-21T10:00:00Z",
    groups: [
      stateGroup("normal-ci", "9101", "completed", "success", "2026-08-21T09:25:00Z", [
        job("9101", "1", "test", "blocking", "completed", "success", "2026-08-21T09:25:00Z"),
      ]),
      stateGroup("performance", "9102", "in_progress", null, null, [
        job("9102", "2", "bench", "advisory", "in_progress", null, null),
      ]),
      stateGroup("release-checks", "9103", "completed", "success", "2026-08-21T09:50:00Z", [
        job("9103", "3", "package", "blocking", "completed", "success", "2026-08-21T09:50:00Z"),
      ]),
    ],
  };
}

function diagnosticDrainFixture(
  decision: ReleaseValidationStateSource,
): ReleaseValidationStateSource {
  const normalCi = structuredClone(decision.groups[0]!);
  const releaseChecks = structuredClone(decision.groups[2]!);
  return {
    ...structuredClone(decision),
    schema: "openclaw.full-release-diagnostic-drain.v2",
    observed_at: "2026-08-21T10:30:00Z",
    groups: [
      normalCi,
      stateGroup("performance", "9102", "completed", "failure", "2026-08-21T10:20:00Z", [
        job("9102", "2", "bench", "advisory", "completed", "failure", "2026-08-21T10:20:00Z"),
      ]),
      releaseChecks,
    ],
  };
}

type FixtureBase = Omit<
  ReleaseValidationReceiptSealInput,
  "parentReceipt" | "rootReceipt" | "sourceArtifacts"
>;
type Fixture = FixtureBase & { sourceArtifacts: ReleaseValidationSourceArtifact[] };

function sourceArtifacts(fixture: FixtureBase): ReleaseValidationSourceArtifact[] {
  const coordinates = [
    {
      kind: "decision",
      artifact_id: "9201",
      artifact_name: "full-release-decision-9001-2",
      entry_name: "full-release-decision.json",
      run_attempt: 2,
      content: fixture.decision,
      created_at: addSeconds(fixture.decision.observed_at, 60),
      archive: "1",
    },
    {
      kind: "diagnostic-drain",
      artifact_id: "9202",
      artifact_name: "full-release-diagnostics-9001-2",
      entry_name: "full-release-diagnostic-manifest.json",
      run_attempt: 2,
      content: fixture.diagnosticDrain,
      created_at: addSeconds(fixture.diagnosticDrain.observed_at, 60),
      archive: "2",
    },
    {
      kind: "execution-plan",
      artifact_id: "9203",
      artifact_name: "full-release-execution-plan-9001",
      entry_name: "full-release-execution-plan.json",
      run_attempt: 1,
      content: fixture.executionPlan,
      created_at: addSeconds(fixture.executionPlan.started_at, 60),
      archive: "3",
    },
    {
      kind: "release-plan-lock",
      artifact_id: "9204",
      artifact_name: "release-plan-lock-9001-1",
      entry_name: "release-plan-lock.json",
      run_attempt: 1,
      content: fixture.releasePlanLock,
      created_at: addSeconds(fixture.executionPlan.started_at, -60),
      archive: "4",
    },
  ] as const;
  return coordinates.map((artifact) => ({
    kind: artifact.kind,
    artifact_id: artifact.artifact_id,
    artifact_name: artifact.artifact_name,
    entry_name: artifact.entry_name,
    run_id: PARENT_RUN_ID,
    run_attempt: artifact.run_attempt,
    archive_digest:
      `sha256:${artifact.archive.repeat(64)}` as ReleaseValidationSourceArtifact["archive_digest"],
    content_digest: releaseCanonicalDigest(
      artifact.content,
    ) as ReleaseValidationSourceArtifact["content_digest"],
    created_at: artifact.created_at,
    url: `${PARENT_RUN_URL}/artifacts/${artifact.artifact_id}`,
  }));
}

function inputFixture(): Fixture {
  const executionPlan = executionPlanFixture();
  const decision = decisionFixture(executionPlan);
  const diagnosticDrain = diagnosticDrainFixture(decision);
  const base = {
    releasePlanLock: createReleasePlanLock(sourceFixture),
    executionPlan,
    decision,
    diagnosticDrain,
    sealedAt: "2026-08-21T10:32:00Z",
  };
  return { ...base, sourceArtifacts: sourceArtifacts(base) };
}

function refreshArtifacts(fixture: Fixture): Fixture {
  fixture.sourceArtifacts = sourceArtifacts(fixture);
  return fixture;
}

function shiftFixture(fixture: Fixture, seconds: number): Fixture {
  const shiftObject = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (
        typeof entry === "string" &&
        (key === "started_at" || key === "completed_at" || key === "observed_at")
      ) {
        (value as Record<string, unknown>)[key] = addSeconds(entry, seconds);
      } else {
        shiftObject(entry);
      }
    }
  };
  shiftObject(fixture.executionPlan);
  shiftObject(fixture.decision);
  shiftObject(fixture.diagnosticDrain);
  fixture.decision.execution_plan_digest = releaseCanonicalDigest(fixture.executionPlan);
  fixture.diagnosticDrain.execution_plan_digest = releaseCanonicalDigest(fixture.executionPlan);
  fixture.sealedAt = addSeconds(fixture.sealedAt, seconds);
  return refreshArtifacts(fixture);
}

function locatorFixture(receipt: ReturnType<typeof sealReleaseValidationReceipt>) {
  return {
    repository: "openclaw/openclaw",
    run_id: receipt.attempt.run_id,
    run_attempt: receipt.attempt.run_attempt,
    artifact_id: "9301",
    artifact_name: `release-validation-receipt-${receipt.attempt.run_id}-${receipt.attempt.run_attempt}`,
    entry_name: "release-validation-receipt.json",
    archive_digest: `sha256:${"9".repeat(64)}`,
    url: `${receipt.attempt.url}/artifacts/9301`,
  };
}

describe("release validation receipt source sealer", () => {
  it("derives the release-valid receipt from the locked plan and source evidence", () => {
    const input = inputFixture();
    const receipt = sealReleaseValidationReceipt(input);

    expect(receipt.target).toEqual({
      repository: "openclaw/openclaw",
      ref: "refs/tags/v2026.8.1-beta.2",
      sha: TARGET_SHA,
    });
    expect(receipt.tooling).toEqual(input.releasePlanLock.plan.tooling);
    expect(receipt.release_plan).toEqual({
      schema: "openclaw.release-plan.v1",
      purpose: "beta-publish",
      plan_digest: input.releasePlanLock.digest,
      lock_digest: releaseCanonicalDigest(input.releasePlanLock),
    });
    expect(receipt.validation).toEqual({
      intent: "release-beta",
      profile: "beta",
      soak: false,
      allowed_groups: ["all", "ci", "package"],
      rerun_group: "all",
      policy: { id: "openclaw.release-validation-policy.v1", fail_fast: false },
    });
    expect(receipt).not.toHaveProperty("outcome");
    expect(receipt.groups).toEqual(
      input.executionPlan.groups.map((group, index) => {
        const observed = input.diagnosticDrain.groups[index]!;
        return {
          ...group,
          conclusion: observed.conclusion,
          completed_at: observed.completed_at,
          jobs: observed.jobs,
        };
      }),
    );
    expect(verifyReleaseValidationReceipt(receipt, input)).toEqual(receipt);
  });

  it("rejects self-declared receipt changes even when the changed receipt is structurally valid", () => {
    const input = inputFixture();
    const receipt = sealReleaseValidationReceipt(input);
    const mutations = [
      (value: Record<string, any>) => (value.target.sha = "c".repeat(40)),
      (value: Record<string, any>) => (value.tooling.sha = "c".repeat(40)),
      (value: Record<string, any>) => (value.release_plan.plan_digest = `sha256:${"c".repeat(64)}`),
      (value: Record<string, any>) => (value.validation.allowed_groups = ["all", "ci"]),
      (value: Record<string, any>) => (value.groups[0].policy = "optional"),
      (value: Record<string, any>) => (value.groups[0].jobs[0].name = "other"),
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(receipt) as unknown as Record<string, any>;
      mutate(changed);
      expect(() => verifyReleaseValidationReceipt(changed, input)).toThrow();
    }
  });

  it("binds execution target, tooling, profile, and selected group to the ReleasePlan lock", () => {
    const mutations = [
      (value: Fixture) => (value.executionPlan.target_sha = "c".repeat(40)),
      (value: Fixture) => (value.executionPlan.workflow_sha = "c".repeat(40)),
      (value: Fixture) => (value.executionPlan.release_profile = "full"),
      (value: Fixture) => (value.executionPlan.rerun_group = "performance"),
    ];
    for (const mutate of mutations) {
      const input = inputFixture();
      mutate(input);
      input.decision.execution_plan_digest = releaseCanonicalDigest(input.executionPlan);
      input.diagnosticDrain.execution_plan_digest = releaseCanonicalDigest(input.executionPlan);
      refreshArtifacts(input);
      expect(() => sealReleaseValidationReceipt(input)).toThrow(/validated ReleasePlan|tooling/);
    }
  });

  it("requires every blocking job and run to succeed before Decision", () => {
    const mutations = [
      (value: Fixture) => (value.decision.groups[0]!.status = "in_progress"),
      (value: Fixture) => (value.decision.groups[0]!.conclusion = "failure"),
      (value: Fixture) => (value.decision.groups[0]!.jobs[0]!.status = "in_progress"),
      (value: Fixture) => (value.decision.groups[0]!.jobs[0]!.conclusion = "failure"),
      (value: Fixture) =>
        (value.decision.groups[0]!.jobs[0]!.completed_at = "2026-08-21T10:01:00Z"),
    ];
    for (const mutate of mutations) {
      const input = inputFixture();
      mutate(input);
      refreshArtifacts(input);
      expect(() => sealReleaseValidationReceipt(input)).toThrow(
        /blocking (group|job)|inconsistent/,
      );
    }
  });

  it("requires diagnostic completion before Drain and immutable blocking evidence after Decision", () => {
    const incomplete = inputFixture();
    incomplete.diagnosticDrain.groups[1]!.jobs[0]!.status = "in_progress";
    incomplete.diagnosticDrain.groups[1]!.jobs[0]!.conclusion = null;
    incomplete.diagnosticDrain.groups[1]!.jobs[0]!.completed_at = null;
    refreshArtifacts(incomplete);
    expect(() => sealReleaseValidationReceipt(incomplete)).toThrow(/drained job|inconsistent/);

    const changed = inputFixture();
    changed.diagnosticDrain.groups[0]!.jobs[0]!.completed_at = "2026-08-21T09:26:00Z";
    changed.diagnosticDrain.groups[0]!.completed_at = "2026-08-21T09:26:00Z";
    refreshArtifacts(changed);
    expect(() => sealReleaseValidationReceipt(changed)).toThrow("blocking job changed");

    const omitted = inputFixture();
    omitted.diagnosticDrain.groups[0]!.jobs = [];
    refreshArtifacts(omitted);
    expect(() => sealReleaseValidationReceipt(omitted)).toThrow(/non-empty array|blocking job/);

    const blockingDiagnostic = inputFixture();
    blockingDiagnostic.diagnosticDrain.groups[1]!.jobs[0]!.policy = "blocking";
    refreshArtifacts(blockingDiagnostic);
    expect(() => sealReleaseValidationReceipt(blockingDiagnostic)).toThrow(
      "diagnostic group contains a blocking job",
    );
  });

  it("requires exact source artifact identities, coordinates, names, URLs, and digests", () => {
    const mutations = [
      (value: Fixture) => (value.sourceArtifacts[1]!.artifact_id = "9201"),
      (value: Fixture) => (value.sourceArtifacts[0]!.artifact_name = "full-release-decision-9001"),
      (value: Fixture) => (value.sourceArtifacts[0]!.entry_name = "decision.json"),
      (value: Fixture) => (value.sourceArtifacts[0]!.run_attempt = 1),
      (value: Fixture) => (value.sourceArtifacts[0]!.content_digest = `sha256:${"f".repeat(64)}`),
      (value: Fixture) =>
        (value.sourceArtifacts[0]!.url =
          "https://github.com/openclaw/openclaw/actions/runs/9001/artifacts/9999"),
      (value: Fixture) => (value.sourceArtifacts[1]!.created_at = "2026-08-21T10:29:59Z"),
    ];
    for (const mutate of mutations) {
      const input = inputFixture();
      mutate(input);
      expect(() => sealReleaseValidationReceipt(input)).toThrow(
        /unique|coordinates|must equal|timestamps/,
      );
    }
  });
});

describe("release validation receipt lineage", () => {
  it("requires actual parent and root receipts for continuous same-intent lineage", () => {
    const rootInput = inputFixture();
    const root = sealReleaseValidationReceipt(rootInput);
    expect(root.lineage).toEqual({
      generation: 0,
      root_receipt_digest: null,
      parent_receipt_digest: null,
    });
    expect(verifyReleaseValidationReceiptLineage(root)).toEqual(root.lineage);

    const childInput = shiftFixture(inputFixture(), 86_400);
    const child = sealReleaseValidationReceipt({ ...childInput, parentReceipt: root });
    expect(child.lineage).toEqual({
      generation: 1,
      root_receipt_digest: releaseValidationReceiptDigest(root),
      parent_receipt_digest: releaseValidationReceiptDigest(root),
    });
    expect(
      verifyReleaseValidationReceiptLineage(child, { parentReceipt: root, rootReceipt: root }),
    ).toEqual(child.lineage);

    const grandchildInput = shiftFixture(inputFixture(), 172_800);
    const grandchild = sealReleaseValidationReceipt({
      ...grandchildInput,
      parentReceipt: child,
      rootReceipt: root,
    });
    expect(grandchild.lineage.generation).toBe(2);
    expect(
      verifyReleaseValidationReceiptLineage(grandchild, {
        parentReceipt: child,
        rootReceipt: root,
      }),
    ).toEqual(grandchild.lineage);
    expect(() =>
      sealReleaseValidationReceipt({ ...grandchildInput, parentReceipt: child }),
    ).toThrow("actual root receipt");
  });

  it("rejects forged roots, different intent policy, late parents, and lineage-field tampering", () => {
    const root = sealReleaseValidationReceipt(inputFixture());
    const childInput = shiftFixture(inputFixture(), 86_400);
    const child = sealReleaseValidationReceipt({ ...childInput, parentReceipt: root });
    const grandchildInput = shiftFixture(inputFixture(), 172_800);
    const unrelatedRoot = sealReleaseValidationReceipt({
      ...inputFixture(),
      sealedAt: "2026-08-21T10:33:00Z",
    });
    expect(() =>
      sealReleaseValidationReceipt({
        ...grandchildInput,
        parentReceipt: child,
        rootReceipt: unrelatedRoot,
      }),
    ).toThrow("does not continue");

    const differentIntent = structuredClone(root);
    differentIntent.release_plan.purpose = "main-qualification";
    differentIntent.validation.intent = "main-daily";
    expect(() =>
      sealReleaseValidationReceipt({
        ...childInput,
        parentReceipt: differentIntent,
      }),
    ).toThrow("different intent policy");

    expect(() => sealReleaseValidationReceipt({ ...inputFixture(), parentReceipt: root })).toThrow(
      "sealed after its child started",
    );

    const forged = structuredClone(child);
    forged.lineage.parent_receipt_digest = `sha256:${"f".repeat(64)}`;
    expect(() =>
      verifyReleaseValidationReceiptLineage(forged, {
        parentReceipt: root,
        rootReceipt: root,
      }),
    ).toThrow("differs from the supplied parent/root");
  });
});

describe("release validation receipt canonical bytes and locator", () => {
  it("rejects unknown fields, duplicate keys, noncanonical bytes, and digest tampering", () => {
    const input = inputFixture();
    const receipt = sealReleaseValidationReceipt(input);
    const text = canonicalReleaseValidationReceiptJson(receipt);
    expect(parseReleaseValidationReceiptJson(text)).toEqual(receipt);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.slice(0, -1)).toMatch(/^[\x20-\x7e]+$/u);

    expect(() => validateReleaseValidationReceipt({ ...receipt, extra: true })).toThrow(
      "keys must be exactly",
    );
    expect(() =>
      parseReleaseValidationReceiptJson(
        text.replace(
          '{"attempt":',
          `{"attempt":${canonicalReleaseJson(receipt.attempt).trim()},"attempt":`,
        ),
      ),
    ).toThrow("duplicate key");
    expect(() => parseReleaseValidationReceiptJson(JSON.stringify(receipt, null, 2))).toThrow(
      /trailing LF|compact printable ASCII/,
    );

    const changed = structuredClone(receipt);
    changed.release_plan.lock_digest = `sha256:${"e".repeat(64)}`;
    expect(() => verifyReleaseValidationReceipt(changed, input)).toThrow();
  });

  it("binds the locator to exact receipt attempt, artifact coordinates, URL, and digest", () => {
    const receipt = sealReleaseValidationReceipt(inputFixture());
    const locator = createReleaseValidationReceiptLocator(receipt, locatorFixture(receipt));
    const text = canonicalReleaseValidationReceiptLocatorJson(locator);
    expect(parseReleaseValidationReceiptLocatorJson(text)).toEqual(locator);
    expect(validateReleaseValidationReceiptLocatorForReceipt(locator, receipt)).toEqual(locator);

    for (const mutate of [
      (value: Record<string, any>) => (value.receipt_digest = `sha256:${"e".repeat(64)}`),
      (value: Record<string, any>) => (value.locator.run_attempt = 1),
      (value: Record<string, any>) => (value.locator.artifact_name = "receipt"),
      (value: Record<string, any>) =>
        (value.locator.url =
          "https://github.com/openclaw/openclaw/actions/runs/9001/artifacts/9999"),
    ]) {
      const changed = structuredClone(locator) as unknown as Record<string, any>;
      mutate(changed);
      expect(() => validateReleaseValidationReceiptLocatorForReceipt(changed, receipt)).toThrow();
    }
  });

  it("strictly validates execution and state source schemas", () => {
    const input = inputFixture();
    expect(validateReleaseValidationExecutionPlanSource(input.executionPlan)).toEqual(
      input.executionPlan,
    );
    expect(validateReleaseValidationStateSource(input.decision, "decision")).toEqual(
      input.decision,
    );
    expect(() =>
      validateReleaseValidationExecutionPlanSource({ ...input.executionPlan, extra: true }),
    ).toThrow("keys must be exactly");
    expect(() =>
      validateReleaseValidationStateSource(
        { ...input.decision, schema: "openclaw.full-release-decision.v1" },
        "decision",
      ),
    ).toThrow("schema must be");
  });
});
