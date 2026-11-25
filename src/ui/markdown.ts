import markdownItKatex from "@traptitech/markdown-it-katex";
import hljs from "highlight.js";
import katex from "katex";
import MarkdownIt from "markdown-it";
import type { ContentAnnotation } from "../api/streamChat";

const CITE_OPEN = "\uE000";
const CITE_CLOSE = "\uE001";

type CitationSlot = {
  url: string;
  title: string;
  label: string;
};

/** Escapes text for safe HTML attribute / body insertion. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Encodes raw fence source for a copy button `data-code` attribute (UTF-8 → base64). */
function encodeCodeAttr(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Decodes a `data-code` attribute produced by `encodeCodeAttr`. */
export function decodeCodeAttr(encoded: string): string {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/** Wraps highlighted (or plain) fence HTML with a copy control. */
function wrapCodeBlock(preHtml: string, code: string): string {
  return `<div class="code-block"><button type="button" class="copy-btn" data-action="copy-code" data-code="${encodeCodeAttr(code)}" title="复制代码">复制</button>${preHtml}</div>`;
}

/** Highlights a fenced code block; mermaid fences become mountable diagram sources. */
function highlightFence(code: string, lang: string): string {
  const language = lang.trim().split(/\s+/)[0] ?? "";
  if (language.toLowerCase() === "mermaid") {
    return `<div class="mermaid-block" data-mermaid="1"><pre class="mermaid">${escapeHtml(code)}</pre></div>`;
  }
  if (language && hljs.getLanguage(language)) {
    try {
      const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
      return wrapCodeBlock(
        `<pre class="hljs"><code class="language-${escapeHtml(language)}">${html}</code></pre>`,
        code,
      );
    } catch {
      /* fall through */
    }
  }
  return wrapCodeBlock(`<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`, code);
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
  highlight: highlightFence,
});

md.use(markdownItKatex, {
  // Plugin ships older katex typings; cast keeps one runtime instance.
  katex: katex as never,
  throwOnError: false,
  strict: "ignore",
  output: "html",
  trust: false,
  blockClass: "math-block",
});

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  if (token.attrIndex("class") < 0) {
    token.attrJoin("class", "md-link");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/**
 * Replaces citation spans with private-use placeholders so Markdown parsing
 * does not shift Unicode code-point indices from the API.
 */
function injectCitationPlaceholders(
  content: string,
  annotations?: ContentAnnotation[],
): { text: string; slots: CitationSlot[] } {
  const cites = (annotations ?? [])
    .filter((a): a is Extract<ContentAnnotation, { type: "url_citation" }> => a.type === "url_citation")
    .map((a) => a.url_citation)
    .filter((c) => typeof c.start_index === "number" && typeof c.end_index === "number")
    .sort((a, b) => b.start_index - a.start_index);

  if (cites.length === 0) {
    return { text: content, slots: [] };
  }

  const chars = Array.from(content);
  const slots: CitationSlot[] = [];
  let working = chars;

  for (const cite of cites) {
    const start = Math.max(0, Math.min(working.length, cite.start_index));
    const end = Math.max(start, Math.min(working.length, cite.end_index));
    if (end <= start) {
      continue;
    }
    const label = working.slice(start, end).join("") || cite.title || cite.url;
    const slotIndex = slots.length;
    slots.push({
      url: cite.url,
      title: cite.title || cite.url,
      label,
    });
    const marker = `${CITE_OPEN}cite${slotIndex}${CITE_CLOSE}`;
    working = [...working.slice(0, start), ...Array.from(marker), ...working.slice(end)];
  }

  return { text: working.join(""), slots };
}

/** Turns citation placeholders back into anchor tags after Markdown render. */
function restoreCitationPlaceholders(html: string, slots: CitationSlot[]): string {
  if (slots.length === 0) {
    return html;
  }
  return html.replace(
    new RegExp(`${CITE_OPEN}cite(\\d+)${CITE_CLOSE}`, "g"),
    (_match, indexText: string) => {
      const index = Number(indexText);
      const slot = slots[index];
      if (!slot) {
        return "";
      }
      return `<a class="citation-link" href="${escapeHtml(slot.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(slot.title)}">${escapeHtml(slot.label)}</a>`;
    },
  );
}

/** Renders assistant / thinking content as Markdown HTML with KaTeX, hljs, and citations. */
export function renderMessageHtml(
  content: string,
  annotations?: ContentAnnotation[],
): string {
  if (!content) {
    return "";
  }
  const { text, slots } = injectCitationPlaceholders(content, annotations);
  const html = md.render(text);
  return restoreCitationPlaceholders(html, slots);
}

/** Alias for thinking-chain text that may include Markdown and LaTeX. */
export function renderLatexHtml(text: string): string {
  return renderMessageHtml(text);
}
