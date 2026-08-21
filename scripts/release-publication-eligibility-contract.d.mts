import type { ReleasePlanLock } from "./release-plan-contract.mjs";

export type ReleasePublicationPackageIdentity = {
  name: string;
  version: string;
};

export type ReleasePublicationEligibilityReceipt = {
  schema: "openclaw.release-publication-eligibility.v1";
  release_plan_digest: string;
  started_at: string;
  completed_at: string;
  expires_at: string;
  registries: {
    clawhub: "https://clawhub.ai";
    npm: "https://registry.npmjs.org";
  };
  observations: {
    latest_dependencies: ReleasePublicationPackageIdentity[];
    npm: Array<ReleasePublicationPackageIdentity & { published: boolean }>;
    clawhub: Array<
      ReleasePublicationPackageIdentity & {
        package_exists: boolean;
        trusted_publisher: boolean;
        published: boolean;
      }
    >;
  };
  plans: {
    npm: Array<ReleasePublicationPackageIdentity & { action: "publish" | "skip-published" }>;
    clawhub: Array<ReleasePublicationPackageIdentity & { action: "publish" | "skip-published" }>;
  };
  digest: string;
};

export type ReleasePublicationEligibilityReceiptBody = Omit<
  ReleasePublicationEligibilityReceipt,
  "digest"
>;

export const RELEASE_PUBLICATION_ELIGIBILITY_SCHEMA: "openclaw.release-publication-eligibility.v1";
export const RELEASE_PUBLICATION_ELIGIBILITY_CANONICALIZATION: "ascii-sorted-compact-json-trailing-newline-v1";
export const RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS: number;
export const RELEASE_PUBLICATION_ELIGIBILITY_MAX_BYTES: number;
export const RELEASE_PUBLICATION_NPM_REGISTRY: "https://registry.npmjs.org";
export const RELEASE_PUBLICATION_CLAWHUB_REGISTRY: "https://clawhub.ai";

export function createReleasePublicationEligibilityReceipt(
  value: unknown,
): ReleasePublicationEligibilityReceipt;
export function validateReleasePublicationEligibilityReceipt(
  value: unknown,
): ReleasePublicationEligibilityReceipt;
export function canonicalReleasePublicationEligibilityReceiptJson(value: unknown): string;
export function parseReleasePublicationEligibilityReceiptJson(
  text: string,
): ReleasePublicationEligibilityReceipt;
export function verifyReleasePublicationEligibilityReceipt(
  value: unknown,
  releasePlanLock: ReleasePlanLock,
  nowMs?: number,
): ReleasePublicationEligibilityReceipt;
