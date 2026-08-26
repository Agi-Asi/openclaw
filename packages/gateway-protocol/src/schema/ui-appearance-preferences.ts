export const UI_APPEARANCE_PREFERENCE_KEYS = {
  theme: "ui.theme",
  themeMode: "ui.themeMode",
  accent: "ui.accent",
} as const;

export type UiAppearancePreferenceKey =
  (typeof UI_APPEARANCE_PREFERENCE_KEYS)[keyof typeof UI_APPEARANCE_PREFERENCE_KEYS];

// Wire-contract list of storable theme names. The Control UI derives its own
// theme set from this tuple; a theme shipped in the UI but missing here would
// silently drop that profile preference on read.
export const UI_APPEARANCE_THEME_VALUES = [
  "claw",
  "knot",
  "dash",
  "absolutely",
  "tide",
  "beacon",
  "phosphor",
  "custom",
] as const;
const UI_APPEARANCE_THEMES = new Set<string>(UI_APPEARANCE_THEME_VALUES);
const UI_APPEARANCE_THEME_MODES = new Set(["light", "dark", "system"]);

export function normalizeUiAppearancePreference(
  key: UiAppearancePreferenceKey,
  value: unknown,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (key === UI_APPEARANCE_PREFERENCE_KEYS.accent) {
    return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined;
  }
  const allowedValues =
    key === UI_APPEARANCE_PREFERENCE_KEYS.theme ? UI_APPEARANCE_THEMES : UI_APPEARANCE_THEME_MODES;
  return allowedValues.has(value) ? value : undefined;
}
