import type { ChatMessage } from "../store/conversations";

/** Official deepseek-flash / v4-pro context window (input + output shared). */
export const CONTEXT_WINDOW = 1_048_576;

export type ContextSegmentId = "tools" | "conversation" | "draft";

export type ContextSegment = {
  id: ContextSegmentId;
  label: string;
  tokens: number;
  tone: ContextSegmentId;
};

export type ContextUsageSnapshot = {
  window: number;
  total: number;
  percent: number;
  segments: ContextSegment[];
};

export type ContextUsagePanelOptions = {
  lastPromptTokens?: number | null;
  /** When true, show the detailed bar + legend under the ring. */
  expanded?: boolean;
};

const TOOLS_JSON =
  '[{"type":"deepseek_web_search"},{"type":"deepseek_read_url"}]';

/** Circumference of the ring path (r=14 in a 36×36 viewBox). */
const RING_CIRCUMFERENCE = 2 * Math.PI * 14;

/** Rough token estimate: Unicode code points / 4 (no local tokenizer). */
export function estimateTokens(text: string): number {
  const n = Array.from(text).length;
  if (n <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(n / 4));
}

/** Serializes one chat message the way it contributes to the request payload size. */
function messagePayloadText(message: ChatMessage): string {
  const parts = [message.role, message.content];
  if (message.reasoningContent) {
    parts.push(message.reasoningContent);
  }
  if (message.serverToolCalls?.length) {
    parts.push(JSON.stringify(message.serverToolCalls));
  }
  if (message.annotations?.length) {
    parts.push(JSON.stringify(message.annotations));
  }
  return parts.join("\n");
}

/** Builds a context-usage snapshot for the next request (local estimate). */
export function estimateContextUsage(input: {
  messages: ChatMessage[];
  draft: string;
  toolsEnabled: boolean;
}): ContextUsageSnapshot {
  const segments: ContextSegment[] = [];

  if (input.toolsEnabled) {
    segments.push({
      id: "tools",
      label: "工具定义",
      tokens: estimateTokens(TOOLS_JSON),
      tone: "tools",
    });
  }

  const conversationText = input.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map(messagePayloadText)
    .join("\n");
  const conversationTokens = estimateTokens(conversationText);
  if (conversationTokens > 0) {
    segments.push({
      id: "conversation",
      label: "对话",
      tokens: conversationTokens,
      tone: "conversation",
    });
  }

  const draft = input.draft.trim();
  if (draft) {
    segments.push({
      id: "draft",
      label: "草稿",
      tokens: estimateTokens(draft),
      tone: "draft",
    });
  }

  const total = segments.reduce((sum, s) => sum + s.tokens, 0);
  const percent =
    CONTEXT_WINDOW > 0
      ? Math.min(100, Math.round((total / CONTEXT_WINDOW) * 1000) / 10)
      : 0;

  return {
    window: CONTEXT_WINDOW,
    total,
    percent,
    segments,
  };
}

/** Formats a token count like 1.6K / 128.1K for compact UI. */
export function formatTokenShort(n: number): string {
  if (n < 1000) {
    return String(Math.round(n));
  }
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}K`;
  }
  const m = n / 1_000_000;
  return `${Math.round(m * 10) / 10}M`;
}

/** Formats a segment's share of the context window for the legend. */
export function formatSegmentPercent(tokens: number, window: number): string {
  if (window <= 0 || tokens <= 0) {
    return "0%";
  }
  const pct = (tokens / window) * 100;
  if (pct > 0 && pct < 0.1) {
    return "<0.1%";
  }
  return `${Math.round(pct * 10) / 10}%`;
}

/** Escapes text for safe HTML insertion in the panel. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Builds the compact SVG ring. Very small non-zero usage still gets a short arc
 * so the indicator is visible against the track.
 */
function renderContextRing(percent: number, total: number): string {
  const visualPct = total > 0 ? Math.max(2, Math.min(100, percent || 2)) : 0;
  const dash = (visualPct / 100) * RING_CIRCUMFERENCE;
  const gap = RING_CIRCUMFERENCE - dash;
  return `<svg class="ctx-ring" viewBox="0 0 36 36" aria-hidden="true">
    <circle class="ctx-ring-track" cx="18" cy="18" r="14" fill="none" />
    <circle
      class="ctx-ring-fill"
      cx="18"
      cy="18"
      r="14"
      fill="none"
      stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}"
      stroke-dashoffset="0"
      transform="rotate(-90 18 18)"
    />
  </svg>`;
}

/** Renders the collapsible context usage control (ring + optional detail panel). */
export function renderContextUsagePanel(
  snapshot: ContextUsageSnapshot,
  options: ContextUsagePanelOptions = {},
): string {
  const lastPromptTokens = options.lastPromptTokens;
  const expanded = Boolean(options.expanded);
  const totalLabel = formatTokenShort(snapshot.total);
  const windowLabel = formatTokenShort(snapshot.window);
  const pct = snapshot.percent;

  const segments = snapshot.segments.filter((s) => s.tokens > 0);
  const bar =
    segments.length === 0
      ? `<div class="ctx-bar-empty"></div>`
      : segments
          .map((s) => {
            const width =
              snapshot.window > 0 ? Math.max(0.4, (s.tokens / snapshot.window) * 100) : 0;
            return `<span class="ctx-seg ctx-seg-${s.tone}" style="width:${width.toFixed(3)}%" title="${escapeHtml(s.label)}: ${s.tokens}"></span>`;
          })
          .join("");

  const legend =
    segments.length === 0
      ? `<div class="ctx-legend-empty">暂无上下文（发送后将计入对话）</div>`
      : `<ul class="ctx-legend">${segments
          .map((s) => {
            const tokensLabel = formatTokenShort(s.tokens);
            const pctLabel = formatSegmentPercent(s.tokens, snapshot.window);
            return `<li class="ctx-legend-item">
            <span class="ctx-dot ctx-seg-${s.tone}" aria-hidden="true"></span>
            <span class="ctx-legend-label">${escapeHtml(s.label)}</span>
            <span class="ctx-legend-tokens" title="${s.tokens} tokens">${escapeHtml(tokensLabel)}</span>
            <span class="ctx-legend-slash" aria-hidden="true">/</span>
            <span class="ctx-legend-pct">${escapeHtml(pctLabel)}</span>
          </li>`;
          })
          .join("")}</ul>`;

  const measured =
    typeof lastPromptTokens === "number" && lastPromptTokens > 0
      ? `<div class="ctx-measured">上轮实测 prompt：${formatTokenShort(lastPromptTokens)}</div>`
      : "";

  const detail = expanded
    ? `<button
        type="button"
        class="ctx-usage-detail"
        data-action="toggle-context-usage"
        aria-expanded="true"
        aria-label="上下文占用详情，点击收起"
        title="点击收起"
      >
        <div class="ctx-head">
          <div class="ctx-title-row">
            <span class="ctx-title">上下文占用</span>
            <span class="ctx-badge">估算</span>
          </div>
          <div class="ctx-meta">
            <span class="ctx-pct">${pct}% 已用</span>
            <span class="ctx-count">~${totalLabel} / ${windowLabel} Tokens</span>
          </div>
        </div>
        <div class="ctx-bar" role="img" aria-label="上下文占用 ${pct}%">${bar}</div>
        ${legend}
        ${measured}
      </button>`
    : `<button
        type="button"
        class="ctx-ring-btn"
        data-action="toggle-context-usage"
        aria-expanded="false"
        aria-label="上下文占用 ${pct}% 已用，约 ${totalLabel} / ${windowLabel} Tokens。点击展开详情"
        title="上下文占用 ~${totalLabel} / ${windowLabel}"
      >${renderContextRing(pct, snapshot.total)}</button>`;

  return `<div class="ctx-usage ${expanded ? "is-expanded" : "is-collapsed"}" data-role="context-usage" data-expanded="${expanded ? "true" : "false"}">
    ${detail}
  </div>`;
}
