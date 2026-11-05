import { describe, expect, it } from "vitest";
import { lighthouseFixPrompt, siteAuditFixPrompt } from "./audit-fix-prompt";

describe("audit fix prompt", () => {
  it("packages the page, severity, suggested change, and evidence for one finding", () => {
    const prompt = siteAuditFixPrompt({
      title: "Missing title tag",
      issueType: "missing-title",
      severity: "critical",
      explanation: "This page has no <title> element.",
      howToFix: "Add a unique title that describes the page.",
      pages: [
        {
          url: "https://www.example.com/pricing",
          detailsJson: JSON.stringify({
            selector: "head",
            wordCount: 40,
          }),
        },
      ],
    });

    expect(prompt).toContain("## Page");
    expect(prompt).toContain("- URL: https://www.example.com/pricing");
    expect(prompt).toContain("- Severity: critical");
    expect(prompt).toContain("- Type: missing-title");
    expect(prompt).toContain("Add a unique title that describes the page.");
    expect(prompt).toContain("- selector: head");
    expect(prompt).toContain("- wordCount: 40");
  });

  it("lists a sample of affected pages and says how many were left out", () => {
    const prompt = siteAuditFixPrompt({
      title: "Missing meta description",
      issueType: "missing-meta-description",
      severity: "warning",
      explanation: "These pages have no meta description.",
      howToFix: "Write a unique meta description for each page.",
      pages: Array.from({ length: 10 }, (_, index) => ({
        url: `https://www.example.com/page-${index}`,
        detailsJson: null,
      })),
    });

    expect(prompt).toContain("https://www.example.com/page-0");
    expect(prompt).toContain("https://www.example.com/page-7");
    expect(prompt).not.toContain("https://www.example.com/page-8");
    expect(prompt).toContain("…and 2 more affected pages");
  });

  it("includes a Lighthouse selector and metric so an agent can change the element", () => {
    const prompt = lighthouseFixPrompt({
      pageUrl: "https://www.example.com/",
      title: "Buttons do not have an accessible name",
      description: "Give each button a visible label or an aria-label.",
      severity: "warning",
      category: "accessibility",
      auditKey: "button-name",
      displayValue: null,
      score: 0,
      impactMs: null,
      impactBytes: null,
      items: [
        JSON.stringify({
          node: { selector: "button.buy", snippet: "<button></button>" },
        }),
      ],
    });

    expect(prompt).toContain("- URL: https://www.example.com/");
    expect(prompt).toContain("- Severity: warning");
    expect(prompt).toContain("- Category: accessibility");
    expect(prompt).toContain(
      "Give each button a visible label or an aria-label.",
    );
    expect(prompt).toContain("Item 1 Selector: button.buy");
    expect(prompt).toContain("Item 1 Snippet: <button></button>");
    expect(prompt).toContain("- Score: 0");
  });
});
