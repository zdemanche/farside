import type { Finding } from "@farside/scan-contracts";
import { blindSpots, type CoverageEntry } from "./coverage.js";
import {
  EXPORT_FORMAT,
  type ExportCostRow,
  type ExportEnvelope,
  type ExportIssueRow,
} from "./export.js";
import { buildHeadline, type Headline } from "./headline.js";
import type { StoredIssue } from "./issues.js";
import type { CostSnapshot } from "./cost.js";

export const REPORT_FILENAME = "report.html";

export const ISSUE_CATEGORIES = ["Waste", "Recovery", "Lifecycle", "Cost", "Other"] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

export type ReportClaim = {
  kind: "issue" | "figure" | "range";
  value: string;
};

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ESCAPE[char] ?? char);
}

export function issueCategory(checkId: string): IssueCategory {
  if (checkId.includes("-waste-")) {
    return "Waste";
  }
  if (checkId.includes("-resilience-")) {
    return "Recovery";
  }
  if (checkId.includes("-lifecycle-")) {
    return "Lifecycle";
  }
  if (checkId.includes("-cost-")) {
    return "Cost";
  }
  return "Other";
}

export function sumIssueSavings(rows: readonly ExportIssueRow[]): { min: string; max: string; currency: string } | null {
  const priced = rows.filter((row) => row.savings);
  if (priced.length === 0) {
    return null;
  }
  const currency = priced[0]?.savings?.currency ?? "USD";
  return {
    min: priced.reduce((sum, row) => sum + Number(row.savings?.min ?? 0), 0).toFixed(2),
    max: priced.reduce((sum, row) => sum + Number(row.savings?.max ?? 0), 0).toFixed(2),
    currency,
  };
}

export function latestCostAmount(rows: readonly ExportCostRow[]): ExportCostRow | null {
  const months = rows.filter((row) => !row.provisional);
  return months.at(-1) ?? rows.at(-1) ?? null;
}

export function extractReportClaims(html: string): ReportClaim[] {
  const claims: ReportClaim[] = [];
  for (const match of html.matchAll(/data-issue-id="([^"]+)"/g)) {
    claims.push({ kind: "issue", value: match[1] ?? "" });
  }
  for (const match of html.matchAll(/data-figure="([^"]+)" data-amount="([^"]+)"/g)) {
    claims.push({ kind: "figure", value: match[2] ?? "" });
  }
  for (const match of html.matchAll(/data-range-min="([^"]+)" data-range-max="([^"]+)"/g)) {
    claims.push({ kind: "range", value: `${match[1]}-${match[2]}` });
  }
  return claims;
}

export function unsourcedReportClaims(
  html: string,
  issues: ExportEnvelope,
  cost: ExportEnvelope,
): string[] {
  const issueRows = issues.rows as ExportIssueRow[];
  const costRows = cost.rows as ExportCostRow[];
  const issueIds = new Set(issueRows.map((row) => row.id));
  const amounts = new Set(costRows.map((row) => row.amount));
  const month = latestCostAmount(costRows);
  if (month) {
    amounts.add(month.amount);
  }
  const waste = sumIssueSavings(issueRows);
  const ranges = new Set(
    issueRows.flatMap((row) => (row.savings ? [`${row.savings.min}-${row.savings.max}`] : [])),
  );
  if (waste) {
    ranges.add(`${waste.min}-${waste.max}`);
  }
  return extractReportClaims(html).flatMap((claim) => {
    if (claim.kind === "issue" && !issueIds.has(claim.value)) {
      return [`issue ${claim.value} has no export row`];
    }
    if (claim.kind === "figure" && !amounts.has(claim.value)) {
      return [`figure ${claim.value} has no export row`];
    }
    if (claim.kind === "range" && !ranges.has(claim.value)) {
      return [`range ${claim.value} has no export row`];
    }
    return [];
  });
}

function money(min: string, max: string, currency: string): string {
  return `${currency} ${min}–${max}`;
}

export function renderConsultantReport(input: {
  headline: Headline;
  issues: readonly ExportIssueRow[];
  cost: readonly ExportCostRow[];
  findings: readonly Finding[];
  coverage: readonly CoverageEntry[];
}): string {
  const waste = sumIssueSavings(input.issues);
  const month = latestCostAmount(input.cost);
  const displayedMonth = month?.amount ?? null;
  const currency = month?.currency ?? waste?.currency ?? "USD";
  const grouped = Object.fromEntries(ISSUE_CATEGORIES.map((name) => [name, [] as ExportIssueRow[]])) as Record<
    IssueCategory,
    ExportIssueRow[]
  >;
  for (const issue of input.issues) {
    grouped[issueCategory(issue.checkId)].push(issue);
  }
  const undetermined = input.findings.filter((finding) => finding.result === "undetermined");
  const spots = blindSpots(input.coverage);
  const assessed = input.coverage.filter((entry) => entry.state === "assessed").length;
  const issueBlocks = ISSUE_CATEGORIES.flatMap((name) => {
    const rows = grouped[name];
    if (rows.length === 0) {
      return [];
    }
    const items = rows
      .map((issue) => {
        const savings = issue.savings
          ? `<span data-range-min="${escapeHtml(issue.savings.min)}" data-range-max="${escapeHtml(issue.savings.max)}">${escapeHtml(money(issue.savings.min, issue.savings.max, issue.savings.currency))}</span>`
          : "—";
        return `<tr data-issue-id="${escapeHtml(issue.id)}"><td>${escapeHtml(issue.id)}</td><td>${escapeHtml(issue.checkId)}</td><td>${escapeHtml(issue.status)}</td><td>${savings}</td></tr>`;
      })
      .join("");
    return [`<h3>${escapeHtml(name)}</h3><table><thead><tr><th>Issue</th><th>Check</th><th>Status</th><th>Savings</th></tr></thead><tbody>${items}</tbody></table>`];
  });
  const undeterminedItems = undetermined
    .map((finding) => {
      const closer = finding.closer ?? "A successful scan of this check on the scope.";
      return `<li><strong>${escapeHtml(finding.checkId)}</strong> — undetermined. ${escapeHtml(closer)}</li>`;
    })
    .join("");
  const spotItems = spots
    .map(
      (spot) =>
        `<li><strong>${escapeHtml(spot.checkId)}</strong> — ${escapeHtml(spot.state)}. ${escapeHtml(spot.reason)} ${escapeHtml(spot.closer)}</li>`,
    )
    .join("");
  const coverageItems = input.coverage
    .map(
      (entry) =>
        `<li>${escapeHtml(entry.checkId)} · ${escapeHtml(entry.subscriptionOrProject)} · ${escapeHtml(entry.state)}</li>`,
    )
    .join("");
  const wasteMarkup = waste
    ? `<p data-range-min="${escapeHtml(waste.min)}" data-range-max="${escapeHtml(waste.max)}">Nameable waste ${escapeHtml(money(waste.min, waste.max, waste.currency))}</p>`
    : "<p>Nameable waste is not assessed.</p>";
  const monthMarkup = displayedMonth
    ? `<p data-figure="monthlyCost" data-amount="${escapeHtml(displayedMonth)}">Monthly cost ${escapeHtml(currency)} ${escapeHtml(displayedMonth)}</p>`
    : "<p>Monthly cost is not assessed.</p>";
  return `<!DOCTYPE html>
<html lang="en" data-theme="moonaan">
<head>
<meta charset="utf-8">
<title>Farside report</title>
<style>
:root, :root[data-theme="moonaan"] {
  color-scheme: dark;
  --bg: #07080B;
  --panel: #0B0C10;
  --surface: #12141A;
  --ink: #E6E7EB;
  --muted: #A7ADBB;
  --faint: #6B7180;
  --indigo: #6A7CF7;
  --ever: #2EE6A8;
  --coral: #FF7A70;
  --amber: #F4C95D;
  --color-bg-canvas: var(--bg);
  --color-bg-raised: var(--surface);
  --color-text-primary: var(--ink);
  --color-text-secondary: var(--muted);
  --color-accent: var(--indigo);
  --color-proof: var(--ever);
  --color-alert: var(--coral);
  --color-hold: var(--amber);
  --color-border-subtle: #171A22;
}
:root[data-theme="daylight"] {
  color-scheme: light;
  --bg: #F4F5F8;
  --panel: #FFFFFF;
  --surface: #FFFFFF;
  --ink: #1A1D26;
  --muted: #4C5364;
  --faint: #8B92A3;
  --indigo: #4656D6;
  --ever: #0A9C6E;
  --coral: #D6483C;
  --amber: #8F6400;
  --color-bg-canvas: var(--bg);
  --color-bg-raised: var(--surface);
  --color-text-primary: var(--ink);
  --color-text-secondary: var(--muted);
  --color-accent: var(--indigo);
  --color-proof: var(--ever);
  --color-alert: var(--coral);
  --color-hold: var(--amber);
  --color-border-subtle: #E4E7EE;
}
html { background: var(--color-bg-canvas); color: var(--color-text-primary); font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0 auto; max-width: 52rem; padding: 2rem 1.25rem; }
h1, h2, h3 { color: var(--color-text-primary); }
p, li { color: var(--color-text-secondary); }
table { width: 100%; border-collapse: collapse; background: var(--color-bg-raised); }
th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--color-border-subtle); color: var(--color-text-primary); }
th { color: var(--color-text-secondary); font-weight: 600; }
.lede { color: var(--color-text-primary); }
@media print {
  :root {
    color-scheme: light;
    --bg: #F4F5F8;
    --panel: #FFFFFF;
    --surface: #FFFFFF;
    --ink: #1A1D26;
    --muted: #4C5364;
    --indigo: #4656D6;
    --ever: #0A9C6E;
    --coral: #D6483C;
    --amber: #8F6400;
    --color-bg-canvas: var(--bg);
    --color-bg-raised: var(--surface);
    --color-text-primary: var(--ink);
    --color-text-secondary: var(--muted);
    --color-accent: var(--indigo);
    --color-proof: var(--ever);
    --color-alert: var(--coral);
    --color-hold: var(--amber);
    --color-border-subtle: #E4E7EE;
  }
}
@media print and (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #07080B;
    --panel: #0B0C10;
    --surface: #12141A;
    --ink: #E6E7EB;
    --muted: #A7ADBB;
    --indigo: #6A7CF7;
    --ever: #2EE6A8;
    --coral: #FF7A70;
    --amber: #F4C95D;
    --color-bg-canvas: var(--bg);
    --color-bg-raised: var(--surface);
    --color-text-primary: var(--ink);
    --color-text-secondary: var(--muted);
    --color-accent: var(--indigo);
    --color-proof: var(--ever);
    --color-alert: var(--coral);
    --color-hold: var(--amber);
    --color-border-subtle: #171A22;
  }
}
</style>
</head>
<body>
<h1>Farside report</h1>
<p class="lede">${escapeHtml(input.headline.sentence)}</p>
<section>
<h2>Headline</h2>
${monthMarkup}
${wasteMarkup}
<p>Assessed coverage scopes: ${String(assessed)}</p>
</section>
<section>
<h2>Issues by category</h2>
${issueBlocks.join("") || "<p>No issues in the export.</p>"}
</section>
<section>
<h2>Undetermined</h2>
${undeterminedItems ? `<ul>${undeterminedItems}</ul>` : "<p>No undetermined results.</p>"}
</section>
<section>
<h2>Blind spots</h2>
${spotItems ? `<ul>${spotItems}</ul>` : "<p>No blind spots.</p>"}
</section>
<section>
<h2>Coverage</h2>
${coverageItems ? `<ul>${coverageItems}</ul>` : "<p>No coverage rows.</p>"}
</section>
</body>
</html>
`;
}

export function buildConsultantReport(input: {
  issues: readonly StoredIssue[];
  findings: readonly Finding[];
  coverage: readonly CoverageEntry[];
  cost: CostSnapshot | null;
  exportedIssues: ExportEnvelope;
  exportedCost: ExportEnvelope;
  now: string;
}): string {
  if (input.exportedIssues.format !== EXPORT_FORMAT || input.exportedCost.format !== EXPORT_FORMAT) {
    throw new Error("export format drifted");
  }
  return renderConsultantReport({
    headline: buildHeadline({
      cost: input.cost,
      findings: input.findings,
      coverage: input.coverage,
      now: input.now,
    }),
    issues: input.exportedIssues.rows as ExportIssueRow[],
    cost: input.exportedCost.rows as ExportCostRow[],
    findings: input.findings,
    coverage: input.coverage,
  });
}
