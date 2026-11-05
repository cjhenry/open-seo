/**
 * Markdown an agent can paste into Cursor or Claude to fix one audit finding.
 * The sections match the evidence get_audit_issues already gives an agent:
 * the page, the finding, its severity, the suggested change, and the
 * observed evidence.
 */

type AuditFixEvidence = {
  label: string;
  value: string;
};

type AuditFixPage = {
  url: string;
  evidence?: AuditFixEvidence[];
};

const PAGE_LIMIT = 8;
const VALUE_LIMIT = 500;

function buildAuditFixPrompt(input: {
  title: string;
  issueType?: string | null;
  severity?: string | null;
  category?: string | null;
  description?: string | null;
  suggestedChange?: string | null;
  pages: AuditFixPage[];
  omittedPageCount?: number;
}): string {
  const lines = [
    "# Fix this OpenSEO audit finding",
    "",
    "Fix this finding on the page below. Use the evidence and the suggested change. Do not re-audit the site unless the evidence is missing something you have to see in the code.",
    "",
    "## Finding",
    `- Title: ${oneLine(input.title) || "Audit finding"}`,
  ];
  if (input.issueType?.trim())
    lines.push(`- Type: ${oneLine(input.issueType)}`);
  if (input.severity?.trim())
    lines.push(`- Severity: ${oneLine(input.severity)}`);
  if (input.category?.trim())
    lines.push(`- Category: ${oneLine(input.category)}`);

  const description = input.description?.trim();
  if (description) {
    lines.push("", "## What is wrong", "", description);
  }
  const suggested = input.suggestedChange?.trim();
  if (suggested) {
    lines.push("", "## Suggested change", "", suggested);
  }

  const pages =
    input.pages.length > 0
      ? input.pages
      : [{ url: "(URL not recorded)", evidence: [] }];
  lines.push("", pages.length === 1 ? "## Page" : "## Affected pages", "");
  for (const page of pages) {
    lines.push(`- URL: ${page.url.trim() || "(URL not recorded)"}`);
    for (const item of page.evidence ?? []) {
      const value = collapse(item.value);
      if (!value) continue;
      lines.push(`  - ${oneLine(item.label) || "Evidence"}: ${value}`);
    }
  }
  const omitted = input.omittedPageCount ?? 0;
  if (omitted > 0) {
    lines.push(
      "",
      `…and ${omitted} more affected ${omitted === 1 ? "page" : "pages"} not listed here.`,
    );
  }
  lines.push(
    "",
    "## What to do",
    "",
    "- Change the page so this finding no longer applies.",
    "- Keep unrelated copy, layout, and tracking intact.",
    "- When you finish, name the file you changed and how to verify the finding is gone.",
    "",
  );
  return `${lines.join("\n").trim()}\n`;
}

function evidenceFromDetailsJson(
  detailsJson: string | null | undefined,
): AuditFixEvidence[] {
  if (!detailsJson) return [];
  try {
    const parsed: unknown = JSON.parse(detailsJson);
    return evidenceFromRecord(parsed);
  } catch {
    return [{ label: "Details", value: detailsJson }];
  }
}

export function siteAuditFixPrompt(input: {
  title: string;
  issueType: string;
  severity: string;
  explanation: string;
  howToFix: string;
  pages: Array<{ url: string; detailsJson: string | null }>;
}): string {
  const shown = input.pages.slice(0, PAGE_LIMIT);
  return buildAuditFixPrompt({
    title: input.title,
    issueType: input.issueType,
    severity: input.severity,
    description: input.explanation,
    suggestedChange: input.howToFix,
    pages: shown.map((page) => ({
      url: page.url,
      evidence: evidenceFromDetailsJson(page.detailsJson),
    })),
    omittedPageCount: Math.max(0, input.pages.length - shown.length),
  });
}

export function lighthouseFixPrompt(input: {
  pageUrl: string;
  title: string;
  description: string | null;
  severity: string;
  category: string;
  auditKey: string;
  displayValue: string | null;
  score: number | null;
  impactMs: number | null;
  impactBytes: number | null;
  items: string[];
}): string {
  const evidence: AuditFixEvidence[] = [];
  if (input.displayValue) {
    evidence.push({ label: "Metric", value: input.displayValue });
  }
  if (input.score != null) {
    evidence.push({ label: "Score", value: String(input.score) });
  }
  if (input.impactMs != null) {
    evidence.push({
      label: "Estimated time savings (ms)",
      value: String(input.impactMs),
    });
  }
  if (input.impactBytes != null) {
    evidence.push({
      label: "Estimated byte savings",
      value: String(input.impactBytes),
    });
  }
  input.items.forEach((item, index) => {
    evidence.push(...evidenceFromLighthouseItem(item, index));
  });
  return buildAuditFixPrompt({
    title: input.title,
    issueType: input.auditKey,
    severity: input.severity,
    category: input.category,
    description: input.displayValue
      ? `${input.title}. ${input.displayValue}`
      : input.title,
    suggestedChange: input.description,
    pages: [
      {
        url: input.pageUrl.trim() || "(URL not recorded)",
        evidence,
      },
    ],
  });
}

export function auditFixFilename(issueType: string, pageUrl?: string): string {
  const parts = [slug(issueType)];
  if (pageUrl) {
    try {
      const name = new URL(pageUrl).pathname.split("/").filter(Boolean).pop();
      if (name) parts.push(slug(name));
    } catch {
      // A relative or empty URL still downloads under the issue type.
    }
  }
  const stem = parts.filter(Boolean).join("-").slice(0, 80);
  return `audit-fix-${stem || "finding"}.md`;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evidenceFromRecord(value: unknown): AuditFixEvidence[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value)
    .filter(([, entry]) => entry !== null && entry !== undefined)
    .map(([key, entry]) => ({
      label: key,
      value: Array.isArray(entry)
        ? entry.map(stringifyEvidence).join(" → ")
        : stringifyEvidence(entry),
    }));
}

function evidenceFromLighthouseItem(
  raw: string,
  index: number,
): AuditFixEvidence[] {
  const prefix = `Item ${index + 1}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed)) {
    return [{ label: prefix, value: raw }];
  }
  const node = isRecord(parsed.node) ? parsed.node : null;
  const picks: Array<[string, unknown]> = [
    ["URL", parsed.url ?? parsed.source],
    ["Selector", parsed.selector ?? node?.selector],
    [
      "Snippet",
      parsed.snippet ?? node?.snippet ?? node?.nodeLabel ?? parsed.nodeLabel,
    ],
    ["Wasted ms", parsed.wastedMs],
    ["Wasted bytes", parsed.wastedBytes ?? parsed.totalBytes],
  ];
  const lines = picks
    .filter(([, entry]) => entry != null && entry !== "")
    .map(([label, entry]) => ({
      label: `${prefix} ${label}`,
      value: stringifyEvidence(entry),
    }));
  return lines.length > 0 ? lines : [{ label: prefix, value: raw }];
}

function stringifyEvidence(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function collapse(value: string): string {
  const flat = oneLine(value);
  if (flat.length <= VALUE_LIMIT) return flat;
  return `${flat.slice(0, VALUE_LIMIT)}…`;
}
