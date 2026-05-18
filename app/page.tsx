import Link from "next/link";

interface Pattern {
  slug: string;
  title: string;
  description: string;
  status: "shipped" | "pending";
  issue: number;
}

const PATTERNS: Pattern[] = [
  {
    slug: "/streaming-text",
    title: "Streaming text",
    description:
      "Server-Sent Events from a route handler + client-side ReadableStream reader. The simplest end-to-end streaming pattern; the foundation everything below builds on.",
    status: "shipped",
    issue: 1,
  },
  {
    slug: "/tool-use",
    title: "Tool-use UI with interruption",
    description:
      "Render the tool call, the streaming JSON args, the result, and the resumed reasoning. End-to-end AbortController interrupt produces a clean transcript.",
    status: "shipped",
    issue: 2,
  },
  {
    slug: "/partial-json",
    title: "Partial JSON parsing",
    description:
      "Progressive rendering of a structured response as the model emits it. Dep-free incremental parser tolerates open strings, open arrays/objects, trailing commas, mid-token primitives.",
    status: "shipped",
    issue: 3,
  },
  {
    slug: "/optimistic-rollback",
    title: "Optimistic updates with rollback",
    description:
      "React 19 useOptimistic + a deterministic 50/50 decision oracle on the server. Successes commit, failures roll back with a rendered reason and a brief border flash — the rollback path is reproducible by construction so the UX is testable, not aspirational.",
    status: "shipped",
    issue: 4,
  },
  {
    slug: "/error-recovery",
    title: "Error recovery mid-stream",
    description:
      "Checkpoint protocol over SSE: server emits a checkpoint event every few tokens, client records the most-recent one, reconnects with it on drop. Accumulating text never resets; a brief 'resumed at token N' pill makes the recovery observable. Drop is deterministic so the recovery branch is reproducible.",
    status: "shipped",
    issue: 5,
  },
];

export default function HomePage() {
  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          Streaming AI patterns in Next.js 15
        </h1>
        <p className="max-w-2xl text-[var(--muted)]">
          Reference patterns for AI features in Next.js 15 + React 19. Each
          pattern lives on its own page; each page renders the live demo and
          the actual source code that powers it, side by side.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        {PATTERNS.map((p) => (
          <Card key={p.slug} pattern={p} />
        ))}
      </div>
    </div>
  );
}

function Card({ pattern }: { pattern: Pattern }) {
  const isShipped = pattern.status === "shipped";
  const cardClass = `block rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 transition ${
    isShipped ? "hover:border-[var(--accent)]" : "opacity-60"
  }`;

  const body = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-medium tracking-tight">{pattern.title}</h2>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
            isShipped
              ? "bg-[var(--accent)]/10 text-[var(--accent)]"
              : "bg-[var(--border)] text-[var(--muted)]"
          }`}
        >
          {isShipped ? "shipped" : pattern.issue > 0 ? `pending #${pattern.issue}` : "pending"}
        </span>
      </div>
      <p className="mt-2 text-sm text-[var(--muted)]">{pattern.description}</p>
    </>
  );

  if (isShipped) {
    return (
      <Link href={pattern.slug} className={cardClass}>
        {body}
      </Link>
    );
  }
  return <div className={cardClass}>{body}</div>;
}
