import type {
  ContentAnnotation,
  ServerToolCall,
  ServerToolStep,
} from "../api/streamChat";
import { renderLatexHtml, renderMessageHtml } from "./markdown";

export type ThinkingRenderInput = {
  reasoningContent?: string;
  serverToolCalls?: ServerToolStep[];
  /** Live tool calls collected during streaming (before final steps arrive). */
  liveCalls?: ServerToolCall[];
  reasoningStartedAt?: number;
  reasoningEndedAt?: number;
  streaming?: boolean;
  /** When false, the chain is collapsed. Default expanded while streaming. */
  expanded?: boolean;
};

/** Escapes text for safe HTML insertion. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** DeepSeek-style atom mark used on the thinking header. */
function thinkingAtomIcon(): string {
  return `<svg class="thinking-atom" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <ellipse cx="12" cy="12" rx="9" ry="4" fill="none" stroke="#6a8cff" stroke-width="1.4" transform="rotate(0 12 12)"/>
    <ellipse cx="12" cy="12" rx="9" ry="4" fill="none" stroke="#6a8cff" stroke-width="1.4" transform="rotate(60 12 12)"/>
    <ellipse cx="12" cy="12" rx="9" ry="4" fill="none" stroke="#6a8cff" stroke-width="1.4" transform="rotate(120 12 12)"/>
    <circle cx="12" cy="12" r="1.6" fill="#6a8cff"/>
  </svg>`;
}

/** Chevron that rotates when the thinking block is expanded. */
function chevronIcon(): string {
  return `<svg class="thinking-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5 6 7.5 9 4.5"/></svg>`;
}

/** Formats thinking duration in whole seconds for the header label. */
export function formatThinkingSeconds(startedAt?: number, endedAt?: number, streaming?: boolean): number {
  if (!startedAt) {
    return 0;
  }
  const end = endedAt ?? (streaming ? Date.now() : startedAt);
  return Math.max(0, Math.round((end - startedAt) / 1000));
}

/** Builds the collapsible header label for a thinking chain. */
function thinkingSummaryLabel(
  startedAt?: number,
  endedAt?: number,
  streaming?: boolean,
): string {
  if (streaming) {
    return "深度思考中…";
  }
  const sec = formatThinkingSeconds(startedAt, endedAt, false);
  if (sec > 0) {
    return `已思考（用时 ${sec} 秒）`;
  }
  return "已思考";
}

/** Picks a favicon URL for a search source (site_icon or Google s2 fallback). */
function sourceIconUrl(source: { url: string; site_icon?: string }): string {
  if (source.site_icon) {
    return source.site_icon;
  }
  try {
    const host = new URL(source.url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
  } catch {
    return "";
  }
}

/** Renders one completed (or in-progress) server tool call row inside the chain. */
function renderToolCall(call: ServerToolCall): string {
  const actionType = call.action?.type || call.kind;
  if (actionType === "search" || call.kind === "search" || call.kind === "image_search" || call.kind === "deep_image_search") {
    const sources = call.sources ?? [];
    const count = sources.length;
    const label =
      call.status === "failed"
        ? "搜索失败"
        : count > 0
          ? `搜索到 ${count} 个网页`
          : call.status === "completed"
            ? "搜索完成"
            : "正在搜索…";
    const icons = sources
      .slice(0, 8)
      .map((s) => {
        const src = sourceIconUrl(s);
        if (!src) {
          return "";
        }
        const title = escapeHtml(s.site_name || s.title || s.url);
        return `<img class="thinking-favicon" src="${escapeHtml(src)}" alt="" title="${title}" loading="lazy" referrerpolicy="no-referrer" />`;
      })
      .join("");
    return `<div class="thinking-tool" data-kind="search">
      <span class="thinking-tool-icon" aria-hidden="true">⌕</span>
      <span class="thinking-tool-label">${escapeHtml(label)}</span>
      <span class="thinking-tool-favicons">${icons}</span>
    </div>`;
  }

  if (
    actionType === "open_page" ||
    actionType === "read_link" ||
    actionType === "find_in_page" ||
    call.kind === "read_link"
  ) {
    const pageUrl = call.page?.url || call.action?.url || "";
    const title = call.page?.title || pageUrl;
    const host = (() => {
      try {
        return pageUrl ? new URL(pageUrl).hostname : "";
      } catch {
        return "";
      }
    })();
    const label =
      call.status === "failed"
        ? "浏览失败"
        : call.status === "completed"
          ? "浏览页面"
          : "正在浏览…";
    const detail = title || host;
    return `<div class="thinking-tool" data-kind="browse">
      <span class="thinking-tool-icon" aria-hidden="true">▦</span>
      <span class="thinking-tool-label">${escapeHtml(label)}</span>
      ${
        detail
          ? `<a class="thinking-tool-link" href="${escapeHtml(pageUrl || "#")}" target="_blank" rel="noopener noreferrer">${escapeHtml(detail)}</a>`
          : ""
      }
    </div>`;
  }

  return `<div class="thinking-tool" data-kind="other">
    <span class="thinking-tool-icon" aria-hidden="true">⚙</span>
    <span class="thinking-tool-label">${escapeHtml(call.kind || call.type || "工具调用")}</span>
  </div>`;
}

/**
 * Builds an interleaved timeline: step reasoning text then that step's tool calls.
 * Falls back to a single text block + flat live/final calls when step text is missing.
 */
function buildThinkingBodyHtml(
  reasoningContent: string,
  steps?: ServerToolStep[],
  liveCalls?: ServerToolCall[],
): string {
  const parts: string[] = [];

  if (steps?.length) {
    const anyStepText = steps.some((s) => (s.reasoning_content ?? "").trim());
    if (anyStepText) {
      for (const step of steps) {
        const text = (step.reasoning_content ?? "").trim();
        if (text) {
          parts.push(`<div class="thinking-text">${renderLatexHtml(text)}</div>`);
        }
        for (const call of step.calls ?? []) {
          parts.push(renderToolCall(call));
        }
      }
    } else {
      if (reasoningContent.trim()) {
        parts.push(`<div class="thinking-text">${renderLatexHtml(reasoningContent)}</div>`);
      }
      for (const call of flattenToolCalls(steps)) {
        parts.push(renderToolCall(call));
      }
    }
    return parts.join("");
  }

  if (reasoningContent.trim()) {
    parts.push(`<div class="thinking-text">${renderLatexHtml(reasoningContent)}</div>`);
  }
  for (const call of liveCalls ?? []) {
    parts.push(renderToolCall(call));
  }
  return parts.join("");
}

/** Renders the full DeepSeek-style thinking chain block (details/summary). */
export function renderThinkingBlock(input: ThinkingRenderInput): string {
  const reasoning = input.reasoningContent?.trim() ?? "";
  const hasTools =
    (input.serverToolCalls?.some((s) => s.calls?.length) ?? false) ||
    (input.liveCalls?.length ?? 0) > 0;
  if (!reasoning && !hasTools) {
    return "";
  }

  const expanded =
    input.expanded ?? (input.streaming ? true : true);
  const label = thinkingSummaryLabel(
    input.reasoningStartedAt,
    input.reasoningEndedAt,
    input.streaming,
  );
  const body = buildThinkingBodyHtml(
    reasoning,
    input.serverToolCalls,
    input.liveCalls,
  );

  return `<details class="thinking" data-role="thinking" ${expanded ? "open" : ""}>
    <summary class="thinking-summary">
      ${thinkingAtomIcon()}
      <span class="thinking-summary-label">${escapeHtml(label)}</span>
      ${chevronIcon()}
    </summary>
    <div class="thinking-body">${body}</div>
  </details>`;
}

/**
 * Renders assistant content with KaTeX math and citation anchors
 * (Unicode code-point indices from DeepSeek url_citation annotations).
 * Pass serverToolCalls so hover cards can reuse search source meta.
 */
export function renderAnnotatedContent(
  content: string,
  annotations?: ContentAnnotation[],
  serverToolCalls?: ServerToolStep[],
): string {
  const sources = flattenToolCalls(serverToolCalls).flatMap((c) => c.sources ?? []);
  return renderMessageHtml(content, annotations, sources);
}

/** Flattens server tool steps into a call list for live merging. */
export function flattenToolCalls(steps?: ServerToolStep[]): ServerToolCall[] {
  if (!steps?.length) {
    return [];
  }
  return steps.flatMap((s) => s.calls ?? []);
}

/** Upserts a live tool call by id (streaming call_started / call_completed). */
export function upsertLiveCall(calls: ServerToolCall[], next: ServerToolCall): ServerToolCall[] {
  const idx = calls.findIndex((c) => c.id === next.id);
  if (idx === -1) {
    return [...calls, next];
  }
  const copy = calls.slice();
  copy[idx] = { ...copy[idx], ...next };
  return copy;
}
