#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-fleet-separate-cell-e2e" OPENCLAW_FLEET_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_FLEET_E2E_SKIP_BUILD:-0}"

# The scheduler supplies the functional package image. A direct invocation can still build the
# same package-installed image, but this lane never creates a second Fleet-specific image.
docker_e2e_build_or_reuse "$IMAGE_NAME" fleet-separate-cell "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "" "$SKIP_BUILD"

cd "$ROOT_DIR"
OPENCLAW_PROCESS_ISOLATION_E2E=1 \
  OPENCLAW_FLEET_E2E_IMAGE="$IMAGE_NAME" \
  node scripts/run-vitest.mjs src/fleet/service.container.e2e.test.ts
