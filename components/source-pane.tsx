import { promises as fs } from "node:fs";
import path from "node:path";

import { highlight } from "@/lib/shiki";

interface SourcePaneProps {
  files: Array<{ label: string; path: string; lang: "typescript" | "tsx" }>;
}

/**
 * Server component that reads source files from disk at request time and
 * renders them syntax-highlighted via shiki. No client JS.
 *
 * The source-on-disk-is-source-displayed invariant (D-004) means the code
 * shown next to a demo can never drift from what the demo actually runs.
 */
export async function SourcePane({ files }: SourcePaneProps) {
  const sections = await Promise.all(
    files.map(async (f) => {
      const abs = path.join(process.cwd(), f.path);
      const src = await fs.readFile(abs, "utf8");
      const html = await highlight(src, f.lang);
      return { ...f, html };
    }),
  );

  return (
    <div className="space-y-6">
      {sections.map((s) => (
        <div key={s.path}>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-medium text-[var(--foreground)]">{s.label}</h3>
            <code className="text-xs text-[var(--muted)]">{s.path}</code>
          </div>
          <div dangerouslySetInnerHTML={{ __html: s.html }} />
        </div>
      ))}
    </div>
  );
}
