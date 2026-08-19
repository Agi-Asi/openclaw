#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-memory-process-isolation-e2e" OPENCLAW_MEMORY_PROCESS_ISOLATION_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_MEMORY_PROCESS_ISOLATION_E2E_SKIP_BUILD:-0}"

# The scheduler supplies the functional package image. Keep the two suites separate:
# their paths select different Vitest projects, and only Memory Core consumes this image.
docker_e2e_build_or_reuse "$IMAGE_NAME" memory-process-isolation "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "" "$SKIP_BUILD"

cd "$ROOT_DIR"
OPENCLAW_PROCESS_ISOLATION_E2E=1 \
  node scripts/run-vitest.mjs src/node-host/node-worker-container-process-isolation.e2e.test.ts
OPENCLAW_PROCESS_ISOLATION_E2E=1 \
  OPENCLAW_SANDBOX_TEST_IMAGE="$IMAGE_NAME" \
  node scripts/run-vitest.mjs extensions/memory-core/src/memory/scoped-memory-runtime.test.ts
