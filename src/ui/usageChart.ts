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

/** Renders an SVG bar chart for estimated cost buckets (local ledger). */
export function renderUsageBarChart(aggregate: UsageAggregate): string {
  const width = 640;
  const height = 200;
  const padL = 40;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const values = aggregate.buckets.map((b) => b.costCny);
  const max = Math.max(...values, 0.0001);
  const n = aggregate.buckets.length || 1;
  const gap = n > 20 ? 1 : 2;
  const barW = Math.max(2, (innerW - gap * (n - 1)) / n);

  const bars = aggregate.buckets
    .map((bucket, i) => {
      const h = Math.max(0, (bucket.costCny / max) * innerH);
      const x = padL + i * (barW + gap);
      const y = padT + innerH - h;
      return `<rect class="usage-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="0">
        <title>${escapeHtml(bucket.label)} · ${formatCny(bucket.costCny)} · ${bucket.requests} 次</title>
      </rect>`;
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
      const x = padL + i * (barW + gap) + barW / 2;
      return `<text class="usage-axis-label" x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle">${escapeHtml(bucket.label)}</text>`;
    })
    .join("");

  const yLabels = [0, max / 2, max]
    .map((v, i) => {
      const y = padT + innerH - (v / max) * innerH;
      return `<text class="usage-axis-label" x="${padL - 6}" y="${y + 3}" text-anchor="end">${escapeHtml(formatCny(v))}</text>
        <line class="usage-grid" x1="${padL}" x2="${width - padR}" y1="${y}" y2="${y}" />`;
    })
    .join("");

  return `<svg class="usage-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="本机估算消费柱状图">${yLabels}${bars}${labels}</svg>`;
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
