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
  saveSettings,
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
import { decodeCodeAttr } from "./markdown";
import { mountMermaid, resetMermaidTheme } from "./mermaidMount";
import {
  flattenToolCalls,
  renderAnnotatedContent,
  renderThinkingBlock,
  upsertLiveCall,
} from "./thinking";
import {
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
};

const PLATFORM_USAGE_URL = "https://platform.deepseek.com/usage";

type SettingsNavTab = { kind: "tab"; id: SettingsTab; label: string };
type SettingsNavLink = {
  kind: "link";
  label: string;
  /** Shown when the nav column is too narrow for the full label. */
  shortLabel: string;
  href: string;
};
type SettingsNavItem = SettingsNavTab | SettingsNavLink;

/** Official-style settings groups with small section labels. */
const SETTINGS_GROUPS: Array<{ label: string; items: SettingsNavItem[] }> = [
  {
    label: "账户",
    items: [
      { kind: "tab", id: "api", label: "API" },
      { kind: "tab", id: "usage", label: "数据管理" },
    ],
  },
  {
    label: "应用",
    items: [
      { kind: "tab", id: "prompts", label: "提示词" },
      { kind: "tab", id: "personalization", label: "个性化" },
      { kind: "tab", id: "theme", label: "主题" },
      { kind: "tab", id: "language", label: "语言" },
      { kind: "tab", id: "font", label: "字体大小" },
    ],
  },
  {
    label: "关于",
    items: [
      {
        kind: "link",
        label: "deepseek开放平台",
        shortLabel: "开放平台",
        href: PLATFORM_USAGE_URL,
      },
      { kind: "tab", id: "about", label: "声明" },
    ],
  },
];

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = SETTINGS_GROUPS.flatMap((group) =>
  group.items
    .filter((item): item is SettingsNavTab => item.kind === "tab")
    .map((item) => ({ id: item.id, label: item.label })),
);

const SETTINGS_TAB_IDS = new Set<SettingsTab>(SETTINGS_TABS.map((t) => t.id));

/** Renders the grouped settings sidebar list with small section labels. */
function renderSettingsNavList(activeId: SettingsTab): string {
  return SETTINGS_GROUPS.map((group) => {
    const items = group.items
      .map((item) => {
        if (item.kind === "link") {
          return `<a
            class="settings-nav-item settings-nav-link"
            href="${item.href}"
            target="_blank"
            rel="noopener noreferrer"
            title="${item.label}"
          ><span class="settings-nav-link-full">${item.label}</span><span class="settings-nav-link-short">${item.shortLabel}</span></a>`;
        }
        return `<button
          type="button"
          class="settings-nav-item ${activeId === item.id ? "active" : ""}"
          data-action="settings-tab"
          data-id="${item.id}"
        >${item.label}</button>`;
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
  const state: AppState = {
    conversations: [],
    activeId: null,
    settings: await loadSettings(),
    keyPresent: await hasApiKey(),
    settingsOpen: false,
    settingsTab: "api",
    settingsDrillIn: false,
    promptsPane: "skill",
    usageRange: "today",
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
    }
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
      ? `<button type="button" class="msg-action" data-action="copy-message" data-id="${message.id}">复制</button>`
      : "";
    if (!isLastOnPath) {
      return copyBtn ? `<div class="message-actions">${copyBtn}</div>` : "";
    }
    const hasTools = Boolean(message.serverToolCalls?.some((s) => s.calls?.length));
    const canContinue = Boolean(message.content.trim()) && !hasTools;
    return `<div class="message-actions">
      ${copyBtn}
      <button type="button" class="msg-action" data-action="regenerate" data-id="${message.id}">重新生成</button>
      ${
        canContinue
          ? `<button type="button" class="msg-action" data-action="continue" data-id="${message.id}">继续生成</button>`
          : hasTools && message.content.trim()
            ? `<span class="msg-action-hint" title="使用过联网工具的回复无法续写">不可续写</span>`
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

  /** Builds the centered composer card used on empty and chat screens. */
  function renderComposer(): string {
    return `
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
            >深度思考</button>
          </div>
          <div class="composer-actions">
            ${
              state.streaming
                ? `<button type="button" class="stop-btn" data-action="stop">停止</button>`
                : ""
            }
            <button type="submit" class="send-btn" title="发送" ${state.streaming ? "disabled" : ""}>↑</button>
          </div>
        </div>
      </form>
      <div class="status-line ${state.error ? "error" : ""}">${escapeHtml(state.error || state.status)}</div>
    `;
  }

  /** Renders one settings category panel for the right-hand content area. */
  function renderSettingsSection(): string {
    if (state.settingsTab === "api") {
      return `
        <section class="settings-card" data-role="settings-panel">
          <div class="settings-card-head">
            <h2>API</h2>
            <p>密钥经 AES-256-GCM 加密后写入本机 IndexedDB，不会进入 localStorage。对话只保存在本机，没有应用服务器。</p>
          </div>
          <label>
            API Key
            <input type="password" name="apiKey" autocomplete="off" placeholder="${
              state.keyPresent ? "已保存（输入新值可覆盖）" : "请输入 API Key"
            }" />
          </label>
          <label>
            API 根地址
            <input type="url" name="apiBase" value="${escapeHtml(state.settings.apiBase)}" />
          </label>
          <p class="hint-inline">${
            state.keyPresent ? "当前已保存加密 API key。" : "尚未配置 API key。"
          }</p>
          <div class="settings-actions">
            <button type="button" class="danger" data-action="clear-key">清除密钥</button>
            <button type="button" class="primary" data-action="save-settings">保存</button>
          </div>
        </section>`;
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
              <div class="usage-metric-label">本机请求</div>
              <div class="usage-metric-value">${agg ? `${agg.requests} 次` : "—"}</div>
            </div>
            <div class="usage-metric">
              <div class="usage-metric-label">本机 Tokens</div>
              <div class="usage-metric-value">${agg ? formatTokens(agg.tokens) : "—"}</div>
            </div>
            <div class="usage-metric">
              <div class="usage-metric-label">本机估算消费</div>
              <div class="usage-metric-value">${agg ? formatCny(agg.costCny) : "—"}</div>
            </div>
          </div>
          ${
            state.balanceError
              ? `<p class="hint-inline error-inline">${escapeHtml(state.balanceError)}</p>`
              : ""
          }
          <div class="usage-chart-panel">
            <div class="usage-chart-head">
              <h3>消费金额（本机估算 · CNY）</h3>
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
        </div>`;
    }

    if (state.settingsTab === "language") {
      return `
        <div class="settings-stack">
          <header class="settings-page-head">
            <h2>语言</h2>
            <p>当前仅提供简体中文，后续会开放更多语言。</p>
          </header>
          <div class="settings-option-list">
            <button type="button" class="settings-option active" disabled aria-current="true">简体中文</button>
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
          <header class="settings-page-head">
            <h2>字体大小</h2>
            <p>调整对话与设置页的正文字号。</p>
          </header>
          <div class="settings-option-list" role="radiogroup" aria-label="字体大小">
            ${scales
              .map(
                (s) => `<button
                  type="button"
                  role="radio"
                  class="settings-option ${state.settings.fontScale === s.id ? "active" : ""}"
                  aria-checked="${state.settings.fontScale === s.id}"
                  data-action="font-scale"
                  data-id="${s.id}"
                >${s.label}</button>`,
              )
              .join("")}
          </div>
        </div>`;
    }

    if (state.settingsTab === "personalization") {
      return `
        <div class="settings-stack">
          <header class="settings-page-head">
            <h2>个性化</h2>
            <p>按你的阅读习惯调整思考链展示。</p>
          </header>
          <label class="settings-toggle-row">
            <span>
              <strong>思考内容自动折叠</strong>
              <span class="hint-inline">启用后，思考完毕自动折叠思考链</span>
            </span>
            <input
              type="checkbox"
              data-action="toggle-auto-collapse"
              ${state.settings.autoCollapseThinking ? "checked" : ""}
            />
          </label>
        </div>`;
    }

    if (state.settingsTab === "theme") {
      const themes: Array<{ id: ThemeMode; label: string }> = [
        { id: "light", label: "浅色" },
        { id: "dark", label: "深色" },
        { id: "system", label: "跟随系统" },
      ];
      return `
        <div class="settings-stack">
          <header class="settings-page-head">
            <h2>主题</h2>
            <p>切换浅色 / 深色，或跟随系统外观。</p>
          </header>
          <div class="settings-option-list" role="radiogroup" aria-label="主题">
            ${themes
              .map(
                (t) => `<button
                  type="button"
                  role="radio"
                  class="settings-option ${state.settings.theme === t.id ? "active" : ""}"
                  aria-checked="${state.settings.theme === t.id}"
                  data-action="theme-mode"
                  data-id="${t.id}"
                >${t.label}</button>`,
              )
              .join("")}
          </div>
        </div>`;
    }

    return `
      <div class="settings-stack">
        <header class="settings-page-head">
          <h2>声明</h2>
        </header>
        <div class="settings-panel-flat about-copy">
          <p>DeepReplica 为非官方客户端，与 DeepSeek 官方无隶属关系。</p>
          <p>对话内容与 API Key 仅加密保存在本机 IndexedDB，不会上传到应用服务器。</p>
          <p>「数据管理」中的柱状图与请求/Tokens 来自本机对话账本；消费金额为按公开单价估算。余额来自 DeepSeek 官方 <code>/user/balance</code> 接口。</p>
          <p>完整平台账单与明细请以开放平台为准：${escapeHtml(PLATFORM_USAGE_URL)}</p>
        </div>
      </div>`;
  }

  /** True when settings use stacked drill-in (mobile / portrait) instead of split panes. */
  function isSettingsStackLayout(): boolean {
    return window.matchMedia("(max-width: 800px), (orientation: portrait)").matches;
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
            <button type="button" class="danger-link" data-action="delete-all" title="删除全部对话">删除全部对话</button>
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
      const previous = btn.textContent ?? "复制";
      btn.textContent = "已复制";
      btn.classList.add("copied");
      window.setTimeout(() => {
        if (btn.isConnected) {
          btn.textContent = previous;
          btn.classList.remove("copied");
        }
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

  /** Wires click and form handlers after each render. */
  function bindEvents(): void {
    ensureCopyDelegation();
    root.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", (event) => {
        const target = event.currentTarget as HTMLElement;
        const action = target.dataset.action;
        if (action === "copy-code" || action === "copy-message") {
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

    root.querySelectorAll<HTMLDetailsElement>('[data-role="thinking"]').forEach((details) => {
      details.addEventListener("toggle", () => {
        const messageId = details.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
        if (messageId) {
          thinkingOpen.set(messageId, details.open);
        }
      });
    });

    const usageRange = root.querySelector<HTMLSelectElement>('[data-role="usage-range"]');
    usageRange?.addEventListener("change", (event) => {
      void handleAction("usage-range", usageRange.value, event);
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
    if (action === "delete-all") {
      const ok = window.confirm("确定删除全部对话？密钥、设置与用量账本会保留。");
      if (!ok) {
        return;
      }
      await deleteAllConversations();
      state.activeId = null;
      state.renamingId = null;
      state.editingMessageId = null;
      const created = await createConversation();
      state.activeId = created.id;
      state.status = "已删除全部对话";
      state.error = "";
      await refreshList();
      render();
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
      state.settingsTab = id as SettingsTab;
      state.settingsDrillIn = true;
      state.error = "";
      state.status = "";
      if (state.settingsTab === "usage") {
        render();
        await refreshUsagePanel();
        render();
        return;
      }
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
    if (action === "usage-range" && id) {
      if (id === "today" || id === "7d" || id === "30d") {
        state.usageRange = id;
        render();
        await refreshUsagePanel();
        render();
      }
      return;
    }
    if (action === "refresh-usage") {
      render();
      await refreshUsagePanel();
      render();
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

    try {
      await streamChat({
        apiBase: state.settings.apiBase,
        apiKey,
        thinkingEnabled: state.settings.thinkingEnabled,
        webToolsEnabled: mode === "prefix" ? false : state.settings.thinkingEnabled,
        enableTitle,
        prefixCompletion: mode === "prefix",
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
          void recordUsage({
            model: "deepseek-flash",
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
            totalTokens: usage.total_tokens,
          });
        },
      });
      state.status = "完成";
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        state.status = "已停止";
      } else {
        state.error = err instanceof Error ? err.message : String(err);
        state.status = "";
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
      body.innerHTML = renderAnnotatedContent(payload.content || "…", payload.annotations);
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
