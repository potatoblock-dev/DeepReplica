import markdownItKatex from "@traptitech/markdown-it-katex";
import hljs from "highlight.js";
import katex from "katex";
import MarkdownIt from "markdown-it";
import type { ContentAnnotation, ServerToolSource } from "../api/streamChat";
import { citationHost, citationIconUrl, formatCitationDate } from "./citationPopover";

/** ASCII markers survive Markdown; avoid PUA (renders as ≡ when restore fails). */
const CITE_MARKER_RE = /%%DRCITE(\d+)%%/g;

type CitationSlot = {
  url: string;
  title: string;
  /** Display text inside the citation link, e.g. "[1]". */
  label: string;
  siteName: string;
  siteIcon: string;
  snippet: string;
  publishedAt: string;
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

/** Wraps highlighted (or plain) fence HTML with optional language label and a copy control. */
function wrapCodeBlock(preHtml: string, code: string, language = ""): string {
  const langLabel = language
    ? `<span class="code-lang" aria-label="语言">${escapeHtml(language)}</span>`
    : "";
  return `<div class="code-block">${langLabel}<button type="button" class="copy-btn" data-action="copy-code" data-code="${encodeCodeAttr(code)}" title="复制代码">复制</button>${preHtml}</div>`;
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
        language,
      );
    } catch {
      /* fall through */
    }
  }
  return wrapCodeBlock(`<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`, code, language);
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

/** Finds a search/browse source matching a citation URL for richer popover fields. */
function matchCitationSource(
  url: string,
  sources: ServerToolSource[],
): ServerToolSource | undefined {
  const exact = sources.find((s) => s.url === url);
  if (exact) {
    return exact;
  }
  return sources.find(
    (s) => Boolean(s.url) && (url.startsWith(s.url) || s.url.startsWith(url)),
  );
}

/** Truncates snippet text for the hover card body. */
function clipSnippet(text: string, max = 140): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) {
    return compact;
  }
  return `${compact.slice(0, max - 1)}…`;
}

/**
 * Inserts numbered citation markers at each annotation end_index (code points).
 * Insert-at-end keeps source text intact and avoids overlapping replaces that
 * used to corrupt PUA placeholders into visible "≡citeN≡".
 */
function injectCitationPlaceholders(
  content: string,
  annotations?: ContentAnnotation[],
  sources: ServerToolSource[] = [],
): { text: string; slots: CitationSlot[] } {
  const cites = (annotations ?? [])
    .filter((a): a is Extract<ContentAnnotation, { type: "url_citation" }> => a.type === "url_citation")
    .map((a) => a.url_citation)
    .filter(
      (c) =>
        typeof c.start_index === "number" &&
        typeof c.end_index === "number" &&
        c.end_index > c.start_index &&
        typeof c.url === "string" &&
        c.url.length > 0,
    );

  if (cites.length === 0) {
    return { text: content, slots: [] };
  }

  // Display order: first appearance in the answer → [1], [2], …
  const ordered = [...cites].sort(
    (a, b) => a.start_index - b.start_index || a.end_index - b.end_index,
  );

  const slots: CitationSlot[] = ordered.map((cite, index) => {
    const source = matchCitationSource(cite.url, sources);
    const title = cite.title || source?.title || cite.url;
    const siteName = source?.site_name || citationHost(cite.url);
    const siteIcon = citationIconUrl(cite.url, source?.site_icon);
    const snippet = source?.snippet ? clipSnippet(source.snippet) : "";
    const publishedAt = formatCitationDate(
      source?.published_at ?? undefined,
    );
    return {
      url: cite.url,
      title,
      label: `[${index + 1}]`,
      siteName,
      siteIcon,
      snippet,
      publishedAt,
    };
  });

  // Insert from the highest end_index so earlier offsets stay valid.
  // Same end → higher slot first so left-to-right reads [1][2][3].
  const inserts = ordered
    .map((cite, slotIndex) => ({ end: cite.end_index, slotIndex }))
    .sort((a, b) => b.end - a.end || b.slotIndex - a.slotIndex);

  let working = Array.from(content);
  for (const { end, slotIndex } of inserts) {
    const at = Math.max(0, Math.min(working.length, end));
    const marker = `%%DRCITE${slotIndex}%%`;
    working = [...working.slice(0, at), ...Array.from(marker), ...working.slice(at)];
  }

  return { text: working.join(""), slots };
}

/** Turns citation placeholders back into superscript anchors after Markdown render. */
function restoreCitationPlaceholders(html: string, slots: CitationSlot[]): string {
  if (slots.length === 0) {
    return html;
  }
  return html.replace(CITE_MARKER_RE, (_match, indexText: string) => {
    const index = Number(indexText);
    const slot = slots[index];
    if (!slot) {
      return "";
    }
    const attrs = [
      `class="citation-link"`,
      `href="${escapeHtml(slot.url)}"`,
      `target="_blank"`,
      `rel="noopener noreferrer"`,
      `data-cite-title="${escapeHtml(slot.title)}"`,
      `data-cite-site="${escapeHtml(slot.siteName)}"`,
      `data-cite-icon="${escapeHtml(slot.siteIcon)}"`,
    ];
    if (slot.snippet) {
      attrs.push(`data-cite-snippet="${escapeHtml(slot.snippet)}"`);
    }
    if (slot.publishedAt) {
      attrs.push(`data-cite-date="${escapeHtml(slot.publishedAt)}"`);
    }
    return `<sup class="citation"><a ${attrs.join(" ")}>${escapeHtml(slot.label)}</a></sup>`;
  });
}

/**
 * Converts LaTeX `\(...\)` / `\[...\]` delimiters to `$` / `$$` so
 * markdown-it-katex can render them. Skips fenced and inline code.
 */
function normalizeLatexDelimiters(content: string): string {
  const transform = (chunk: string): string =>
    chunk
      .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body: string) => `$$${body}$$`)
      .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => `$${body}$`);

  const parts: string[] = [];
  const codeRe = /(```[\s\S]*?```|`[^`\n]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = codeRe.exec(content)) !== null) {
    parts.push(transform(content.slice(last, match.index)));
    parts.push(match[0]);
    last = match.index + match[0].length;
  }
  parts.push(transform(content.slice(last)));
  return parts.join("");
}

/** Renders assistant / thinking content as Markdown HTML with KaTeX, hljs, and citations. */
export function renderMessageHtml(
  content: string,
  annotations?: ContentAnnotation[],
  sources?: ServerToolSource[],
): string {
  if (!content) {
    return "";
  }
  const { text, slots } = injectCitationPlaceholders(content, annotations, sources ?? []);
  const html = md.render(normalizeLatexDelimiters(text));
  return restoreCitationPlaceholders(html, slots);
}

/** Alias for thinking-chain text that may include Markdown and LaTeX. */
export function renderLatexHtml(text: string): string {
  return renderMessageHtml(text);
}
