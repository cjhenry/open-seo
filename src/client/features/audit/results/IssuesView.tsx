import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { sort } from "remeda";
import {
  getIssueDescriptor,
  ISSUE_SEVERITY_ORDER,
  type IssueSeverity,
} from "@/shared/audit-issues";
import type { AuditResultsData } from "@/client/features/audit/results/types";
import { SeverityBadge } from "@/client/features/audit/shared";
import { CopyAuditFixPrompt } from "@/client/features/audit/CopyAuditFixPrompt";
import { EmptyState } from "@/client/components/EmptyState";
import {
  auditFixFilename,
  siteAuditFixPrompt,
} from "@/shared/audit-fix-prompt";

type AuditIssueRow = AuditResultsData["issues"][number];

const MAX_RENDERED_URLS = 100;

const SEVERITY_RULE: Record<IssueSeverity, string> = {
  critical: "border-l-destructive/60",
  warning: "border-l-warning/60",
  info: "border-l-info/60",
};

const SEVERITY_LABEL: Record<IssueSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

interface IssueGroup {
  issueType: string;
  severity: IssueSeverity;
  title: string;
  explanation: string;
  howToFix: string;
  issues: AuditIssueRow[];
}

export function resolveIssueSeverity(issue: {
  issueType: string;
  severity: string;
}): IssueSeverity {
  const descriptor = getIssueDescriptor(issue.issueType);
  if (descriptor) return descriptor.severity;
  return issue.severity === "critical" || issue.severity === "warning"
    ? issue.severity
    : "info";
}

function groupIssues(issues: AuditIssueRow[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const issue of issues) {
    let group = groups.get(issue.issueType);
    if (!group) {
      const descriptor = getIssueDescriptor(issue.issueType);
      group = {
        issueType: issue.issueType,
        severity: resolveIssueSeverity(issue),
        title: descriptor?.title ?? issue.issueType,
        explanation: descriptor?.explanation ?? "",
        howToFix: descriptor?.howToFix ?? "",
        issues: [],
      };
      groups.set(issue.issueType, group);
    }
    group.issues.push(issue);
  }

  return sort(
    Array.from(groups.values()),
    (a, b) =>
      ISSUE_SEVERITY_ORDER[a.severity] - ISSUE_SEVERITY_ORDER[b.severity] ||
      b.issues.length - a.issues.length,
  );
}

export function IssuesView({
  issues,
  tabs,
}: {
  issues: AuditIssueRow[];
  tabs: ReactNode;
}) {
  const groups = useMemo(() => groupIssues(issues), [issues]);

  const sections = useMemo(
    () =>
      (["critical", "warning", "info"] as const)
        .map((severity) => ({
          severity,
          groups: groups.filter((group) => group.severity === severity),
        }))
        .filter((section) => section.groups.length > 0),
    [groups],
  );

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {tabs}
      {issues.length === 0 ? (
        <EmptyState
          variant="plain"
          title="No issues found."
          description="Every crawled page passed the issue checks."
        />
      ) : (
        <div>
          {sections.map((section) => (
            <IssueSection key={section.severity} section={section} />
          ))}
        </div>
      )}
    </div>
  );
}

function IssueSection({
  section,
}: {
  section: { severity: IssueSeverity; groups: IssueGroup[] };
}) {
  const issueCount = section.groups.reduce(
    (sum, group) => sum + group.issues.length,
    0,
  );

  return (
    <div className="border-t border-border first:border-t-0">
      <div className="flex items-center gap-2 bg-muted/50 px-4 py-1.5 border-b border-border">
        <SeverityBadge severity={section.severity}>
          {SEVERITY_LABEL[section.severity]}
          <span className="tabular-nums">{issueCount}</span>
        </SeverityBadge>
      </div>
      <div className="divide-y divide-border">
        {section.groups.map((group) => (
          <IssueRow key={group.issueType} group={group} />
        ))}
      </div>
    </div>
  );
}

function IssueRow({ group }: { group: IssueGroup }) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className={
        open
          ? `border-l-2 ${SEVERITY_RULE[group.severity]} bg-muted/30`
          : "border-l-2 border-l-transparent"
      }
    >
      <div className="flex items-center gap-2 px-4 py-2.5 hover:bg-muted/50">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {group.title}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {group.issues.length} {group.issues.length === 1 ? "page" : "pages"}
          </span>
          <ChevronRight
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${
              open ? "rotate-90" : ""
            }`}
          />
        </button>
        <CopyAuditFixPrompt
          prompt={groupPrompt(group)}
          filename={auditFixFilename(group.issueType)}
        />
      </div>

      {open && (
        <div className="pl-4 pr-4 pb-4 pt-0.5 space-y-3">
          {group.explanation && (
            <p className="text-sm text-muted-foreground max-w-prose">
              {group.explanation}
            </p>
          )}
          {group.howToFix && (
            <p className="text-sm max-w-prose">
              <span className="font-medium">How to fix: </span>
              <span className="text-foreground/80">{group.howToFix}</span>
            </p>
          )}
          <AffectedUrlList group={group} />
        </div>
      )}
    </div>
  );
}

function groupPrompt(group: IssueGroup): string {
  return siteAuditFixPrompt({
    title: group.title,
    issueType: group.issueType,
    severity: group.severity,
    explanation: group.explanation,
    howToFix: group.howToFix,
    pages: group.issues.map((issue) => ({
      url: issue.pageUrl,
      detailsJson: issue.detailsJson,
    })),
  });
}

function AffectedUrlList({ group }: { group: IssueGroup }) {
  const rendered = group.issues.slice(0, MAX_RENDERED_URLS);
  const remaining = group.issues.length - rendered.length;

  return (
    <div className="max-h-[320px] overflow-y-auto rounded border border-border bg-card">
      {rendered.map((issue) => (
        <div
          key={issue.id}
          className="flex items-start justify-between gap-2 border-b border-border px-3 py-1.5 text-sm last:border-b-0"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <a
              className="truncate text-foreground/80 hover:underline"
              href={issue.pageUrl}
              target="_blank"
              rel="noreferrer"
              title={issue.pageUrl}
            >
              {issue.pageUrl}
            </a>
            <IssueDetails detailsJson={issue.detailsJson} />
          </div>
          <CopyAuditFixPrompt
            prompt={siteAuditFixPrompt({
              title: group.title,
              issueType: group.issueType,
              severity: group.severity,
              explanation: group.explanation,
              howToFix: group.howToFix,
              pages: [{ url: issue.pageUrl, detailsJson: issue.detailsJson }],
            })}
            filename={auditFixFilename(group.issueType, issue.pageUrl)}
          />
        </div>
      ))}
      {remaining > 0 && (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          …and {remaining} more — export the issues CSV for the full list.
        </div>
      )}
    </div>
  );
}

// AuditRepository is the only writer and always stores JSON.stringify of a
// details object, so the parse cannot throw.
function parseDetails(detailsJson: string): Array<[string, unknown]> | null {
  const parsed: unknown = JSON.parse(detailsJson);
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return Object.entries(parsed);
  }
  return null;
}

function IssueDetails({ detailsJson }: { detailsJson: string | null }) {
  const details = useMemo(
    () => (detailsJson ? parseDetails(detailsJson) : null),
    [detailsJson],
  );

  if (!details) return null;

  const entries = details.filter(
    ([, value]) => value !== null && value !== undefined,
  );
  if (entries.length === 0) return null;

  return (
    <span className="text-xs text-muted-foreground truncate">
      {entries
        .map(([key, value]) => {
          const rendered = Array.isArray(value)
            ? value.join(" → ")
            : String(value);
          return `${key}: ${rendered}`;
        })
        .join(" · ")}
    </span>
  );
}
