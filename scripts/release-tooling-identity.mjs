#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const RELEASE_PUBLISH_REF_PATTERN = /^release-publish\/([a-f0-9]{12})-([1-9][0-9]*)$/u;
const GH_COMMAND_TIMEOUT_MS = 60_000;

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} is required.`);
  }
  return value.trim();
}

function requiredSha(value, label) {
  const sha = requiredString(value, label);
  if (!SHA_PATTERN.test(sha)) {
    fail(`${label} must be a lowercase 40-character commit SHA.`);
  }
  return sha;
}

function requireRepository(value) {
  const repository = requiredString(value, "release tooling repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    fail("release tooling repository must be owner/name.");
  }
  return repository;
}

function classifyIdentity({
  allowPrevalidatedRef,
  releasePublishRunId,
  workflowFullRef,
  workflowRef,
  workflowSha,
}) {
  const ref = requiredString(workflowRef, "release tooling ref");
  const fullRef = requiredString(workflowFullRef, "release tooling full ref");
  const sha = requiredSha(workflowSha, "release tooling SHA");
  const protectedMatch = RELEASE_PUBLISH_REF_PATTERN.exec(ref);

  if (protectedMatch) {
    if (fullRef !== `refs/tags/${ref}`) {
      fail("protected release tooling identity must use the exact tag full ref.");
    }
    if (sha.slice(0, 12) !== protectedMatch[1]) {
      fail("protected release tooling tag SHA prefix does not match the workflow SHA.");
    }
    const runId = requiredString(releasePublishRunId, "release publish run id");
    if (!/^[1-9][0-9]*$/u.test(runId) || runId !== protectedMatch[2]) {
      fail("protected release tooling tag run does not match the release publish run id.");
    }
    return { fullRef, ref, releasePublishRunId: runId, route: "protected-tag", sha };
  }

  if (
    ref.startsWith("release-publish/") ||
    fullRef.startsWith("refs/tags/release-publish/") ||
    fullRef.startsWith("refs/heads/release-publish/")
  ) {
    fail("release-publish tooling identity must be an exact protected tag.");
  }

  if (ref === "main" || fullRef === "refs/heads/main") {
    if (ref !== "main" || fullRef !== "refs/heads/main") {
      fail("main release tooling identity must use ref main and full ref refs/heads/main.");
    }
    return { fullRef, ref, route: "main", sha };
  }

  if (allowPrevalidatedRef !== true || fullRef !== `refs/heads/${ref}`) {
    fail(
      "release tooling identity is not trusted main, a protected tag, or a prevalidated branch.",
    );
  }
  return { fullRef, ref, route: "prevalidated-branch", sha };
}

export function validateReleaseToolingIdentity({
  allowPrevalidatedRef = false,
  mainComparisonStatus,
  releasePublishRunId,
  tagRef,
  workflowFullRef,
  workflowRef,
  workflowSha,
}) {
  const identity = classifyIdentity({
    allowPrevalidatedRef,
    releasePublishRunId,
    workflowFullRef,
    workflowRef,
    workflowSha,
  });

  if (identity.route === "protected-tag") {
    if (
      !isRecord(tagRef) ||
      tagRef.ref !== identity.fullRef ||
      !isRecord(tagRef.object) ||
      tagRef.object.type !== "commit" ||
      tagRef.object.sha !== identity.sha
    ) {
      fail(
        "protected release tooling tag is missing, moved, annotated, or bound to the wrong SHA.",
      );
    }
  } else if (
    identity.route === "main" &&
    mainComparisonStatus !== "ahead" &&
    mainComparisonStatus !== "identical"
  ) {
    fail("main release tooling SHA is not reachable from current main.");
  }

  return identity;
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON.`, { cause: error });
  }
}

function runReleaseToolingGh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GH_COMMAND_TIMEOUT_MS,
  });
}

export function verifyReleaseToolingIdentity({
  allowPrevalidatedRef = false,
  releasePublishRunId,
  repository,
  runGh = runReleaseToolingGh,
  workflowFullRef,
  workflowRef,
  workflowSha,
}) {
  const normalizedRepository = requireRepository(repository);
  const identity = classifyIdentity({
    allowPrevalidatedRef,
    releasePublishRunId,
    workflowFullRef,
    workflowRef,
    workflowSha,
  });

  if (identity.route === "protected-tag") {
    let tagRef;
    try {
      tagRef = parseJson(
        runGh([
          "api",
          `repos/${normalizedRepository}/git/ref/tags/${identity.ref}`,
          "--method",
          "GET",
        ]),
        "protected release tooling tag",
      );
    } catch (error) {
      throw new Error("protected release tooling tag is missing or unreadable.", { cause: error });
    }
    return validateReleaseToolingIdentity({
      allowPrevalidatedRef,
      releasePublishRunId,
      tagRef,
      workflowFullRef,
      workflowRef,
      workflowSha,
    });
  }

  if (identity.route === "main") {
    let comparison;
    try {
      comparison = parseJson(
        runGh([
          "api",
          `repos/${normalizedRepository}/compare/${identity.sha}...main`,
          "--method",
          "GET",
        ]),
        "main release tooling comparison",
      );
    } catch (error) {
      throw new Error("main release tooling ancestry could not be verified.", { cause: error });
    }
    return validateReleaseToolingIdentity({
      allowPrevalidatedRef,
      mainComparisonStatus: isRecord(comparison) ? comparison.status : undefined,
      releasePublishRunId,
      workflowFullRef,
      workflowRef,
      workflowSha,
    });
  }

  return identity;
}

function parseArgs(argv) {
  const options = {
    allowPrevalidatedRef: false,
    releasePublishRunId: "",
    repository: "",
    workflowFullRef: "",
    workflowRef: "",
    workflowSha: "",
  };
  if (argv.shift() !== "verify") {
    fail("usage: release-tooling-identity.mjs verify [options]");
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-prevalidated-ref") {
      options.allowPrevalidatedRef = true;
      continue;
    }
    const value = argv[(index += 1)] ?? "";
    if (arg === "--release-publish-run-id") {
      options.releasePublishRunId = value;
    } else if (arg === "--repository") {
      options.repository = value;
    } else if (arg === "--workflow-full-ref") {
      options.workflowFullRef = value;
    } else if (arg === "--workflow-ref") {
      options.workflowRef = value;
    } else if (arg === "--workflow-sha") {
      options.workflowSha = value;
    } else {
      fail(`unknown release tooling identity argument: ${arg}`);
    }
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const identity = verifyReleaseToolingIdentity(parseArgs([...argv]));
  process.stdout.write(`${JSON.stringify(identity)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
