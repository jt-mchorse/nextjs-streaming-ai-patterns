import { describe, it, expect } from "vitest";

import { MOCK_FIXTURE } from "@/lib/mock-stream";

// Every keyless visitor to /streaming-text watches MOCK_FIXTURE stream, right
// under the paragraph that says a route handler streams SSE and a Client
// Component appends each delta. The fixture used to describe the opposite: a
// zero-JS Server Components flush, which docs/architecture.md ("Why a route
// handler instead of pure RSC streaming") says React 19 + Next 15 do not
// provide (#234). The demo text is content the page shows, so it is held to
// the same claim the page and the architecture doc make.
const flat = MOCK_FIXTURE.replace(/\s+/g, " ");

describe("MOCK_FIXTURE describes the pattern the page implements (#234)", () => {
  it("does not claim the text renders without client-side JavaScript", () => {
    expect(flat).not.toMatch(/no client-side javascript/i);
  });

  it("does not credit Server Components with the per-token streaming", () => {
    expect(flat).not.toMatch(/server components? flush/i);
  });

  it("names both halves the architecture doc says are required", () => {
    expect(flat).toMatch(/route handler/i);
    expect(flat).toMatch(/client component/i);
  });
});
