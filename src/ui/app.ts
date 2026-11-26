import { fetchUserBalance, pickBalance, type BalanceInfo } from "../api/balance";
import {
  streamChat,
  type ContentAnnotation,
  type ServerToolCall,
  type ServerToolStep,
  type StreamChatMessage,
} from "../api/streamChat";
import {
  appendChildMessage,
  appendMessage,
  applyApiTitle,
  createConversation,
  deleteAllConversations,
  deleteConversation,
  findMessage,
  getActivePath,
  getConversation,
  listConversations,
  listSiblings,
  renameConversation,
  setActiveLeaf,
  updateAssistant,
  type ChatMessage,
  type Conversation,
} from "../store/conversations";
import {
  applyFontScale,
  applyTheme,
  loadSettings,
  normalizeTemperature,
  saveSettings,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  TEMPERATURE_STEP,
  type AppSettings,
  type FontScale,
  type ThemeMode,
} from "../store/settings";
import {
  aggregateUsage,
  recordUsage,
  type UsageAggregate,
  type UsageRange,
} from "../store/usageLedger";
import { ensureCitationPopover } from "./citationPopover";
import { estimateContextUsage, renderContextUsagePanel } from "./contextUsage";
import { decodeCodeAttr } from "./markdown";
import { mountMermaid, resetMermaidTheme } from "./mermaidMount";
import {
  flattenToolCalls,
  renderAnnotatedContent,
  renderThinkingBlock,
  upsertLiveCall,
} from "./thinking";
import {
  ensureUsageChartTooltip,
  formatCny,
  formatTokens,
  renderUsageBarChart,
  renderUsageRangeSwitch,
} from "./usageChart";
import { clearApiKey, hasApiKey, loadApiKey, saveApiKey } from "../vault/keyVault";

type SettingsTab =
  | "api"
  | "prompts"
  | "usage"
  | "chats"
  | "language"
  | "font"
  | "personalization"
  | "theme"
  | "about";
type PromptsPane = "skill" | "rule";

type AppState = {
  conversations: Conversation[];
  activeId: string | null;
  settings: AppSettings;
  keyPresent: boolean;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  /**
   * Mobile/portrait drill-in: false = category list only, true = category content.
   * Desktop split view ignores this and always shows both panes.
   */
  settingsDrillIn: boolean;
  /** Mobile-only Skill/Rule pane within the prompts settings page. */
  promptsPane: PromptsPane;
  usageRange: UsageRange;
  usageAggregate: UsageAggregate | null;
  balanceInfo: BalanceInfo | null;
  balanceError: string;
  usageBusy: boolean;
  sidebarCollapsed: boolean;
  /** Mobile-style conversation drawer over the main chat. */
  sidebarOpen: boolean;
  streaming: boolean;
  status: string;
  error: string;
  /** Conversation id currently being renamed in the sidebar. */
  renamingId: string | null;
  /** User message id currently open in the inline editor. */
  editingMessageId: string | null;
  /** Last completed request's API prompt_tokens for calibration display. */
  lastPromptTokens: number | null;
  /** Whether the context-usage detail panel is expanded under the ring. */
  contextUsageExpanded: boolean;
  /** Composer sampling params panel (mutually exclusive with context detail). */
  paramsPanelOpen: boolean;
  /** Delete-all confirm: 0 closed, 1 first warn, 2 final confirm. */
  deleteAllStep: 0 | 1 | 2;
  /** True while wipe + recreate runs after final confirm. */
  deleteAllBusy: boolean;
};

const PLATFORM_USAGE_URL = "https://platform.deepseek.com/usage";

type SettingsNavIcon =
  | "key"
  | "data"
  | "chats"
  | "prompts"
  | "user"
  | "theme"
  | "globe"
  | "type"
  | "external"
  | "info";

type SettingsNavTab = {
  kind: "tab";
  id: SettingsTab;
  label: string;
  icon: SettingsNavIcon;
};
type SettingsNavLink = {
  kind: "link";
  label: string;
  href: string;
  icon: SettingsNavIcon;
};
type SettingsNavItem = SettingsNavTab | SettingsNavLink;

/** Official-style settings groups with small section labels. */
const SETTINGS_GROUPS: Array<{ label: string; items: SettingsNavItem[] }> = [
  {
    label: "账户",
    items: [
      { kind: "tab", id: "api", label: "API", icon: "key" },
      { kind: "tab", id: "usage", label: "数据管理", icon: "data" },
      { kind: "tab", id: "chats", label: "对话管理", icon: "chats" },
    ],
  },
  {
    label: "应用",
    items: [
      { kind: "tab", id: "prompts", label: "提示词", icon: "prompts" },
      { kind: "tab", id: "personalization", label: "个性化", icon: "user" },
      { kind: "tab", id: "theme", label: "主题", icon: "theme" },
      { kind: "tab", id: "language", label: "语言", icon: "globe" },
      { kind: "tab", id: "font", label: "字体大小", icon: "type" },
    ],
  },
  {
    label: "关于",
    items: [
      {
        kind: "link",
        label: "deepseek开放平台",
        href: PLATFORM_USAGE_URL,
        icon: "external",
      },
      { kind: "tab", id: "about", label: "声明", icon: "info" },
    ],
  },
];

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = SETTINGS_GROUPS.flatMap((group) =>
  group.items
    .filter((item): item is SettingsNavTab => item.kind === "tab")
    .map((item) => ({ id: item.id, label: item.label })),
);

const SETTINGS_TAB_IDS = new Set<SettingsTab>(SETTINGS_TABS.map((t) => t.id));

/** Lucide-style 16px glyph for a settings nav row (ISC). */
function settingsNavIconSvg(icon: SettingsNavIcon): string {
  const common =
    'class="settings-nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  switch (icon) {
    case "key":
      return `<svg ${common}><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>`;
    case "data":
      return `<svg ${common}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>`;
    case "chats":
      return `<svg ${common}><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>`;
    case "prompts":
      return `<svg ${common}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    case "user":
      return `<svg ${common}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
    case "theme":
      return `<svg ${common}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`;
    case "globe":
      return `<svg ${common}><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
    case "type":
      return `<svg ${common}><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/></svg>`;
    case "external":
      return `<svg ${common}><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`;
    case "info":
      return `<svg ${common}><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
  }
}

/** Renders the grouped settings sidebar list (DeepSeek-style icon rows). */
function renderSettingsNavList(activeId: SettingsTab): string {
  return SETTINGS_GROUPS.map((group) => {
    const items = group.items
      .map((item) => {
        const icon = settingsNavIconSvg(item.icon);
        if (item.kind === "link") {
          return `<a
            class="settings-nav-item settings-nav-link"
            href="${item.href}"
            target="_blank"
            rel="noopener noreferrer"
            title="${item.label}"
          >${icon}<span class="settings-nav-label">${item.label}</span></a>`;
        }
        return `<button
          type="button"
          class="settings-nav-item ${activeId === item.id ? "active" : ""}"
          data-action="settings-tab"
          data-id="${item.id}"
        >${icon}<span class="settings-nav-label">${item.label}</span></button>`;
      })
      .join("");
    return `<div class="settings-nav-group">
      <div class="settings-nav-group-label">${group.label}</div>
      <div class="settings-nav-group-items">${items}</div>
    </div>`;
  }).join("");
}

/** Mounts the DeepReplica chat shell into the given root element. */
export async function mountApp(root: HTMLElement): Promise<void> {
  const initialSettings = await loadSettings();
  const state: AppState = {
    conversations: [],
    activeId: null,
    settings: initialSettings,
    keyPresent: await hasApiKey(),
    settingsOpen: false,
    settingsTab: "api",
    settingsDrillIn: false,
    promptsPane: "skill",
    usageRange: initialSettings.usageRange,
    usageAggregate: null,
    balanceInfo: null,
    balanceError: "",
    usageBusy: false,
    sidebarCollapsed: false,
    sidebarOpen: false,
    streaming: false,
    status: "",
    error: "",
    renamingId: null,
    editingMessageId: null,
    lastPromptTokens: null,
    contextUsageExpanded: false,
    paramsPanelOpen: false,
    deleteAllStep: 0,
    deleteAllBusy: false,
  };

  applyFontScale(state.settings.fontScale);
  applyTheme(state.settings.theme);

  let abortController: AbortController | null = null;
  /** Remembers per-message thinking open state across paints (auto-collapse + user toggles). */
  const thinkingOpen = new Map<string, boolean>();

  /** Reloads balance + local usage aggregate for the data-management panel. */
  async function refreshUsagePanel(): Promise<void> {
    state.usageBusy = true;
    state.balanceError = "";
    if (state.settingsOpen && state.settingsTab === "usage") {
      render();
    }
    try {
      state.usageAggregate = await aggregateUsage(state.usageRange);
      if (state.keyPresent) {
        const apiKey = await loadApiKey();
        if (apiKey) {
          const balance = await fetchUserBalance(state.settings.apiBase, apiKey);
          state.balanceInfo = pickBalance(balance);
        } else {
          state.balanceInfo = null;
          state.balanceError = "无法读取 API key";
        }
      } else {
        state.balanceInfo = null;
      }
    } catch (err) {
      state.balanceError = err instanceof Error ? err.message : String(err);
    } finally {
      state.usageBusy = false;
      if (state.settingsOpen && state.settingsTab === "usage") {
        render();
      }
    }
  }

  /** Applies a time range, persists it, and reloads the usage chart. */
  async function applyUsageRange(range: UsageRange): Promise<void> {
    state.usageRange = range;
    state.settings = { ...state.settings, usageRange: range };
    await saveSettings(state.settings);
    await refreshUsagePanel();
  }

  /** Loads the data-management tab: refresh aggregate + chart as soon as entered. */
  async function enterUsageSettingsTab(): Promise<void> {
    state.settingsTab = "usage";
    state.settingsDrillIn = true;
    state.error = "";
    state.status = "";
    await refreshUsagePanel();
  }

  /** Reloads conversation list from IndexedDB and keeps a valid active id. */
  async function refreshList(): Promise<void> {
    state.conversations = await listConversations();
    if (!state.activeId && state.conversations.length > 0) {
      state.activeId = state.conversations[0].id;
    }
    if (state.activeId && !state.conversations.some((c) => c.id === state.activeId)) {
      state.activeId = state.conversations[0]?.id ?? null;
    }
  }

  /** Returns the currently selected conversation from the in-memory list. */
  function activeConversation(): Conversation | null {
    return state.conversations.find((c) => c.id === state.activeId) ?? null;
  }

  /** Escapes text for safe insertion into HTML. */
  function escapeHtml(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  /** Maps a conversation timestamp to a DeepSeek-style sidebar date group. */
  function groupLabel(ts: number): string {
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startYesterday = startToday - 86_400_000;
    if (ts >= startToday) {
      return "今天";
    }
    if (ts >= startYesterday) {
      return "昨天";
    }
    return "更早";
  }

  /** Builds the sidebar conversation list HTML, grouped by day. */
  function renderConversationList(): string {
    if (state.conversations.length === 0) {
      return `<div class="hint-inline" style="padding:8px">暂无历史对话</div>`;
    }
    let lastGroup = "";
    return state.conversations
      .map((c) => {
        const group = groupLabel(c.updatedAt);
        const heading =
          group !== lastGroup
            ? ((lastGroup = group), `<div class="group-label">${group}</div>`)
            : "";
        if (state.renamingId === c.id) {
          return `${heading}
          <div class="conversation-item ${c.id === state.activeId ? "active" : ""} renaming">
            <input
              class="title-input"
              data-role="rename-input"
              data-id="${c.id}"
              value="${escapeHtml(c.title)}"
              maxlength="80"
            />
            <button type="button" class="delete" data-action="delete" data-id="${c.id}" title="删除">×</button>
          </div>`;
        }
        return `${heading}
          <div class="conversation-item ${c.id === state.activeId ? "active" : ""}">
            <button type="button" class="title" data-action="select" data-id="${c.id}" data-rename-id="${c.id}">${escapeHtml(c.title)}</button>
            <button type="button" class="delete" data-action="delete" data-id="${c.id}" title="删除">×</button>
          </div>`;
      })
      .join("");
  }

  /** Branch switcher ◀ n/m ▶ when the message has siblings. */
  function renderBranchSwitcher(conversation: Conversation, message: ChatMessage): string {
    const siblings = listSiblings(conversation, message.id);
    if (siblings.length < 2) {
      return "";
    }
    const index = siblings.findIndex((s) => s.id === message.id);
    const n = index >= 0 ? index + 1 : 1;
    const disabled = state.streaming ? "disabled" : "";
    const prevId = index > 0 ? siblings[index - 1].id : "";
    const nextId = index >= 0 && index < siblings.length - 1 ? siblings[index + 1].id : "";
    return `<div class="branch-switch" data-role="branch-switch">
      <button type="button" class="branch-btn" data-action="branch-prev" data-id="${message.id}" data-target="${prevId}" ${disabled || !prevId ? "disabled" : ""} aria-label="上一分支">◀</button>
      <span class="branch-meta">${n} / ${siblings.length}</span>
      <button type="button" class="branch-btn" data-action="branch-next" data-id="${message.id}" data-target="${nextId}" ${disabled || !nextId ? "disabled" : ""} aria-label="下一分支">▶</button>
    </div>`;
  }

  /** Lucide-style copy glyph (ISC) for the message copy action. */
  function copyIconSvg(): string {
    return `<svg class="msg-action-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  }

  /** Lucide-style refresh-cw glyph (ISC) for regenerate. */
  function regenerateIconSvg(): string {
    return `<svg class="msg-action-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>`;
  }

  /** Action row under a user bubble (edit). */
  function renderUserActions(message: ChatMessage): string {
    if (state.streaming) {
      return "";
    }
    return `<div class="message-actions">
      <button type="button" class="msg-action" data-action="edit-user" data-id="${message.id}">编辑</button>
    </div>`;
  }

  /** Action row under an assistant bubble (copy / regenerate / continue). */
  function renderAssistantActions(
    conversation: Conversation,
    message: ChatMessage,
    isLastOnPath: boolean,
  ): string {
    if (state.streaming) {
      return "";
    }
    const copyBtn = message.content.trim()
      ? `<button type="button" class="msg-action" data-action="copy-message" data-id="${message.id}">${copyIconSvg()}<span class="msg-action-label">复制</span></button>`
      : "";
    if (!isLastOnPath) {
      return copyBtn ? `<div class="message-actions">${copyBtn}</div>` : "";
    }
    const hasTools = Boolean(message.serverToolCalls?.some((s) => s.calls?.length));
    const canContinue =
      Boolean(message.interrupted) && Boolean(message.content.trim()) && !hasTools;
    return `<div class="message-actions">
      ${copyBtn}
      <button type="button" class="msg-action" data-action="regenerate" data-id="${message.id}">${regenerateIconSvg()}<span class="msg-action-label">重新生成</span></button>
      ${
        canContinue
          ? `<button type="button" class="msg-action" data-action="continue" data-id="${message.id}">继续生成</button>`
          : ""
      }
    </div>`;
  }

  /** Renders one message on the active path (user or assistant). */
  function renderPathMessage(
    conversation: Conversation,
    message: ChatMessage,
    index: number,
    path: ChatMessage[],
  ): string {
    const isLast = index === path.length - 1;
    const branch = renderBranchSwitcher(conversation, message);

    if (message.role === "user") {
      if (state.editingMessageId === message.id) {
        return `<article class="message user editing" data-message-id="${message.id}">
          ${branch}
          <textarea class="edit-user-input" data-role="edit-user-input" data-id="${message.id}" rows="3">${escapeHtml(message.content)}</textarea>
          <div class="message-actions">
            <button type="button" class="msg-action primary" data-action="save-edit-user" data-id="${message.id}">保存并发送</button>
            <button type="button" class="msg-action" data-action="cancel-edit-user">取消</button>
          </div>
        </article>`;
      }
      return `<article class="message user" data-message-id="${message.id}">
        ${branch}
        <div class="user-text">${escapeHtml(message.content)}</div>
        ${renderUserActions(message)}
      </article>`;
    }

    const streamingThis = state.streaming && isLast && message.role === "assistant";
    const expanded = thinkingOpen.has(message.id) ? thinkingOpen.get(message.id)! : true;
    const thinking = renderThinkingBlock({
      reasoningContent: message.reasoningContent,
      serverToolCalls: message.serverToolCalls,
      reasoningStartedAt: message.reasoningStartedAt,
      reasoningEndedAt: message.reasoningEndedAt,
      streaming: streamingThis,
      expanded,
    });
    const bodyHtml = renderAnnotatedContent(
      message.content || (streamingThis ? "…" : ""),
      message.annotations,
      message.serverToolCalls,
    );
    return `<article class="message assistant" data-message-id="${message.id}">
      ${branch}
      ${thinking}
      <div class="body">${bodyHtml}</div>
      ${renderAssistantActions(conversation, message, isLast)}
    </article>`;
  }

  /** DeepSeek mobile–style two-line icon for opening the conversation list. */
  function historyIcon(): string {
    return `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <path d="M5 8h14M5 16h9"/>
    </svg>`;
  }

  /** Circle-plus mark drawn as SVG so the cross sits on the geometric center. */
  function plusIcon(): string {
    return `<span class="plus" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 2.2v7.6M2.2 6h7.6"/></svg></span>`;
  }

  /** Settings gear sized to match sidebar text, not emoji metrics. */
  function settingsIcon(): string {
    return `<span class="settings-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.55-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.82 14.16a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.43.34.68.22l2.39-.96c.5.39 1.04.7 1.63.94l.36 2.54c.05.24.26.42.5.42h3.8c.24 0 .45-.18.5-.42l.36-2.54c.59-.24 1.13-.55 1.63-.94l2.39.96c.25.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"/></svg></span>`;
  }

  /** Builds the context-usage snapshot for the active conversation + optional draft. */
  function buildContextSnapshot(draft = ""): ReturnType<typeof estimateContextUsage> {
    const active = activeConversation();
    const path = active ? getActivePath(active) : [];
    return estimateContextUsage({
      messages: path,
      draft,
      toolsEnabled: state.settings.webSearchEnabled,
    });
  }

  /** Renders only the context usage panel (used by full render and local refresh). */
  function renderContextPanelHtml(draft = ""): string {
    return renderContextUsagePanel(buildContextSnapshot(draft), {
      lastPromptTokens: state.lastPromptTokens,
      expanded: state.contextUsageExpanded,
    });
  }

  /** Updates the context panel in-place without rebuilding the whole shell. */
  function refreshContextUsagePanel(draft?: string): void {
    if (state.paramsPanelOpen) {
      return;
    }
    const el = root.querySelector<HTMLElement>('[data-role="context-usage"]');
    if (!el) {
      return;
    }
    const text =
      draft ??
      root.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')?.value ??
      "";
    const html = renderContextPanelHtml(text);
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    const next = wrap.firstElementChild;
    if (next) {
      el.replaceWith(next);
    }
  }

  /** One-time click handler so the ring toggle survives local panel refreshes. */
  function ensureContextToggleDelegation(): void {
    if (root.dataset.ctxToggleDelegate === "1") {
      return;
    }
    root.dataset.ctxToggleDelegate = "1";
    root.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
        '[data-action="toggle-context-usage"]',
      );
      if (!target || !root.contains(target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      state.paramsPanelOpen = false;
      state.contextUsageExpanded = !state.contextUsageExpanded;
      render();
    });
  }

  /** Formats temperature for display (one decimal). */
  function formatTemperature(value: number): string {
    return normalizeTemperature(value).toFixed(1);
  }

  /** Sampling params panel in the same slot as context usage (covers the ring). */
  function renderParamsPanel(): string {
    const useDefault = state.settings.temperatureUseDefault;
    const temp = formatTemperature(state.settings.temperature);
    const disabled = useDefault ? "disabled" : "";
    return `
      <div class="composer-params" data-role="composer-params">
        <div class="composer-params-head">
          <span class="composer-params-title">参数</span>
          <button
            type="button"
            class="composer-params-close"
            data-action="close-params"
            title="关闭"
            aria-label="关闭参数"
          >×</button>
        </div>
        <label class="composer-params-check">
          <input
            type="checkbox"
            data-action="toggle-temperature-default"
            ${useDefault ? "checked" : ""}
          />
          <span>使用官方默认 Temperature</span>
        </label>
        <div class="composer-params-row ${useDefault ? "is-disabled" : ""}">
          <div class="composer-params-label">Temperature</div>
          <div class="composer-params-controls">
            <input
              type="range"
              class="composer-params-slider"
              data-role="temperature-slider"
              min="${TEMPERATURE_MIN}"
              max="${TEMPERATURE_MAX}"
              step="${TEMPERATURE_STEP}"
              value="${temp}"
              ${disabled}
              aria-label="Temperature"
            />
            <input
              type="number"
              class="composer-params-number"
              data-role="temperature-input"
              min="${TEMPERATURE_MIN}"
              max="${TEMPERATURE_MAX}"
              step="${TEMPERATURE_STEP}"
              value="${temp}"
              ${disabled}
              aria-label="Temperature 数值"
            />
          </div>
        </div>
        <p class="composer-params-hint">勾选时不传 temperature，由接口使用官方默认值；取消勾选后可自定义（0–2）。</p>
      </div>`;
  }

  /** Sliders glyph for the composer params toggle (left of send). */
  function paramsIconSvg(): string {
    return `<svg class="params-btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="1" x2="7" y1="14" y2="14"/><line x1="9" x2="15" y1="8" y2="8"/><line x1="17" x2="23" y1="16" y2="16"/></svg>`;
  }

  /** DeepSeek chat-demo think glyph (MIT) for the 深度思考 chip. */
  function thinkChipIconSvg(): string {
    return `<svg class="chip-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7.06431 5.93342C7.68763 5.93342 8.19307 6.43904 8.19322 7.06233C8.19322 7.68573 7.68772 8.19123 7.06431 8.19123C6.44099 8.19113 5.9354 7.68567 5.9354 7.06233C5.93555 6.43911 6.44108 5.93353 7.06431 5.93342Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M8.6815 0.963693C10.1169 0.447019 11.6266 0.374829 12.5633 1.31135C13.5 2.24805 13.4277 3.75776 12.911 5.19319C12.7126 5.74431 12.4386 6.31796 12.0965 6.89729C12.4969 7.54638 12.8141 8.19018 13.036 8.80647C13.5527 10.2419 13.6251 11.7516 12.6883 12.6883C11.7516 13.625 10.242 13.5527 8.8065 13.036C8.19022 12.8141 7.54641 12.4969 6.89732 12.0965C6.31797 12.4386 5.74435 12.7125 5.19322 12.911C3.75777 13.4276 2.2481 13.5 1.31138 12.5633C0.374859 11.6266 0.447049 10.1168 0.963724 8.68147C1.17185 8.10338 1.46321 7.50063 1.82896 6.8924C1.52182 6.35711 1.27235 5.82825 1.08872 5.31819C0.572068 3.88278 0.499714 2.37306 1.43638 1.43635C2.37308 0.499655 3.8828 0.572044 5.31822 1.08869C5.82828 1.27232 6.35715 1.5218 6.89243 1.82893C7.50066 1.46318 8.10341 1.17181 8.6815 0.963693ZM11.3573 8.01154C10.9083 8.62253 10.3901 9.22873 9.80943 9.8094C9.22877 10.3901 8.62255 10.9083 8.01158 11.3572C8.4257 11.5841 8.8287 11.7688 9.21275 11.9071C10.5456 12.3868 11.4246 12.2547 11.8397 11.8397C12.2548 11.4246 12.3869 10.5456 11.9071 9.21272C11.7688 8.82866 11.5841 8.42568 11.3573 8.01154ZM2.56529 8.02912C2.37344 8.39322 2.21495 8.74796 2.09263 9.08772C1.61291 10.4204 1.74512 11.2995 2.16001 11.7147C2.57505 12.1297 3.45415 12.2618 4.78697 11.7821C5.11057 11.6656 5.44786 11.5164 5.7938 11.3367C5.249 10.9223 4.70922 10.4533 4.19029 9.9344C3.57578 9.31987 3.03169 8.67633 2.56529 8.02912ZM6.90708 3.2469C6.24065 3.70479 5.5646 4.26321 4.91392 4.91389C4.26325 5.56456 3.70482 6.24063 3.24693 6.90705C3.72674 7.63325 4.32777 8.37459 5.03892 9.08576C5.64943 9.69627 6.28183 10.2265 6.90806 10.6678C7.59368 10.2025 8.2908 9.63076 8.96079 8.96076C9.6308 8.29075 10.2025 7.59366 10.6678 6.90803C10.2265 6.2818 9.69631 5.6494 9.08579 5.03889C8.37462 4.32773 7.63328 3.72672 6.90708 3.2469ZM11.7147 2.15998C11.2996 1.74509 10.4204 1.61288 9.08775 2.0926C8.74835 2.21479 8.39382 2.37271 8.03013 2.56428C8.67728 3.03065 9.31995 3.5758 9.93443 4.19026C10.4534 4.7092 10.9223 5.24896 11.3368 5.79377C11.5164 5.44785 11.6656 5.11052 11.7821 4.78694C12.2618 3.45416 12.1297 2.57502 11.7147 2.15998ZM4.91197 2.2176C3.57922 1.73788 2.70004 1.86995 2.28501 2.28498C1.87001 2.70003 1.73791 3.5792 2.21763 4.91194C2.31709 5.18822 2.44112 5.47427 2.58677 5.7674C3.01931 5.1887 3.51474 4.6158 4.06529 4.06526C4.61584 3.5147 5.18872 3.01928 5.76743 2.58674C5.47431 2.4411 5.18824 2.31706 4.91197 2.2176Z" fill="currentColor"/></svg>`;
  }

  /** DeepSeek chat-demo search glyph (MIT) for the 联网搜索 chip. */
  function searchChipIconSvg(): string {
    return `<svg class="chip-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.748 6.7028C11.748 3.90104 9.47653 1.62976 6.6748 1.62956C3.87291 1.62956 1.60156 3.90091 1.60156 6.7028C1.60176 9.50453 3.87304 11.776 6.6748 11.776C9.47641 11.7759 11.7479 9.50441 11.748 6.7028ZM13.0479 6.7028C13.0477 10.2224 10.1944 13.0757 6.6748 13.0759C3.15507 13.0759 0.300977 10.2225 0.300781 6.7028C0.300781 3.18294 3.15494 0.328781 6.6748 0.328781C10.1945 0.328977 13.0479 3.18307 13.0479 6.7028Z" fill="currentColor"/><path d="M15.6991 14.7513L14.7792 15.6712L11.3974 12.2894L12.3173 11.3694L15.6991 14.7513Z" fill="currentColor"/></svg>`;
  }

  /** DeepSeek chat-demo light theme glyph (MIT). */
  function themeLightIconSvg(): string {
    return `<svg class="settings-theme-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.3496 8C11.3496 6.14985 9.85015 4.65039 8 4.65039C6.14985 4.65039 4.65039 6.14985 4.65039 8C4.65039 9.85015 6.14985 11.3496 8 11.3496C9.85015 11.3496 11.3496 9.85015 11.3496 8ZM12.6504 8C12.6504 10.5681 10.5681 12.6504 8 12.6504C5.43188 12.6504 3.34961 10.5681 3.34961 8C3.34961 5.43188 5.43188 3.34961 8 3.34961C10.5681 3.34961 12.6504 5.43188 12.6504 8Z" fill="currentColor"/><path d="M8.65039 0.5V2.5H7.34961V0.5H8.65039Z" fill="currentColor"/><path d="M8.65039 13.5V15.5H7.34961V13.5H8.65039Z" fill="currentColor"/><path d="M3.15808 2.24035L4.57229 3.65456L3.6525 4.57435L2.23829 3.16014L3.15808 2.24035Z" fill="currentColor"/><path d="M12.3505 11.4327L13.7647 12.8469L12.8449 13.7667L11.4307 12.3525L12.3505 11.4327Z" fill="currentColor"/><path d="M2.24537 12.8469L3.65958 11.4327L4.57937 12.3525L3.16516 13.7667L2.24537 12.8469Z" fill="currentColor"/><path d="M11.4377 3.65455L12.852 2.24033L13.7718 3.16012L12.3575 4.57434L11.4377 3.65455Z" fill="currentColor"/><path d="M0.5 7.35461H2.5V8.6554H0.5L0.5 7.35461Z" fill="currentColor"/><path d="M13.5 7.35461H15.5V8.6554H13.5V7.35461Z" fill="currentColor"/></svg>`;
  }

  /** DeepSeek chat-demo dark theme glyph (MIT). */
  function themeDarkIconSvg(): string {
    return `<svg class="settings-theme-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.2764 9.52324C12.5607 9.97754 11.7177 10.242 10.7812 10.242C8.11386 10.2419 5.95042 8.07997 5.9502 5.41289C5.9502 4.48128 6.21453 3.61071 6.67188 2.87285C4.30332 3.4658 2.54992 5.60845 2.5498 8.16093C2.5498 11.1712 4.99103 13.6102 8 13.6102C10.5383 13.6102 12.6709 11.8724 13.2764 9.52324ZM7.05078 5.41289C7.051 7.47224 8.72116 9.1423 10.7812 9.14238C11.9248 9.14238 12.887 8.63397 13.5781 7.8084C13.7266 7.63106 13.9701 7.56547 14.1875 7.64433C14.4049 7.72329 14.5497 7.9297 14.5498 8.16093C14.5498 11.7766 11.6161 14.7098 8 14.7098C4.38402 14.7098 1.4502 11.7792 1.4502 8.16093C1.45033 4.54322 4.3812 1.61015 8 1.61015C8.23027 1.61015 8.43585 1.75352 8.51562 1.96953C8.59536 2.18554 8.53241 2.42829 8.35742 2.57793C7.55573 3.26311 7.05078 4.27876 7.05078 5.41289Z" fill="currentColor"/></svg>`;
  }

  /** DeepSeek chat-demo follow-system theme glyph (MIT). */
  function themeSystemIconSvg(): string {
    return `<svg class="settings-theme-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M12.4827 13.9839V15.2741H3.33758V13.9839H12.4827Z" fill="currentColor"/><path d="M13.8586 6.9289C13.8586 5.878 13.8584 5.14055 13.7976 4.57328C13.7381 4.01805 13.6272 3.7012 13.4572 3.46376C13.3198 3.27189 13.1511 3.10413 12.9592 2.96679C12.7217 2.79691 12.4049 2.68587 11.8497 2.62637C11.2824 2.5656 10.545 2.56438 9.49404 2.56438H6.50486C5.45396 2.56438 4.71651 2.56558 4.14923 2.62637C3.59403 2.6859 3.27715 2.79683 3.03972 2.96679C2.84797 3.10407 2.68003 3.27201 2.54274 3.46376C2.37279 3.70119 2.26186 4.01807 2.20232 4.57328C2.14154 5.14055 2.14033 5.878 2.14033 6.9289C2.14033 7.97984 2.14156 8.71721 2.20232 9.28452C2.26183 9.83981 2.37285 10.1566 2.54274 10.394C2.68009 10.5859 2.84784 10.7547 3.03972 10.8921C3.27715 11.062 3.59401 11.1729 4.14923 11.2325C4.71651 11.2933 5.45396 11.2934 6.50486 11.2934H9.49404C10.5449 11.2934 11.2824 11.2932 11.8497 11.2325C12.4048 11.173 12.7217 11.0619 12.9592 10.8921C13.1511 10.7547 13.3198 10.5859 13.4572 10.394C13.627 10.1566 13.7381 9.83971 13.7976 9.28452C13.8584 8.71722 13.8586 7.97982 13.8586 6.9289ZM15.1498 6.9289C15.1498 7.95152 15.1504 8.77008 15.0805 9.42216C15.0094 10.0861 14.8595 10.6536 14.5068 11.1463C14.2871 11.4532 14.0184 11.722 13.7115 11.9417C13.2188 12.2944 12.6512 12.4442 11.9873 12.5154C11.3352 12.5852 10.5166 12.5847 9.49404 12.5847H6.50486C5.48257 12.5847 4.6646 12.5852 4.01265 12.5154C3.34871 12.4442 2.78118 12.2944 2.28848 11.9417C1.98155 11.722 1.71285 11.4532 1.49312 11.1463C1.14044 10.6536 0.989539 10.0861 0.918395 9.42216C0.848541 8.77009 0.850101 7.95148 0.850101 6.9289C0.8501 5.90665 0.848582 5.08862 0.918395 4.43669C0.989539 3.77275 1.14044 3.20522 1.49312 2.71252C1.71285 2.40559 1.98155 2.13689 2.28848 1.91716C2.78118 1.56449 3.34871 1.41358 4.01265 1.34244C4.66458 1.27262 5.48261 1.27414 6.50486 1.27414H9.49404C10.5166 1.27414 11.3352 1.27259 11.9873 1.34244C12.6512 1.41358 13.2188 1.56449 13.7115 1.91716C14.0184 2.13689 14.2871 2.40559 14.5068 2.71252C14.8595 3.20522 15.0094 3.77275 15.0805 4.43669C15.1503 5.08864 15.1498 5.90661 15.1498 6.9289Z" fill="currentColor"/></svg>`;
  }

  /** Builds the centered composer card used on empty and chat screens. */
  function renderComposer(): string {
    const aboveComposer = state.paramsPanelOpen
      ? renderParamsPanel()
      : renderContextPanelHtml("");
    return `
      <div class="composer-stack">
        ${aboveComposer}
        <form class="composer-card" data-role="composer">
          <textarea name="prompt" placeholder="请输入消息" ${state.streaming ? "disabled" : ""}></textarea>
          <div class="composer-toolbar">
            <div class="composer-tools">
              <button
                type="button"
                class="chip ${state.settings.thinkingEnabled ? "active" : ""}"
                data-action="toggle-thinking"
                ${state.streaming ? "disabled" : ""}
                aria-pressed="${state.settings.thinkingEnabled}"
                title="深度思考"
              >${thinkChipIconSvg()}<span class="chip-label-full">深度思考</span><span class="chip-label-short">思考</span></button>
              <button
                type="button"
                class="chip ${state.settings.webSearchEnabled ? "active" : ""}"
                data-action="toggle-web-search"
                ${state.streaming ? "disabled" : ""}
                aria-pressed="${state.settings.webSearchEnabled}"
                title="${
                  state.settings.thinkingEnabled
                    ? "联网搜索（深度思考搜索）"
                    : "联网搜索"
                }"
              >${searchChipIconSvg()}<span class="chip-label-full">联网搜索</span><span class="chip-label-short">联网</span></button>
            </div>
            <div class="composer-actions">
              ${
                state.streaming
                  ? `<button type="button" class="stop-btn" data-action="stop">停止</button>`
                  : ""
              }
              <button
                type="button"
                class="params-btn ${state.paramsPanelOpen ? "active" : ""}"
                data-action="toggle-params"
                title="参数"
                aria-label="采样参数"
                aria-pressed="${state.paramsPanelOpen}"
              >${paramsIconSvg()}</button>
              <button type="submit" class="send-btn" title="发送" ${state.streaming ? "disabled" : ""}>↑</button>
            </div>
          </div>
        </form>
        <div class="status-line ${state.error ? "error" : ""}">${escapeHtml(state.error || state.status)}</div>
      </div>
    `;
  }

  /** Renders one settings category panel for the right-hand content area. */
  function renderSettingsSection(): string {
    if (state.settingsTab === "api") {
      const keyPlaceholder = state.keyPresent
        ? "已保存（输入新值可覆盖）"
        : "请输入 API Key";
      const keyHint = state.keyPresent
        ? "当前已保存加密 API key，写入本机 IndexedDB（AES-256-GCM）。"
        : "尚未配置 API key；密钥不会进入 localStorage。";
      return `
        <div class="settings-stack" data-role="settings-panel">
          <header class="settings-page-head">
            <h2>API</h2>
            <p>对话只保存在本机，没有应用服务器。密钥经加密后写入 IndexedDB。</p>
          </header>
          <div class="settings-cells">
            <div class="settings-cell">
              <div class="settings-cell-label">API Key</div>
              <div class="settings-pill-field">
                <input
                  type="password"
                  name="apiKey"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="${keyPlaceholder}"
                />
              </div>
              <p class="settings-cell-hint">${keyHint}</p>
            </div>
            <div class="settings-cell">
              <div class="settings-cell-label">API 根地址</div>
              <div class="settings-pill-field">
                <input
                  type="url"
                  name="apiBase"
                  spellcheck="false"
                  value="${escapeHtml(state.settings.apiBase)}"
                />
              </div>
              <p class="settings-cell-hint">默认 <code>https://api.deepseek.com</code>，一般无需修改。</p>
            </div>
            <div class="settings-cell settings-cell-row">
              <div class="settings-cell-copy">
                <div class="settings-cell-label">保存更改</div>
                <p class="settings-cell-hint">清除密钥后需重新填写才能发消息。</p>
              </div>
              <div class="settings-cell-actions">
                <button type="button" class="settings-btn settings-btn-danger" data-action="clear-key">清除密钥</button>
                <button type="button" class="settings-btn settings-btn-primary" data-action="save-settings">保存</button>
              </div>
            </div>
          </div>
        </div>`;
    }

    if (state.settingsTab === "prompts") {
      return `
      <div class="settings-stack settings-prompts pane-${state.promptsPane}">
        <header class="settings-page-head">
          <h2>提示词</h2>
          <p>Skill 与 Rule 写在同一页，后续编辑器会接在这里。</p>
        </header>
        <div class="settings-pane-switch" role="tablist" aria-label="Skill 与 Rule">
          <button
            type="button"
            role="tab"
            class="settings-pane-btn ${state.promptsPane === "skill" ? "active" : ""}"
            aria-selected="${state.promptsPane === "skill"}"
            data-action="prompts-pane"
            data-id="skill"
          >Skill</button>
          <button
            type="button"
            role="tab"
            class="settings-pane-btn ${state.promptsPane === "rule" ? "active" : ""}"
            aria-selected="${state.promptsPane === "rule"}"
            data-action="prompts-pane"
            data-id="rule"
          >Rule</button>
        </div>
        <div class="settings-panel-flat">
          <section class="settings-block" data-pane="skill">
            <div class="settings-block-head">
              <h3>Skill</h3>
              <p>可复用的技能说明，按需注入对话。</p>
            </div>
            <div class="settings-placeholder">Skill 编辑即将到来。</div>
          </section>
          <section class="settings-block" data-pane="rule">
            <div class="settings-block-head">
              <h3>Rule</h3>
              <p>全局规则与约束，始终作用于回复。</p>
            </div>
            <div class="settings-placeholder">Rule 编辑即将到来。</div>
          </section>
        </div>
      </div>`;
    }

    if (state.settingsTab === "usage") {
      const agg = state.usageAggregate;
      const bal = state.balanceInfo;
      const balText = bal
        ? `${bal.currency === "CNY" ? "¥" : ""}${escapeHtml(bal.total_balance)} ${escapeHtml(bal.currency)}`
        : state.keyPresent
          ? state.usageBusy
            ? "加载中…"
            : "—"
          : "需先配置 API Key";
      return `
        <div class="settings-stack">
          <header class="settings-page-head">
            <h2>数据管理</h2>
            <p>余额来自 DeepSeek 官方接口；柱状图与请求/Tokens 为本机对话账本（估算消费，非平台账单）。</p>
          </header>
          ${renderUsageRangeSwitch(state.usageRange)}
          <div class="usage-summary">
            <div class="usage-metric">
              <div class="usage-metric-label">余额</div>
              <div class="usage-metric-value">${balText}</div>
            </div>
            <div class="usage-metric">
              <div class="usage-metric-label">
                <span class="usage-metric-label-full">本机请求次数</span>
                <span class="usage-metric-label-short">请求次数</span>
              </div>
              <div class="usage-metric-value">${agg ? `${agg.requests} 次` : "—"}</div>
            </div>
            <div class="usage-metric">
              <div class="usage-metric-label">
                <span class="usage-metric-label-full">本机消耗Tokens</span>
                <span class="usage-metric-label-short">消耗Tokens</span>
              </div>
              <div class="usage-metric-value">${agg ? formatTokens(agg.tokens) : "—"}</div>
            </div>
            <div class="usage-metric">
              <div class="usage-metric-label">
                <span class="usage-metric-label-full">本机估算消费</span>
                <span class="usage-metric-label-short">消费</span>
              </div>
              <div class="usage-metric-value">${agg ? formatCny(agg.costCny) : "—"}</div>
            </div>
          </div>
          ${
            state.balanceError
              ? `<p class="hint-inline error-inline">${escapeHtml(state.balanceError)}</p>`
              : ""
          }
          <div class="usage-chart-panel">
            <div class="usage-chart-card">
              <div class="usage-chart-head">
                <h3>
                  消费金额（CNY）
                  <span class="usage-chart-total">${agg ? formatCny(agg.costCny) : "¥0"}</span>
                </h3>
                <button type="button" class="settings-refresh" data-action="refresh-usage" ${
                  state.usageBusy ? "disabled" : ""
                }>刷新</button>
              </div>
              ${
                agg
                  ? renderUsageBarChart(agg)
                  : `<div class="settings-placeholder">${state.usageBusy ? "加载中…" : "暂无本机用量数据"}</div>`
              }
            </div>
          </div>
        </div>`;
    }

    if (state.settingsTab === "chats") {
      return `
        <div class="settings-stack">
          <div class="settings-cells">
            <div class="settings-cell settings-cell-row">
              <div class="settings-cell-copy">
                <div class="settings-cell-label">删除全部对话</div>
                <p class="settings-cell-hint">清除本机全部对话；密钥、设置与用量账本会保留。</p>
              </div>
              <div class="settings-cell-actions">
                <button
                  type="button"
                  class="settings-btn settings-btn-danger"
                  data-action="delete-all-open"
                  title="删除全部对话"
                >删除</button>
              </div>
            </div>
          </div>
        </div>`;
    }

    if (state.settingsTab === "language") {
      return `
        <div class="settings-stack">
          <div class="settings-cells">
            <div class="settings-cell settings-cell-row">
              <div class="settings-cell-copy">
                <div class="settings-cell-label">语言</div>
                <p class="settings-cell-hint">当前仅提供简体中文，后续会开放更多语言。</p>
              </div>
              <div class="settings-cell-actions">
                <span class="settings-inline-value">简体中文</span>
              </div>
            </div>
          </div>
        </div>`;
    }

    if (state.settingsTab === "font") {
      const scales: Array<{ id: FontScale; label: string }> = [
        { id: "sm", label: "小" },
        { id: "md", label: "标准" },
        { id: "lg", label: "大" },
      ];
      return `
        <div class="settings-stack">
          <div class="settings-cells">
            <div class="settings-cell">
              <div class="settings-cell-label">字体大小</div>
              <p class="settings-cell-hint">调整对话与设置页的正文字号。</p>
              <div class="settings-choice-row" role="radiogroup" aria-label="字体大小">
                ${scales
                  .map(
                    (s) => `<button
                      type="button"
                      role="radio"
                      class="settings-choice ${state.settings.fontScale === s.id ? "active" : ""}"
                      aria-checked="${state.settings.fontScale === s.id}"
                      data-action="font-scale"
                      data-id="${s.id}"
                    >${s.label}</button>`,
                  )
                  .join("")}
              </div>
            </div>
          </div>
        </div>`;
    }

    if (state.settingsTab === "personalization") {
      return `
        <div class="settings-stack">
          <div class="settings-cells">
            <label class="settings-cell settings-cell-row settings-toggle-cell">
              <div class="settings-cell-copy">
                <div class="settings-cell-label">思考内容自动折叠</div>
                <p class="settings-cell-hint">启用后，思考完毕自动折叠思考链。</p>
              </div>
              <input
                type="checkbox"
                data-action="toggle-auto-collapse"
                ${state.settings.autoCollapseThinking ? "checked" : ""}
              />
            </label>
          </div>
        </div>`;
    }

    if (state.settingsTab === "theme") {
      const themes: Array<{ id: ThemeMode; label: string; icon: string }> = [
        { id: "light", label: "浅色", icon: themeLightIconSvg() },
        { id: "dark", label: "深色", icon: themeDarkIconSvg() },
        { id: "system", label: "跟随系统", icon: themeSystemIconSvg() },
      ];
      return `
        <div class="settings-stack">
          <div class="settings-cells">
            <div class="settings-cell">
              <div class="settings-cell-label">主题</div>
              <p class="settings-cell-hint">切换浅色 / 深色，或跟随系统外观。</p>
              <div class="settings-theme-options" role="radiogroup" aria-label="主题">
                ${themes
                  .map(
                    (t) => `<button
                      type="button"
                      role="radio"
                      class="settings-theme-option ${state.settings.theme === t.id ? "active" : ""}"
                      aria-checked="${state.settings.theme === t.id}"
                      data-action="theme-mode"
                      data-id="${t.id}"
                    >${t.icon}<span>${t.label}</span></button>`,
                  )
                  .join("")}
              </div>
            </div>
          </div>
        </div>`;
    }

    return `
      <div class="settings-stack">
        <div class="settings-cells about-copy">
          <div class="settings-cell">
            <div class="settings-cell-label">声明</div>
            <p>DeepReplica 为非官方客户端，与 DeepSeek 官方无隶属关系。</p>
            <p>对话内容与 API Key 仅加密保存在本机 IndexedDB，不会上传到应用服务器。</p>
            <p>「数据管理」中的柱状图与请求/Tokens 来自本机对话账本；消费金额为按公开单价估算。余额来自 DeepSeek 官方 <code>/user/balance</code> 接口。清除全部对话请使用「对话管理」。</p>
            <p>完整平台账单与明细请以开放平台为准：${escapeHtml(PLATFORM_USAGE_URL)}</p>
          </div>
        </div>
      </div>`;
  }

  /** True when settings use stacked drill-in (mobile / portrait) instead of split panes. */
  function isSettingsStackLayout(): boolean {
    return window.matchMedia("(max-width: 800px), (orientation: portrait)").matches;
  }

  /** DeepSeek-style centered confirm dialog for wipe-all (two-step). */
  function renderDeleteAllModal(): string {
    if (state.deleteAllStep === 0) {
      return "";
    }
    const step = state.deleteAllStep;
    const busy = state.deleteAllBusy;
    const title = step === 1 ? "删除全部对话？" : "再次确认删除";
    const body =
      step === 1
        ? "将清除本机全部对话记录。API 密钥、设置与用量账本会保留。此操作不可恢复。"
        : "请再次确认：删除后无法找回对话内容。确定继续？";
    const primaryAction = step === 1 ? "delete-all-continue" : "delete-all-confirm";
    const primaryLabel = step === 1 ? "继续删除" : busy ? "删除中…" : "删除全部对话";
    return `
      <div class="ds-modal-overlay" data-action="delete-all-dismiss" aria-hidden="false">
        <div
          class="ds-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-all-title"
          data-role="delete-all-modal"
        >
          <div class="ds-modal-header">
            <h2 id="delete-all-title" class="ds-modal-title">${title}</h2>
            <button
              type="button"
              class="ds-modal-close"
              data-action="delete-all-cancel"
              title="关闭"
              aria-label="关闭"
              ${busy ? "disabled" : ""}
            >×</button>
          </div>
          <div class="ds-modal-body">${body}</div>
          <div class="ds-modal-footer" aria-busy="${busy}">
            <button
              type="button"
              class="ds-btn ds-btn-outlined"
              data-action="delete-all-cancel"
              ${busy ? "disabled" : ""}
            >取消</button>
            <button
              type="button"
              class="ds-btn ${step === 1 ? "ds-btn-danger-outlined" : "ds-btn-danger"}"
              data-action="${primaryAction}"
              ${busy ? "disabled" : ""}
            >${primaryLabel}</button>
          </div>
        </div>
      </div>`;
  }

  /** Full-window settings page: left categories, right content (mobile: drill-in levels). */
  function renderSettingsPage(): void {
    const activeTab = SETTINGS_TABS.find((t) => t.id === state.settingsTab);
    const stacked = isSettingsStackLayout();
    const inDetail = stacked && state.settingsDrillIn;
    const pageClass = [
      "settings-page",
      inDetail ? "is-detail" : "is-menu",
    ].join(" ");
    root.innerHTML = `
      <div class="${pageClass}">
        <aside class="settings-nav" aria-label="设置分类">
          <button
            type="button"
            class="settings-back"
            data-action="${inDetail ? "settings-menu" : "close-settings"}"
            title="${inDetail ? "返回设置分类" : "返回对话"}"
          >← 返回</button>
          <div class="settings-nav-title">${
            inDetail ? escapeHtml(activeTab?.label ?? "设置") : "设置"
          }</div>
          <nav class="settings-nav-list">
            ${renderSettingsNavList(state.settingsTab)}
          </nav>
        </aside>
        <main class="settings-main">
          ${renderSettingsSection()}
          <p class="status-line ${state.error ? "error" : ""}">${escapeHtml(state.error || state.status)}</p>
        </main>
      </div>
      ${renderDeleteAllModal()}
    `;
    bindEvents();
  }

  /** Renders the full shell from current state. */
  function render(): void {
    if (state.settingsOpen) {
      renderSettingsPage();
      return;
    }

    const active = activeConversation();
    const isEmpty = !active || getActivePath(active).length === 0;
    const shellClass = [
      "app-shell",
      state.sidebarCollapsed ? "sidebar-collapsed" : "",
      state.sidebarOpen ? "sidebar-open" : "",
    ]
      .filter(Boolean)
      .join(" ");

    root.innerHTML = `
      <div class="${shellClass}">
        ${
          state.sidebarOpen
            ? `<div class="drawer-mask" data-action="close-history" aria-hidden="true"></div>`
            : ""
        }
        <aside class="sidebar" aria-label="对话列表">
          <div class="sidebar-top">
            <div class="brand">DeepReplica</div>
            <button type="button" class="icon-btn" data-action="close-history" title="关闭对话列表" aria-label="关闭对话列表">✕</button>
          </div>
          <button type="button" class="new-chat" data-action="new" title="开启新对话">
            ${plusIcon()}<span>开启新对话</span>
          </button>
          <div class="conversation-list">${renderConversationList()}</div>
          <div class="sidebar-footer">
            <button type="button" class="settings-entry" data-action="open-settings" title="设置">
              ${settingsIcon()}<span>设置</span>
            </button>
          </div>
        </aside>
        <section class="main ${isEmpty ? "is-empty" : ""}">
          <header class="main-topbar">
            <button
              type="button"
              class="history-btn"
              data-action="open-history"
              title="对话列表"
              aria-label="对话列表"
            >${historyIcon()}</button>
            <button
              type="button"
              class="icon-btn new-chat-top"
              data-action="new"
              title="开启新对话"
              aria-label="开启新对话"
            >${plusIcon()}</button>
          </header>
          ${
            isEmpty
              ? `<div class="empty-wrap">
                  <h1 class="greeting">今天有什么可以帮到你？</h1>
                  <div class="composer-dock">${renderComposer()}</div>
                </div>`
              : `<div class="messages" data-role="messages">
                  <div class="messages-inner">
                    ${(() => {
                      const path = getActivePath(active!);
                      return path
                        .map((m, index) => renderPathMessage(active!, m, index, path))
                        .join("");
                    })()}
                  </div>
                </div>
                <div class="composer-dock">${renderComposer()}</div>`
          }
        </section>
      </div>
    `;

    const messagesEl = root.querySelector('[data-role="messages"]');
    if (messagesEl) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    bindEvents();
    void mountMermaid(root);
  }

  /** Copies code or message text to the clipboard and briefly flashes the button label. */
  async function handleCopyClick(btn: HTMLElement): Promise<void> {
    const action = btn.dataset.action;
    let text = "";
    try {
      if (action === "copy-code") {
        text = decodeCodeAttr(btn.dataset.code ?? "");
      } else if (action === "copy-message" && btn.dataset.id) {
        const conv = activeConversation();
        const msg = conv ? findMessage(conv, btn.dataset.id) : undefined;
        text = msg?.content ?? "";
      }
      if (!text) {
        return;
      }
      await navigator.clipboard.writeText(text);
      const label = btn.querySelector<HTMLElement>(".msg-action-label");
      const previous = label?.textContent ?? btn.textContent ?? "复制";
      if (label) {
        label.textContent = "已复制";
      } else {
        btn.textContent = "已复制";
      }
      btn.classList.add("copied");
      window.setTimeout(() => {
        if (!btn.isConnected) {
          return;
        }
        if (label?.isConnected) {
          label.textContent = previous;
        } else if (!btn.querySelector(".msg-action-icon")) {
          btn.textContent = previous;
        }
        btn.classList.remove("copied");
      }, 1200);
    } catch {
      state.error = "复制失败";
      render();
    }
  }

  /** One-time root click delegation so copy buttons survive stream paints. */
  function ensureCopyDelegation(): void {
    if (root.dataset.copyDelegate === "1") {
      return;
    }
    root.dataset.copyDelegate = "1";
    root.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
        '[data-action="copy-code"], [data-action="copy-message"]',
      );
      if (!target || !root.contains(target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void handleCopyClick(target);
    });
  }

  /**
   * One-time change delegation for the usage time-range select.
   * Avoids handleAction.preventDefault (which can break native selects)
   * and survives full settings re-renders.
   */
  function ensureUsageRangeDelegation(): void {
    if (root.dataset.usageRangeDelegate === "1") {
      return;
    }
    root.dataset.usageRangeDelegate = "1";
    root.addEventListener("change", (event) => {
      const select = (event.target as HTMLElement | null)?.closest?.("select[data-role='usage-range']");
      if (!(select instanceof HTMLSelectElement) || !root.contains(select)) {
        return;
      }
      const value = select.value;
      if (value === "today" || value === "7d" || value === "30d") {
        void applyUsageRange(value);
      }
    });
  }

  /** Wires click and form handlers after each render. */
  function bindEvents(): void {
    ensureCopyDelegation();
    ensureCitationPopover(root);
    ensureUsageChartTooltip(root);
    ensureUsageRangeDelegation();
    ensureContextToggleDelegation();
    if (state.deleteAllStep > 0) {
      const onKey = (event: KeyboardEvent): void => {
        if (event.key !== "Escape" || state.deleteAllBusy) {
          return;
        }
        state.deleteAllStep = 0;
        render();
      };
      window.addEventListener("keydown", onKey, { once: true });
    }
    root.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", (event) => {
        const target = event.currentTarget as HTMLElement;
        const action = target.dataset.action;
        if (
          action === "copy-code" ||
          action === "copy-message" ||
          action === "toggle-context-usage"
        ) {
          return;
        }
        const id = target.dataset.id;
        void handleAction(action, id, event, target);
      });
    });

    root.querySelectorAll<HTMLButtonElement>(".conversation-item .title").forEach((btn) => {
      btn.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const renameId = btn.dataset.renameId;
        if (renameId && !state.streaming) {
          state.renamingId = renameId;
          render();
        }
      });
    });

    const renameInput = root.querySelector<HTMLInputElement>('[data-role="rename-input"]');
    if (renameInput) {
      renameInput.focus();
      renameInput.select();
      renameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void commitRename(renameInput.dataset.id, renameInput.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          state.renamingId = null;
          render();
        }
      });
      renameInput.addEventListener("blur", () => {
        void commitRename(renameInput.dataset.id, renameInput.value);
      });
    }

    const editInput = root.querySelector<HTMLTextAreaElement>('[data-role="edit-user-input"]');
    if (editInput) {
      editInput.focus();
      editInput.setSelectionRange(editInput.value.length, editInput.value.length);
    }

    const form = root.querySelector<HTMLFormElement>('[data-role="composer"]');
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      void sendMessage(form);
    });

    const textarea = form?.querySelector<HTMLTextAreaElement>("textarea");
    textarea?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void sendMessage(form!);
      }
    });
    textarea?.addEventListener("input", () => {
      refreshContextUsagePanel(textarea.value);
    });

    const tempSlider = root.querySelector<HTMLInputElement>('[data-role="temperature-slider"]');
    const tempInput = root.querySelector<HTMLInputElement>('[data-role="temperature-input"]');
    /** Keeps slider and number field in sync without a full shell re-render. */
    const syncTemperatureControls = (value: number): void => {
      const text = formatTemperature(value);
      if (tempSlider) {
        tempSlider.value = text;
      }
      if (tempInput) {
        tempInput.value = text;
      }
    };
    /** Applies a custom temperature; optionally persists to IndexedDB. */
    const applyTemperatureValue = async (raw: unknown, persist: boolean): Promise<void> => {
      if (state.settings.temperatureUseDefault) {
        return;
      }
      const next = normalizeTemperature(raw);
      state.settings = { ...state.settings, temperature: next };
      syncTemperatureControls(next);
      if (persist) {
        await saveSettings(state.settings);
      }
    };
    tempSlider?.addEventListener("input", () => {
      void applyTemperatureValue(tempSlider.value, false);
    });
    tempSlider?.addEventListener("change", () => {
      void applyTemperatureValue(tempSlider.value, true);
    });
    tempInput?.addEventListener("change", () => {
      void applyTemperatureValue(tempInput.value, true);
    });
    tempInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void applyTemperatureValue(tempInput.value, true);
      }
    });

    root.querySelectorAll<HTMLDetailsElement>('[data-role="thinking"]').forEach((details) => {
      details.addEventListener("toggle", () => {
        const messageId = details.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
        if (messageId) {
          thinkingOpen.set(messageId, details.open);
        }
      });
    });
  }

  /** Persists a sidebar rename, or cancels when the title is unchanged empty after trim rules. */
  async function commitRename(conversationId: string | undefined, title: string): Promise<void> {
    if (!conversationId || state.renamingId !== conversationId) {
      return;
    }
    state.renamingId = null;
    try {
      await renameConversation(conversationId, title);
      await refreshList();
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    }
    render();
  }

  /** Handles sidebar and settings button actions. */
  async function handleAction(
    action: string | undefined,
    id: string | undefined,
    event: Event,
    el?: HTMLElement,
  ): Promise<void> {
    if (!action) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    if (action === "open-history") {
      state.sidebarOpen = true;
      state.sidebarCollapsed = false;
      render();
      return;
    }
    if (action === "close-history") {
      state.sidebarOpen = false;
      render();
      return;
    }
    if (action === "toggle-thinking") {
      state.settings.thinkingEnabled = !state.settings.thinkingEnabled;
      await saveSettings(state.settings);
      render();
      return;
    }
    if (action === "toggle-web-search") {
      state.settings.webSearchEnabled = !state.settings.webSearchEnabled;
      await saveSettings(state.settings);
      render();
      return;
    }
    if (action === "toggle-params") {
      if (state.paramsPanelOpen) {
        state.paramsPanelOpen = false;
      } else {
        state.contextUsageExpanded = false;
        state.paramsPanelOpen = true;
      }
      render();
      return;
    }
    if (action === "close-params") {
      state.paramsPanelOpen = false;
      render();
      return;
    }
    if (action === "toggle-temperature-default") {
      state.settings = {
        ...state.settings,
        temperatureUseDefault: !state.settings.temperatureUseDefault,
      };
      await saveSettings(state.settings);
      render();
      return;
    }
    if (action === "new") {
      const created = await createConversation();
      state.activeId = created.id;
      state.sidebarOpen = false;
      state.error = "";
      state.status = "";
      state.editingMessageId = null;
      await refreshList();
      render();
      return;
    }
    if (action === "select" && id) {
      state.activeId = id;
      state.sidebarOpen = false;
      state.error = "";
      state.status = "";
      state.editingMessageId = null;
      render();
      return;
    }
    if (action === "delete" && id) {
      await deleteConversation(id);
      if (state.activeId === id) {
        state.activeId = null;
      }
      if (state.renamingId === id) {
        state.renamingId = null;
      }
      await refreshList();
      if (!state.activeId) {
        const created = await createConversation();
        state.activeId = created.id;
        await refreshList();
      }
      render();
      return;
    }
    if (action === "delete-all-open") {
      state.deleteAllStep = 1;
      state.deleteAllBusy = false;
      render();
      return;
    }
    if (action === "delete-all-dismiss") {
      if (state.deleteAllBusy || event.target !== el) {
        return;
      }
      state.deleteAllStep = 0;
      render();
      return;
    }
    if (action === "delete-all-cancel") {
      if (state.deleteAllBusy) {
        return;
      }
      state.deleteAllStep = 0;
      render();
      return;
    }
    if (action === "delete-all-continue") {
      if (state.deleteAllBusy) {
        return;
      }
      state.deleteAllStep = 2;
      render();
      return;
    }
    if (action === "delete-all-confirm") {
      if (state.deleteAllBusy) {
        return;
      }
      state.deleteAllBusy = true;
      render();
      if (abortController) {
        abortController.abort();
        abortController = null;
        state.streaming = false;
      }
      try {
        await deleteAllConversations();
        state.activeId = null;
        state.renamingId = null;
        state.editingMessageId = null;
        thinkingOpen.clear();
        const created = await createConversation();
        state.activeId = created.id;
        state.status = "已删除全部对话";
        state.error = "";
        state.deleteAllStep = 0;
        await refreshList();
      } catch (err) {
        state.error = err instanceof Error ? err.message : "删除全部对话失败";
        state.status = "";
      } finally {
        state.deleteAllBusy = false;
        render();
      }
      return;
    }
    if ((action === "branch-prev" || action === "branch-next") && id) {
      if (state.streaming || !state.activeId) {
        return;
      }
      const target = el?.dataset.target;
      if (!target) {
        return;
      }
      await setActiveLeaf(state.activeId, target);
      await refreshList();
      render();
      return;
    }
    if (action === "edit-user" && id) {
      if (state.streaming) {
        return;
      }
      state.editingMessageId = id;
      render();
      return;
    }
    if (action === "cancel-edit-user") {
      state.editingMessageId = null;
      render();
      return;
    }
    if (action === "save-edit-user" && id) {
      const input = root.querySelector<HTMLTextAreaElement>(
        `[data-role="edit-user-input"][data-id="${id}"]`,
      );
      const nextContent = input?.value.trim() ?? "";
      if (!nextContent) {
        return;
      }
      await editUserAndResend(id, nextContent);
      return;
    }
    if (action === "regenerate" && id) {
      await regenerateAssistant(id);
      return;
    }
    if (action === "continue" && id) {
      await continueAssistant(id);
      return;
    }
    if (action === "open-settings") {
      state.settingsOpen = true;
      state.settingsTab = "api";
      state.settingsDrillIn = false;
      state.sidebarOpen = false;
      state.error = "";
      state.status = "";
      render();
      return;
    }
    if (action === "close-settings") {
      state.settingsOpen = false;
      state.settingsDrillIn = false;
      state.error = "";
      state.status = "";
      render();
      return;
    }
    if (action === "settings-menu") {
      state.settingsDrillIn = false;
      state.error = "";
      state.status = "";
      render();
      return;
    }
    if (action === "settings-tab" && id && SETTINGS_TAB_IDS.has(id as SettingsTab)) {
      if (id === "usage") {
        await enterUsageSettingsTab();
        return;
      }
      state.settingsTab = id as SettingsTab;
      state.settingsDrillIn = true;
      state.error = "";
      state.status = "";
      render();
      return;
    }
    if (action === "prompts-pane" && id) {
      if (id === "skill" || id === "rule") {
        state.promptsPane = id;
        render();
      }
      return;
    }
    if (action === "refresh-usage") {
      await refreshUsagePanel();
      return;
    }
    if (action === "font-scale" && id) {
      if (id === "sm" || id === "md" || id === "lg") {
        state.settings = { ...state.settings, fontScale: id };
        await saveSettings(state.settings);
        render();
      }
      return;
    }
    if (action === "theme-mode" && id) {
      if (id === "light" || id === "dark" || id === "system") {
        state.settings = { ...state.settings, theme: id };
        await saveSettings(state.settings);
        resetMermaidTheme();
        render();
      }
      return;
    }
    if (action === "toggle-auto-collapse") {
      state.settings = {
        ...state.settings,
        autoCollapseThinking: !state.settings.autoCollapseThinking,
      };
      await saveSettings(state.settings);
      render();
      return;
    }
    if (action === "clear-key") {
      await clearApiKey();
      state.keyPresent = false;
      state.status = "已清除 API key";
      state.error = "";
      render();
      return;
    }
    if (action === "save-settings") {
      const panel = root.querySelector('[data-role="settings-panel"]');
      const keyInput = panel?.querySelector<HTMLInputElement>('input[name="apiKey"]');
      const baseInput = panel?.querySelector<HTMLInputElement>('input[name="apiBase"]');
      const nextBase = baseInput?.value.trim() || state.settings.apiBase;
      state.settings = {
        ...state.settings,
        apiBase: nextBase.replace(/\/$/, ""),
      };
      await saveSettings(state.settings);
      if (keyInput?.value.trim()) {
        await saveApiKey(keyInput.value);
        state.keyPresent = true;
      }
      state.status = "设置已保存";
      state.error = "";
      render();
      return;
    }
    if (action === "stop") {
      abortController?.abort();
      abortController = null;
      state.streaming = false;
      state.status = "已停止";
      render();
    }
  }

  /** Ensures an API key is present before starting a stream. */
  function requireApiKeyOrPrompt(): boolean {
    if (state.keyPresent) {
      return true;
    }
    state.settingsOpen = true;
    state.settingsTab = "api";
    state.settingsDrillIn = true;
    state.error = "请先在设置中填写 API key";
    render();
    return false;
  }

  /** Maps an active-path ChatMessage to a StreamChatMessage row. */
  function toStreamMessage(m: ChatMessage, prefix = false): StreamChatMessage {
    if (m.role === "user") {
      return { role: "user", content: m.content };
    }
    const row: StreamChatMessage = {
      role: "assistant",
      content: m.content,
    };
    if (m.reasoningContent) {
      row.reasoning_content = m.reasoningContent;
    }
    if (m.serverToolCalls?.length) {
      row.server_tool_calls = m.serverToolCalls;
    }
    if (prefix) {
      row.prefix = true;
    }
    return row;
  }

  /**
   * Builds API history from the active path.
   * `mode: "fresh"` omits the trailing empty assistant; `prefix` keeps it with prefix:true.
   */
  function buildHistory(
    conversation: Conversation,
    mode: "fresh" | "prefix",
  ): StreamChatMessage[] {
    const path = getActivePath(conversation).filter(
      (m) => m.role === "user" || m.role === "assistant",
    );
    if (mode === "prefix") {
      return path
        .filter(
          (m, index) =>
            m.role === "user" ||
            m.content.trim().length > 0 ||
            m.serverToolCalls?.length ||
            index === path.length - 1,
        )
        .map((m, index, arr) => toStreamMessage(m, index === arr.length - 1 && m.role === "assistant"));
    }
    const withoutTrailingEmpty = path.slice(0, -1);
    return withoutTrailingEmpty
      .filter((m) => m.role === "user" || m.content.trim().length > 0 || m.serverToolCalls?.length)
      .map((m) => toStreamMessage(m));
  }

  /** Sends the composer text as a new user turn under the current leaf. */
  async function sendMessage(form: HTMLFormElement): Promise<void> {
    if (state.streaming) {
      return;
    }
    const textarea = form.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]');
    const prompt = textarea?.value.trim() ?? "";
    if (!prompt) {
      return;
    }
    if (!requireApiKeyOrPrompt()) {
      return;
    }
    if (!state.activeId) {
      const created = await createConversation();
      state.activeId = created.id;
    }
    const conversationId = state.activeId;
    state.editingMessageId = null;
    if (textarea) {
      textarea.value = "";
    }
    await appendMessage(conversationId, { role: "user", content: prompt });
    const assistantTurn = await appendMessage(conversationId, {
      role: "assistant",
      content: "",
      reasoningContent: "",
    });
    const assistantId = assistantTurn.activeLeafId ?? "";
    await runAssistantStream({
      conversationId,
      assistantId,
      mode: "fresh",
      statusLabel: "发送中…",
      seedContent: "",
      seedReasoning: "",
    });
  }

  /** Creates a sibling assistant under the same user and re-streams. */
  async function regenerateAssistant(assistantId: string): Promise<void> {
    if (state.streaming || !state.activeId) {
      return;
    }
    if (!requireApiKeyOrPrompt()) {
      return;
    }
    const conversation = await getConversation(state.activeId);
    if (!conversation) {
      return;
    }
    const target = findMessage(conversation, assistantId);
    if (!target || target.role !== "assistant") {
      return;
    }
    const conversationId = state.activeId;
    const next = await appendChildMessage(conversationId, target.parentId, {
      role: "assistant",
      content: "",
      reasoningContent: "",
    });
    const newId = next.activeLeafId ?? "";
    await runAssistantStream({
      conversationId,
      assistantId: newId,
      mode: "fresh",
      statusLabel: "重新生成…",
      seedContent: "",
      seedReasoning: "",
    });
  }

  /** Continues a stopped assistant reply via Chat Prefix Completion (beta). */
  async function continueAssistant(assistantId: string): Promise<void> {
    if (state.streaming || !state.activeId) {
      return;
    }
    if (!requireApiKeyOrPrompt()) {
      return;
    }
    const conversation = await getConversation(state.activeId);
    if (!conversation) {
      return;
    }
    const target = findMessage(conversation, assistantId);
    if (!target || target.role !== "assistant" || !target.content.trim()) {
      return;
    }
    if (target.serverToolCalls?.some((s) => s.calls?.length)) {
      state.error = "使用过联网工具的回复无法续写，请改用重新生成";
      render();
      return;
    }
    await setActiveLeaf(state.activeId, assistantId);
    await runAssistantStream({
      conversationId: state.activeId,
      assistantId,
      mode: "prefix",
      statusLabel: "继续生成…",
      seedContent: target.content,
      seedReasoning: target.reasoningContent ?? "",
      seedReasoningStartedAt: target.reasoningStartedAt,
      seedAnnotations: target.annotations,
      seedServerToolCalls: target.serverToolCalls,
    });
  }

  /** Edits a user message by forking a sibling user + new assistant, then streams. */
  async function editUserAndResend(messageId: string, content: string): Promise<void> {
    if (state.streaming || !state.activeId) {
      return;
    }
    if (!requireApiKeyOrPrompt()) {
      return;
    }
    const conversation = await getConversation(state.activeId);
    if (!conversation) {
      return;
    }
    const target = findMessage(conversation, messageId);
    if (!target || target.role !== "user") {
      return;
    }
    const conversationId = state.activeId;
    state.editingMessageId = null;
    await appendChildMessage(conversationId, target.parentId, {
      role: "user",
      content,
    });
    const assistantTurn = await appendMessage(conversationId, {
      role: "assistant",
      content: "",
      reasoningContent: "",
    });
    const assistantId = assistantTurn.activeLeafId ?? "";
    await runAssistantStream({
      conversationId,
      assistantId,
      mode: "fresh",
      statusLabel: "发送中…",
      seedContent: "",
      seedReasoning: "",
    });
  }

  type StreamRunOptions = {
    conversationId: string;
    assistantId: string;
    mode: "fresh" | "prefix";
    statusLabel: string;
    seedContent: string;
    seedReasoning: string;
    seedReasoningStartedAt?: number;
    seedAnnotations?: ContentAnnotation[];
    seedServerToolCalls?: ServerToolStep[];
  };

  /** Shared streaming loop for send / regenerate / continue / edit-resend. */
  async function runAssistantStream(opts: StreamRunOptions): Promise<void> {
    const { conversationId, assistantId, mode } = opts;
    state.error = "";
    state.status = opts.statusLabel;
    state.streaming = true;
    if (assistantId) {
      thinkingOpen.set(assistantId, true);
    }
    await refreshList();
    render();

    const apiKey = await loadApiKey();
    if (!apiKey) {
      state.streaming = false;
      state.keyPresent = false;
      state.error = "无法读取 API key，请重新保存";
      render();
      return;
    }

    const conversation = await getConversation(conversationId);
    if (!conversation) {
      state.streaming = false;
      state.error = "对话不存在";
      render();
      return;
    }

    const history = buildHistory(conversation, mode);
    const userTurns = getActivePath(conversation).filter((m) => m.role === "user").length;
    const enableTitle = conversation.titleSource === "default" && userTurns <= 1;

    abortController = new AbortController();
    let content = opts.seedContent;
    let reasoning = opts.seedReasoning;
    let reasoningStartedAt: number | undefined = opts.seedReasoningStartedAt;
    let reasoningEndedAt: number | undefined;
    let liveCalls: ServerToolCall[] = flattenToolCalls(opts.seedServerToolCalls);
    let serverToolCalls: ServerToolStep[] | undefined = opts.seedServerToolCalls;
    let annotations: ContentAnnotation[] | undefined = opts.seedAnnotations;
    let interrupted = false;

    try {
      await streamChat({
        apiBase: state.settings.apiBase,
        apiKey,
        thinkingEnabled: state.settings.thinkingEnabled,
        webToolsEnabled: mode === "prefix" ? false : state.settings.webSearchEnabled,
        enableTitle,
        prefixCompletion: mode === "prefix",
        temperature: state.settings.temperatureUseDefault
          ? undefined
          : normalizeTemperature(state.settings.temperature),
        messages: history,
        signal: abortController.signal,
        onReasoningDelta: (text) => {
          if (!reasoningStartedAt) {
            reasoningStartedAt = Date.now();
          }
          reasoning += text;
          persistAndPaint(conversationId, assistantId, {
            content,
            reasoning,
            reasoningStartedAt,
            liveCalls,
            serverToolCalls,
            annotations,
          });
        },
        onContentDelta: (text) => {
          content += text;
          persistAndPaint(conversationId, assistantId, {
            content,
            reasoning,
            reasoningStartedAt,
            liveCalls,
            serverToolCalls,
            annotations,
          });
        },
        onToolEvent: (event) => {
          if (event.call) {
            liveCalls = upsertLiveCall(liveCalls, event.call);
            persistAndPaint(conversationId, assistantId, {
              content,
              reasoning,
              reasoningStartedAt,
              liveCalls,
              serverToolCalls,
              annotations,
            });
          }
        },
        onServerToolCalls: (steps) => {
          serverToolCalls = steps;
          liveCalls = flattenToolCalls(steps);
          persistAndPaint(conversationId, assistantId, {
            content,
            reasoning,
            reasoningStartedAt,
            liveCalls,
            serverToolCalls,
            annotations,
          });
        },
        onAnnotations: (next) => {
          annotations = next;
          persistAndPaint(conversationId, assistantId, {
            content,
            reasoning,
            reasoningStartedAt,
            liveCalls,
            serverToolCalls,
            annotations,
          });
        },
        onTitle: (title) => {
          void applyApiTitle(conversationId, title).then(async () => {
            await refreshList();
            const listBtn = root.querySelector<HTMLElement>(
              `.conversation-item .title[data-id="${conversationId}"]`,
            );
            const updated = state.conversations.find((c) => c.id === conversationId);
            if (listBtn && updated) {
              listBtn.textContent = updated.title;
            }
          });
        },
        onUsage: (usage) => {
          if (typeof usage.prompt_tokens === "number" && usage.prompt_tokens > 0) {
            state.lastPromptTokens = usage.prompt_tokens;
            refreshContextUsagePanel();
          }
          void recordUsage({
            model: "deepseek-flash",
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
            totalTokens: usage.total_tokens,
          });
        },
      });
      state.status = "完成";
      interrupted = false;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        state.status = "已停止";
        interrupted = Boolean(content.trim());
      } else {
        state.error = err instanceof Error ? err.message : String(err);
        state.status = "";
        interrupted = false;
      }
      if (mode === "fresh") {
        if (!content && state.error) {
          content = state.error;
        }
        if (!content) {
          content = "(空回复)";
        }
      }
    } finally {
      if (persistTimer !== null) {
        window.clearTimeout(persistTimer);
        persistTimer = null;
      }
      if (reasoning && !reasoningEndedAt) {
        reasoningEndedAt = Date.now();
      }
      if (assistantId) {
        await updateAssistant(conversationId, assistantId, {
          content,
          reasoningContent: reasoning || undefined,
          reasoningStartedAt,
          reasoningEndedAt,
          serverToolCalls,
          annotations,
          interrupted,
        });
        if (state.settings.autoCollapseThinking && reasoning) {
          thinkingOpen.set(assistantId, false);
        }
      }
      abortController = null;
      state.streaming = false;
      await refreshList();
      render();
    }
  }

  type PaintPayload = {
    conversationId: string;
    assistantId: string;
    content: string;
    reasoning: string;
    reasoningStartedAt?: number;
    reasoningEndedAt?: number;
    liveCalls?: ServerToolCall[];
    serverToolCalls?: ServerToolStep[];
    annotations?: ContentAnnotation[];
  };

  let paintQueued = false;
  let persistTimer: number | null = null;
  let pendingPaint: PaintPayload | null = null;

  /** Updates a specific assistant bubble in the DOM without rebuilding the whole shell. */
  function paintAssistant(payload: PaintPayload): void {
    const messagesEl = root.querySelector('[data-role="messages"]');
    const inner = messagesEl?.querySelector(".messages-inner") ?? messagesEl;
    if (!messagesEl || !inner) {
      return;
    }
    let article = inner.querySelector<HTMLElement>(
      `.message.assistant[data-message-id="${payload.assistantId}"]`,
    );
    if (!article) {
      article = inner.querySelector<HTMLElement>(".message.assistant:last-of-type");
    }
    if (!article) {
      article = document.createElement("article");
      article.className = "message assistant";
      article.dataset.messageId = payload.assistantId;
      article.innerHTML = `<div class="body"></div>`;
      inner.appendChild(article);
    } else {
      article.dataset.messageId = payload.assistantId;
    }
    const messageId = article.dataset.messageId;
    const expanded = messageId && thinkingOpen.has(messageId) ? thinkingOpen.get(messageId)! : true;
    const thinkingHtml = renderThinkingBlock({
      reasoningContent: payload.reasoning,
      serverToolCalls: payload.serverToolCalls,
      liveCalls: payload.liveCalls,
      reasoningStartedAt: payload.reasoningStartedAt,
      reasoningEndedAt: payload.reasoningEndedAt,
      streaming: true,
      expanded,
    });
    const existingThinking = article.querySelector('[data-role="thinking"]');
    if (thinkingHtml) {
      if (existingThinking) {
        existingThinking.outerHTML = thinkingHtml;
      } else {
        const bodyEl = article.querySelector(".body");
        if (bodyEl) {
          bodyEl.insertAdjacentHTML("beforebegin", thinkingHtml);
        } else {
          article.insertAdjacentHTML("afterbegin", thinkingHtml);
        }
      }
      const details = article.querySelector<HTMLDetailsElement>('[data-role="thinking"]');
      details?.addEventListener("toggle", () => {
        const id = article?.dataset.messageId;
        if (id && details) {
          thinkingOpen.set(id, details.open);
        }
      });
    } else {
      existingThinking?.remove();
    }
    const body = article.querySelector(".body");
    if (body) {
      body.innerHTML = renderAnnotatedContent(
        payload.content || "…",
        payload.annotations,
        payload.serverToolCalls,
      );
      void mountMermaid(body);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /** Coalesces stream UI updates and throttles IndexedDB writes of the assistant draft. */
  function persistAndPaint(
    conversationId: string,
    assistantId: string,
    draft: Omit<PaintPayload, "conversationId" | "assistantId">,
  ): void {
    pendingPaint = { conversationId, assistantId, ...draft };
    const conv = state.conversations.find((c) => c.id === conversationId);
    if (conv) {
      const target = conv.messages.find((m) => m.id === assistantId);
      if (target?.role === "assistant") {
        target.content = draft.content;
        target.reasoningContent = draft.reasoning;
        target.reasoningStartedAt = draft.reasoningStartedAt;
        target.reasoningEndedAt = draft.reasoningEndedAt;
        target.serverToolCalls = draft.serverToolCalls;
        target.annotations = draft.annotations;
      }
    }
    if (!paintQueued) {
      paintQueued = true;
      requestAnimationFrame(() => {
        paintQueued = false;
        const pending = pendingPaint;
        if (!pending) {
          return;
        }
        paintAssistant(pending);
      });
    }
    if (persistTimer !== null) {
      return;
    }
    persistTimer = window.setTimeout(() => {
      persistTimer = null;
      const pending = pendingPaint;
      if (!pending) {
        return;
      }
      void updateAssistant(pending.conversationId, pending.assistantId, {
        content: pending.content,
        reasoningContent: pending.reasoning || undefined,
        reasoningStartedAt: pending.reasoningStartedAt,
        reasoningEndedAt: pending.reasoningEndedAt,
        serverToolCalls: pending.serverToolCalls,
        annotations: pending.annotations,
      });
    }, 400);
  }

  await refreshList();
  if (!state.activeId) {
    const created = await createConversation();
    state.activeId = created.id;
    await refreshList();
  }
  if (!state.keyPresent) {
    state.settingsOpen = true;
    state.settingsTab = "api";
    state.settingsDrillIn = true;
  }
  render();
}
