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

const TOOLS_JSON =
  '[{"type":"deepseek_web_search"},{"type":"deepseek_read_url"}]';

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

/** Escapes text for safe HTML insertion in the panel. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Renders the Cursor-like context usage panel HTML. */
export function renderContextUsagePanel(
  snapshot: ContextUsageSnapshot,
  lastPromptTokens?: number | null,
): string {
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
          .map(
            (s) => `<li class="ctx-legend-item">
            <span class="ctx-dot ctx-seg-${s.tone}" aria-hidden="true"></span>
            <span class="ctx-legend-label">${escapeHtml(s.label)}</span>
            <span class="ctx-legend-value">${formatTokenShort(s.tokens)}</span>
          </li>`,
          )
          .join("")}</ul>`;

  const measured =
    typeof lastPromptTokens === "number" && lastPromptTokens > 0
      ? `<div class="ctx-measured">上轮实测 prompt：${formatTokenShort(lastPromptTokens)}</div>`
      : "";

  return `<div class="ctx-usage" data-role="context-usage">
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
  </div>`;
}
