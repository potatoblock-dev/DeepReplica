/** Favicon URL for a citation: prefer API site_icon, else Google s2 by host. */
export function citationIconUrl(url: string, siteIcon?: string): string {
  if (siteIcon) {
    return siteIcon;
  }
  try {
    const host = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
  } catch {
    return "";
  }
}

/** Hostname used as fallback site label when site_name is missing. */
export function citationHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Formats published_at for the popover meta row; empty if unusable. */
export function formatCitationDate(raw?: string | null): string {
  if (!raw) {
    return "";
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const asDate = new Date(trimmed);
  if (!Number.isNaN(asDate.getTime())) {
    const y = asDate.getFullYear();
    const m = String(asDate.getMonth() + 1).padStart(2, "0");
    const d = String(asDate.getDate()).padStart(2, "0");
    return `${y}/${m}/${d}`;
  }
  // Already a short display string from the API.
  if (trimmed.length <= 16) {
    return trimmed;
  }
  return trimmed.slice(0, 16);
}

type PopoverState = {
  tip: HTMLDivElement | null;
  hideTimer: number | null;
  activeLink: HTMLAnchorElement | null;
};

const HIDE_MS = 160;
const GAP = 8;

/** Escapes text for safe HTML body / attribute insertion in the popover. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Builds popover inner HTML from data-* on a citation link. */
function popoverHtml(link: HTMLAnchorElement): string {
  const url = link.href;
  const title = link.dataset.citeTitle || link.textContent || url;
  const site = link.dataset.citeSite || citationHost(url);
  const icon = link.dataset.citeIcon || citationIconUrl(url);
  const snippet = link.dataset.citeSnippet || "";
  const date = formatCitationDate(link.dataset.citeDate || "");

  const iconHtml = icon
    ? `<img class="citation-popover-icon" src="${escapeHtml(icon)}" alt="" width="16" height="16" loading="lazy" referrerpolicy="no-referrer" />`
    : `<span class="citation-popover-icon citation-popover-icon-fallback" aria-hidden="true"></span>`;

  const metaParts = [`<span class="citation-popover-site">${escapeHtml(site)}</span>`];
  if (date) {
    metaParts.push(`<span class="citation-popover-sep" aria-hidden="true">|</span>`);
    metaParts.push(`<span class="citation-popover-date">${escapeHtml(date)}</span>`);
  }

  const snippetHtml = snippet
    ? `<p class="citation-popover-snippet">${escapeHtml(snippet)}</p>`
    : "";

  return `<a class="citation-popover-card" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
    <div class="citation-popover-meta">${iconHtml}${metaParts.join("")}</div>
    <div class="citation-popover-title">${escapeHtml(title)}</div>
    ${snippetHtml}
  </a>`;
}

/** Positions the fixed tip above the link, flipping below if needed. */
function placeTip(tip: HTMLDivElement, link: HTMLAnchorElement): void {
  const rect = link.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(12, Math.min(left, vw - tipRect.width - 12));

  let top = rect.top - tipRect.height - GAP;
  if (top < 8) {
    top = rect.bottom + GAP;
  }
  if (top + tipRect.height > vh - 8) {
    top = Math.max(8, vh - tipRect.height - 8);
  }

  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

/**
 * Installs once-per-root hover handlers that show a fixed citation card
 * (avoids clipping by .messages overflow). Safe to call after every render.
 */
export function ensureCitationPopover(root: HTMLElement): void {
  if (root.dataset.citePopover === "1") {
    return;
  }
  root.dataset.citePopover = "1";

  const state: PopoverState = { tip: null, hideTimer: null, activeLink: null };

  /** Clears a pending hide timer. */
  function cancelHide(): void {
    if (state.hideTimer !== null) {
      window.clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
  }

  /** Removes the popover from the document. */
  function hideNow(): void {
    cancelHide();
    state.activeLink = null;
    if (state.tip) {
      state.tip.remove();
      state.tip = null;
    }
  }

  /** Schedules hide so the pointer can move onto the card. */
  function scheduleHide(): void {
    cancelHide();
    state.hideTimer = window.setTimeout(() => {
      hideNow();
    }, HIDE_MS);
  }

  /** Creates or refreshes the popover for a citation link. */
  function showFor(link: HTMLAnchorElement): void {
    cancelHide();
    if (state.activeLink === link && state.tip) {
      placeTip(state.tip, link);
      return;
    }
    hideNow();
    state.activeLink = link;
    const tip = document.createElement("div");
    tip.className = "citation-popover";
    tip.setAttribute("role", "tooltip");
    tip.innerHTML = popoverHtml(link);
    tip.addEventListener("mouseenter", () => {
      cancelHide();
    });
    tip.addEventListener("mouseleave", () => {
      scheduleHide();
    });
    document.body.appendChild(tip);
    state.tip = tip;
    placeTip(tip, link);
  }

  root.addEventListener(
    "pointerover",
    (event) => {
      const link = (event.target as HTMLElement | null)?.closest?.("a.citation-link");
      if (!link || !root.contains(link)) {
        return;
      }
      showFor(link as HTMLAnchorElement);
    },
    true,
  );

  root.addEventListener(
    "pointerout",
    (event) => {
      const link = (event.target as HTMLElement | null)?.closest?.("a.citation-link");
      if (!link || !root.contains(link)) {
        return;
      }
      const related = event.relatedTarget as Node | null;
      if (related && (link.contains(related) || state.tip?.contains(related))) {
        return;
      }
      scheduleHide();
    },
    true,
  );

  window.addEventListener(
    "scroll",
    () => {
      if (!state.tip || !state.activeLink) {
        return;
      }
      if (!state.activeLink.isConnected) {
        hideNow();
        return;
      }
      placeTip(state.tip, state.activeLink);
    },
    true,
  );

  window.addEventListener("resize", () => {
    hideNow();
  });
}
