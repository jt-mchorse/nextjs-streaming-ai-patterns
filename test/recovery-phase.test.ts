import { describe, expect, it } from "vitest";

import { phaseOnFirstChunk, type RecoveryPhase } from "../lib/recovery-phase";

describe("phaseOnFirstChunk", () => {
  it("advances a resuming run to streaming on the first chunk (#64)", () => {
    // The regression: a resume run starts in "recovering"; once tokens flow it
    // must show "streaming", not sit on the amber "recovering…" banner.
    expect(phaseOnFirstChunk("recovering")).toBe("streaming");
  });

  it("leaves every non-recovering phase untouched", () => {
    const unchanged: RecoveryPhase[] = ["idle", "streaming", "done", "fatal"];
    for (const phase of unchanged) {
      expect(phaseOnFirstChunk(phase)).toBe(phase);
    }
  });

  it("is idempotent — re-applying after the transition is a no-op", () => {
    expect(phaseOnFirstChunk(phaseOnFirstChunk("recovering"))).toBe("streaming");
  });
});
