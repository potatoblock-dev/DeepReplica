import { idbRequest, openDb } from "../db/openDb";

export type AppLocale = "zh-CN";
export type FontScale = "sm" | "md" | "lg";
export type ThemeMode = "light" | "dark" | "system";
/** Data-management chart time range (persisted with settings). */
export type UsageRangeSetting = "today" | "7d" | "30d";

export type AppSettings = {
  apiBase: string;
  thinkingEnabled: boolean;
  /**
   * When true, declare DeepSeek web tools (search + read_url).
   * Independent of thinking: off+search = web search; on+search = deep thinking search.
   */
  webSearchEnabled: boolean;
  /** When true, collapse the thinking chain after the reply finishes. */
  autoCollapseThinking: boolean;
  /** UI locale; only zh-CN is wired this round. */
  locale: AppLocale;
  /** Global font size scale for chat and settings. */
  fontScale: FontScale;
  /** Color theme: light, dark, or follow OS. */
  theme: ThemeMode;
  /** Last selected usage chart range on the data-management page. */
  usageRange: UsageRangeSetting;
  /**
   * When true, omit `temperature` from API requests (official default).
   * Default checked in the params panel.
   */
  temperatureUseDefault: boolean;
  /** Custom temperature 0–2 used only when `temperatureUseDefault` is false. */
  temperature: number;
};

const SETTINGS_KEY = "app";
/** DeepSeek Chat Completions temperature range (omit field = API default). */
export const TEMPERATURE_MIN = 0;
export const TEMPERATURE_MAX = 2;
export const TEMPERATURE_STEP = 0.1;
export const TEMPERATURE_FALLBACK = 1;

const DEFAULT_SETTINGS: AppSettings = {
  apiBase: "https://api.deepseek.com",
  thinkingEnabled: true,
  webSearchEnabled: false,
  autoCollapseThinking: false,
  locale: "zh-CN",
  fontScale: "md",
  theme: "dark",
  usageRange: "today",
  temperatureUseDefault: true,
  temperature: TEMPERATURE_FALLBACK,
};

/** Narrows a stored value to a valid usage range, else the default. */
function normalizeUsageRange(value: unknown): UsageRangeSetting {
  if (value === "today" || value === "7d" || value === "30d") {
    return value;
  }
  return DEFAULT_SETTINGS.usageRange;
}

/** Clamps temperature to the API range and rounds to one decimal. */
export function normalizeTemperature(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return TEMPERATURE_FALLBACK;
  }
  const clamped = Math.min(TEMPERATURE_MAX, Math.max(TEMPERATURE_MIN, n));
  const stepped = Math.round(clamped / TEMPERATURE_STEP) * TEMPERATURE_STEP;
  return Number(stepped.toFixed(1));
}

let systemThemeListener: ((event: MediaQueryListEvent) => void) | null = null;

/** Applies font scale to the document root for CSS variable consumers. */
export function applyFontScale(scale: FontScale): void {
  document.documentElement.dataset.fontScale = scale;
}

/** Resolves and applies light/dark theme; keeps a listener when following system. */
export function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  if (systemThemeListener) {
    mq.removeEventListener("change", systemThemeListener);
    systemThemeListener = null;
  }
  const resolved: "light" | "dark" =
    theme === "system" ? (mq.matches ? "dark" : "light") : theme;
  root.dataset.theme = resolved;
  root.dataset.themeMode = theme;
  root.style.colorScheme = resolved;
  if (theme === "system") {
    systemThemeListener = () => {
      applyTheme("system");
    };
    mq.addEventListener("change", systemThemeListener);
  }
}

/** Loads non-secret app settings from IndexedDB, falling back to defaults. */
export async function loadSettings(): Promise<AppSettings> {
  const db = await openDb();
  const stored = (await idbRequest(
    db.transaction("settings", "readonly").objectStore("settings").get(SETTINGS_KEY),
  )) as Partial<AppSettings> | undefined;
  const fontScale: FontScale =
    stored?.fontScale === "sm" || stored?.fontScale === "md" || stored?.fontScale === "lg"
      ? stored.fontScale
      : DEFAULT_SETTINGS.fontScale;
  const theme: ThemeMode =
    stored?.theme === "light" || stored?.theme === "dark" || stored?.theme === "system"
      ? stored.theme
      : DEFAULT_SETTINGS.theme;
  return {
    apiBase: stored?.apiBase?.trim() || DEFAULT_SETTINGS.apiBase,
    thinkingEnabled:
      typeof stored?.thinkingEnabled === "boolean"
        ? stored.thinkingEnabled
        : DEFAULT_SETTINGS.thinkingEnabled,
    webSearchEnabled:
      typeof stored?.webSearchEnabled === "boolean"
        ? stored.webSearchEnabled
        : DEFAULT_SETTINGS.webSearchEnabled,
    autoCollapseThinking:
      typeof stored?.autoCollapseThinking === "boolean"
        ? stored.autoCollapseThinking
        : DEFAULT_SETTINGS.autoCollapseThinking,
    locale: stored?.locale === "zh-CN" ? "zh-CN" : DEFAULT_SETTINGS.locale,
    fontScale,
    theme,
    usageRange: normalizeUsageRange(stored?.usageRange),
    temperatureUseDefault:
      typeof stored?.temperatureUseDefault === "boolean"
        ? stored.temperatureUseDefault
        : DEFAULT_SETTINGS.temperatureUseDefault,
    temperature: normalizeTemperature(stored?.temperature),
  };
}

/** Persists non-secret settings in IndexedDB (API key stays in the vault). */
export async function saveSettings(settings: AppSettings): Promise<void> {
  const db = await openDb();
  const next: AppSettings = {
    apiBase: settings.apiBase.trim().replace(/\/$/, "") || DEFAULT_SETTINGS.apiBase,
    thinkingEnabled: settings.thinkingEnabled,
    webSearchEnabled: settings.webSearchEnabled,
    autoCollapseThinking: settings.autoCollapseThinking,
    locale: settings.locale === "zh-CN" ? "zh-CN" : DEFAULT_SETTINGS.locale,
    fontScale:
      settings.fontScale === "sm" || settings.fontScale === "md" || settings.fontScale === "lg"
        ? settings.fontScale
        : DEFAULT_SETTINGS.fontScale,
    theme:
      settings.theme === "light" || settings.theme === "dark" || settings.theme === "system"
        ? settings.theme
        : DEFAULT_SETTINGS.theme,
    usageRange: normalizeUsageRange(settings.usageRange),
    temperatureUseDefault: Boolean(settings.temperatureUseDefault),
    temperature: normalizeTemperature(settings.temperature),
  };
  await idbRequest(
    db.transaction("settings", "readwrite").objectStore("settings").put(next, SETTINGS_KEY),
  );
  applyFontScale(next.fontScale);
  applyTheme(next.theme);
}