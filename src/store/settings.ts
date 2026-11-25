import { idbRequest, openDb } from "../db/openDb";

export type AppLocale = "zh-CN";
export type FontScale = "sm" | "md" | "lg";
export type ThemeMode = "light" | "dark" | "system";

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
};

const SETTINGS_KEY = "app";
const DEFAULT_SETTINGS: AppSettings = {
  apiBase: "https://api.deepseek.com",
  thinkingEnabled: true,
  webSearchEnabled: false,
  autoCollapseThinking: false,
  locale: "zh-CN",
  fontScale: "md",
  theme: "dark",
};

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
  };
  await idbRequest(
    db.transaction("settings", "readwrite").objectStore("settings").put(next, SETTINGS_KEY),
  );
  applyFontScale(next.fontScale);
  applyTheme(next.theme);
}