import type { UsageAggregate, UsageRange } from "../store/usageLedger";

/** Escapes text for safe HTML insertion in chart markup. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Formats a CNY amount with up to 4 decimal places for small estimates. */
export function formatCny(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) {
    return "¥0";
  }
  if (amount < 0.01) {
    return `¥${amount.toFixed(4)}`;
  }
  return `¥${amount.toFixed(2)}`;
}

/** Formats a token count with grouping separators. */
export function formatTokens(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString("zh-CN");
}

/**
 * Builds an SVG path for a bar with only the top corners rounded
 * (DeepSeek open-platform chart style).
 */
function roundedTopBarPath(x: number, y: number, w: number, h: number, radius: number): string {
  if (h <= 0 || w <= 0) {
    return "";
  }
  const r = Math.min(radius, w / 2, h);
  if (r < 0.5) {
    return `M${x.toFixed(1)} ${(y + h).toFixed(1)}H${(x + w).toFixed(1)}V${y.toFixed(1)}H${x.toFixed(1)}Z`;
  }
  const x2 = x + w;
  const y2 = y + h;
  return [
    `M${x.toFixed(1)} ${y2.toFixed(1)}`,
    `H${x2.toFixed(1)}`,
    `V${(y + r).toFixed(1)}`,
    `Q${x2.toFixed(1)} ${y.toFixed(1)} ${(x2 - r).toFixed(1)} ${y.toFixed(1)}`,
    `H${(x + r).toFixed(1)}`,
    `Q${x.toFixed(1)} ${y.toFixed(1)} ${x.toFixed(1)} ${(y + r).toFixed(1)}`,
    "Z",
  ].join("");
}

/** Formats a Y-axis tick like the open platform (compact, no noisy decimals). */
function formatAxisTick(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) {
    return "0";
  }
  if (amount < 0.01) {
    return amount.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (amount < 1) {
    return amount.toFixed(2);
  }
  return amount % 1 === 0 ? String(Math.round(amount)) : amount.toFixed(1);
}

/** Renders an SVG bar chart for estimated cost buckets (local ledger). */
export function renderUsageBarChart(aggregate: UsageAggregate): string {
  const width = 640;
  const height = 228;
  const padL = 44;
  const padR = 16;
  const padT = 16;
  const padB = 32;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const values = aggregate.buckets.map((b) => b.costCny);
  const max = Math.max(...values, 0.0001);
  const n = aggregate.buckets.length || 1;
  // Open-platform look: wider slots with visible gaps between bars.
  const slot = innerW / n;
  const gapRatio = n <= 8 ? 0.42 : n <= 14 ? 0.34 : 0.26;
  const gap = Math.max(3, slot * gapRatio);
  const barW = Math.max(4, slot - gap);
  const cornerR = Math.min(6, barW / 2);

  const bars = aggregate.buckets
    .map((bucket, i) => {
      const h = Math.max(0, (bucket.costCny / max) * innerH);
      const x = padL + i * slot + (slot - barW) / 2;
      const y = padT + innerH - h;
      const tip = `${bucket.label} · ${formatCny(bucket.costCny)} · ${bucket.requests} 次`;
      const path = roundedTopBarPath(x, y, barW, h, cornerR);
      const barShape = path
        ? `<path class="usage-bar" d="${path}" pointer-events="none" />`
        : "";
      return `<g class="usage-bar-group" data-bucket-label="${escapeHtml(bucket.label)}" data-bucket-cost="${escapeHtml(formatCny(bucket.costCny))}" data-bucket-requests="${bucket.requests}" data-bucket-tip="${escapeHtml(tip)}">
        <rect class="usage-bar-hit" x="${(padL + i * slot).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${innerH}" />
        ${barShape}
      </g>`;
    })
    .join("");

  const labelIndexes =
    aggregate.range === "today"
      ? [0, 8, 15, 23].filter((i) => i < n)
      : [0, Math.floor((n - 1) / 2), n - 1].filter((i, idx, arr) => arr.indexOf(i) === idx);

  const labels = labelIndexes
    .map((i) => {
      const bucket = aggregate.buckets[i];
      if (!bucket) {
        return "";
      }
      const x = padL + i * slot + slot / 2;
      return `<text class="usage-axis-label" x="${x.toFixed(1)}" y="${height - 10}" text-anchor="middle">${escapeHtml(bucket.label)}</text>`;
    })
    .join("");

  const yLabels = [0, max / 2, max]
    .map((v) => {
      const y = padT + innerH - (v / max) * innerH;
      return `<text class="usage-axis-label" x="${padL - 8}" y="${y + 4}" text-anchor="end">${escapeHtml(formatAxisTick(v))}</text>
        <line class="usage-grid" x1="${padL}" x2="${width - padR}" y1="${y}" y2="${y}" />`;
    })
    .join("");

  const baseline = `<line class="usage-axis-baseline" x1="${padL}" x2="${width - padR}" y1="${padT + innerH}" y2="${padT + innerH}" />`;

  return `<svg class="usage-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="本机估算消费柱状图">${yLabels}${baseline}${bars}${labels}</svg>`;
}

type ChartTipState = {
  tip: HTMLDivElement | null;
  hideTimer: number | null;
  activeGroup: SVGGElement | null;
  /** Last pointer type that opened the tip (touch stays until outside tap). */
  stickyTouch: boolean;
};

const CHART_TIP_HIDE_MS = 140;

/** Positions the floating tip above a bar group, clamped to the viewport. */
function placeUsageTip(tip: HTMLDivElement, group: SVGGElement, clientX?: number): void {
  const hit = group.querySelector(".usage-bar-hit") as SVGRectElement | null;
  const anchor = hit ?? group;
  const rect = anchor.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left =
    typeof clientX === "number"
      ? clientX - tipRect.width / 2
      : rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(8, Math.min(left, vw - tipRect.width - 8));

  let top = rect.top - tipRect.height - 8;
  if (top < 8) {
    top = rect.bottom + 8;
  }
  if (top + tipRect.height > vh - 8) {
    top = Math.max(8, vh - tipRect.height - 8);
  }

  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

/** Builds the floating tip body for one bucket. */
function usageTipHtml(group: SVGGElement): string {
  const label = group.dataset.bucketLabel || "";
  const cost = group.dataset.bucketCost || "¥0";
  const requests = group.dataset.bucketRequests || "0";
  return `<div class="usage-chart-tip-label">${escapeHtml(label)}</div>
    <div class="usage-chart-tip-cost">${escapeHtml(cost)}</div>
    <div class="usage-chart-tip-meta">${escapeHtml(requests)} 次请求</div>`;
}

/**
 * Installs once-per-root handlers so chart bars show a floating data tip
 * on hover, press, and tap (works when SVG &lt;title&gt; is ignored on touch).
 */
export function ensureUsageChartTooltip(root: HTMLElement): void {
  if (root.dataset.usageChartTip === "1") {
    return;
  }
  root.dataset.usageChartTip = "1";

  const state: ChartTipState = {
    tip: null,
    hideTimer: null,
    activeGroup: null,
    stickyTouch: false,
  };

  /** Cancels a pending hide. */
  function cancelHide(): void {
    if (state.hideTimer !== null) {
      window.clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
  }

  /** Removes the tip from the document. */
  function hideNow(): void {
    cancelHide();
    state.activeGroup = null;
    state.stickyTouch = false;
    root.querySelectorAll(".usage-bar-group.is-active").forEach((el) => {
      el.classList.remove("is-active");
    });
    if (state.tip) {
      state.tip.remove();
      state.tip = null;
    }
  }

  /** Schedules hide so the pointer can leave briefly. */
  function scheduleHide(): void {
    if (state.stickyTouch) {
      return;
    }
    cancelHide();
    state.hideTimer = window.setTimeout(() => {
      hideNow();
    }, CHART_TIP_HIDE_MS);
  }

  /** Shows or refreshes the tip for a bar group. */
  function showFor(group: SVGGElement, clientX?: number, stickyTouch = false): void {
    cancelHide();
    root.querySelectorAll(".usage-bar-group.is-active").forEach((el) => {
      if (el !== group) {
        el.classList.remove("is-active");
      }
    });
    group.classList.add("is-active");
    state.activeGroup = group;
    state.stickyTouch = stickyTouch;

    if (!state.tip) {
      const tip = document.createElement("div");
      tip.className = "usage-chart-tip";
      tip.setAttribute("role", "tooltip");
      document.body.appendChild(tip);
      state.tip = tip;
    }
    state.tip.innerHTML = usageTipHtml(group);
    placeUsageTip(state.tip, group, clientX);
  }

  root.addEventListener(
    "pointerover",
    (event) => {
      const group = (event.target as Element | null)?.closest?.(
        ".usage-bar-group",
      ) as SVGGElement | null;
      if (!group || !root.contains(group)) {
        return;
      }
      if (event.pointerType === "touch") {
        return;
      }
      showFor(group, event.clientX, false);
    },
    true,
  );

  root.addEventListener(
    "pointerout",
    (event) => {
      const group = (event.target as Element | null)?.closest?.(
        ".usage-bar-group",
      ) as SVGGElement | null;
      if (!group || !root.contains(group)) {
        return;
      }
      if (event.pointerType === "touch") {
        return;
      }
      const related = event.relatedTarget as Node | null;
      if (related && group.contains(related)) {
        return;
      }
      scheduleHide();
    },
    true,
  );

  root.addEventListener(
    "pointerdown",
    (event) => {
      const group = (event.target as Element | null)?.closest?.(
        ".usage-bar-group",
      ) as SVGGElement | null;
      if (!group || !root.contains(group)) {
        if (state.stickyTouch) {
          hideNow();
        }
        return;
      }
      const touch = event.pointerType === "touch" || event.pointerType === "pen";
      if (touch && state.activeGroup === group && state.tip) {
        hideNow();
        return;
      }
      showFor(group, event.clientX, touch);
    },
    true,
  );

  window.addEventListener(
    "scroll",
    () => {
      if (state.tip && state.activeGroup?.isConnected) {
        placeUsageTip(state.tip, state.activeGroup);
      } else if (state.tip) {
        hideNow();
      }
    },
    true,
  );

  window.addEventListener("resize", () => {
    hideNow();
  });
}

/** Builds a single list-style select for 今天 / 7天内 / 30天内. */
export function renderUsageRangeSwitch(active: UsageRange): string {
  const items: Array<{ id: UsageRange; label: string }> = [
    { id: "today", label: "今天" },
    { id: "7d", label: "7天内" },
    { id: "30d", label: "30天内" },
  ];
  return `<label class="usage-range-field">
    <span class="usage-range-label">时间范围</span>
    <select class="usage-range-select" data-role="usage-range" aria-label="时间范围">
      ${items
        .map(
          (item) =>
            `<option value="${item.id}" ${active === item.id ? "selected" : ""}>${item.label}</option>`,
        )
        .join("")}
    </select>
  </label>`;
}
