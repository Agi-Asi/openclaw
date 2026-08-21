// Package-version compatibility helpers for E2E acceptance scripts.
import { isDirectRunUrl } from "../../lib/direct-run.mjs";

export function legacyPackageAcceptanceCompat(version) {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:[-+].*)?/.exec(version || "");
  const [year, month, day] = match?.slice(1, 4).map(Number) ?? [];
  return (
    Boolean(match) && (year < 2026 || (year === 2026 && (month < 4 || (month === 4 && day <= 25))))
  );
}

export function clawhubReleaseSecurityMode(version) {
  // 2026.6.35 shipped before the ClawHub release-security endpoint existed.
  return version === "2026.6.35" ? "absent" : "required";
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  if (process.argv[2] === "--clawhub-release-security-mode") {
    console.log(clawhubReleaseSecurityMode(process.argv[3]));
  } else {
    console.log(legacyPackageAcceptanceCompat(process.argv[2]) ? "1" : "0");
  }
}
