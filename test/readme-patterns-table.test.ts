import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const README_PATH = resolve(ROOT, "README.md");
const HOMEPAGE_PATH = resolve(ROOT, "app/page.tsx");

interface PatternRow {
  title: string;
  status: string;
  slug: string;
  issue: number | null;
}

function parseReadmePatternsTable(md: string): PatternRow[] {
  const lines = md.split("\n");
  const headerIdx = lines.findIndex((l) =>
    /^\|\s*Pattern\s*\|\s*Status\s*\|\s*Demo path\s*\|\s*Issue\s*\|/.test(l),
  );
  if (headerIdx < 0) {
    throw new Error(
      "README Patterns table header not found. Expected `| Pattern | Status | Demo path | Issue |`.",
    );
  }
  const rows: PatternRow[] = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length !== 4) {
      throw new Error(`README row has ${cells.length} cells, expected 4: "${line}"`);
    }
    const [title, status, demoCell, issueCell] = cells;
    const slugMatch = demoCell.match(/`([^`]+)`/);
    if (!slugMatch) throw new Error(`README row demo cell missing backticked slug: "${line}"`);
    const issueMatch = issueCell.match(/#(\d+)/);
    rows.push({
      title,
      status,
      slug: slugMatch[1],
      issue: issueMatch ? Number(issueMatch[1]) : null,
    });
  }
  if (rows.length === 0) {
    throw new Error("README Patterns table had a header but no rows.");
  }
  return rows;
}

interface HomepagePattern {
  title: string;
  slug: string;
  status: string;
  issue: number;
}

function parseHomepagePatterns(tsx: string): HomepagePattern[] {
  const arrStart = tsx.indexOf("const PATTERNS: Pattern[] = [");
  if (arrStart < 0) {
    throw new Error("app/page.tsx PATTERNS array not found.");
  }
  const arrEnd = tsx.indexOf("];", arrStart);
  if (arrEnd < 0) throw new Error("app/page.tsx PATTERNS array not terminated.");
  const body = tsx.slice(arrStart, arrEnd);
  const blocks = body.split("},").slice(0, -1);
  if (blocks.length === 0) {
    // Last entry may not have a trailing `},`
    const lastBraced = body.match(/\{[^{}]+\}/g) ?? [];
    return lastBraced.map(toPattern);
  }
  return blocks.map((b) => toPattern(b + "}"));

  function toPattern(block: string): HomepagePattern {
    const slug = matchOrThrow(block, /slug:\s*"([^"]+)"/, "slug");
    const title = matchOrThrow(block, /title:\s*"([^"]+)"/, "title");
    const status = matchOrThrow(block, /status:\s*"([^"]+)"/, "status");
    const issue = Number(matchOrThrow(block, /issue:\s*(\d+)/, "issue"));
    return { slug, title, status, issue };
  }

  function matchOrThrow(s: string, re: RegExp, field: string): string {
    const m = s.match(re);
    if (!m) throw new Error(`homepage PATTERNS entry missing ${field}: ${s}`);
    return m[1];
  }
}

describe("README Patterns table snapshot", () => {
  const readme = readFileSync(README_PATH, "utf8");
  const homepageSrc = readFileSync(HOMEPAGE_PATH, "utf8");
  const readmeRows = parseReadmePatternsTable(readme);
  const homepageRows = parseHomepagePatterns(homepageSrc);

  it("has the same row count as the homepage PATTERNS array", () => {
    expect(readmeRows.length).toBe(homepageRows.length);
  });

  it("each README row matches the homepage entry at the same slug", () => {
    for (const readmeRow of readmeRows) {
      const homeRow = homepageRows.find((h) => h.slug === readmeRow.slug);
      expect(homeRow, `homepage missing pattern with slug ${readmeRow.slug}`).toBeDefined();
      if (!homeRow) continue;
      expect(readmeRow.title.toLowerCase()).toBe(homeRow.title.toLowerCase());
      expect(readmeRow.status).toBe(homeRow.status);
      expect(readmeRow.issue).toBe(homeRow.issue);
    }
  });

  it("every README slug points to a real app/<slug>/page.tsx on disk", () => {
    for (const row of readmeRows) {
      const slugNoLead = row.slug.replace(/^\//, "");
      const pagePath = resolve(ROOT, "app", slugNoLead, "page.tsx");
      expect(existsSync(pagePath), `page file missing: ${pagePath}`).toBe(true);
    }
  });
});
