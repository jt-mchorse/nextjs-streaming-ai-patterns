import { describe, expect, it } from "vitest";

import { pluralizeCount } from "../lib/plural";

describe("pluralizeCount", () => {
  describe("error-recovery counter (#66 regression)", () => {
    // The bug: `recovery{n > 1 ? "ies" : ""}` rendered "2 recoveryies" — it
    // appended "ies" instead of replacing the trailing "y". The recovery chip
    // only shows for n > 0, but every n >= 2 was wrong.
    it("renders the singular for exactly one recovery", () => {
      expect(pluralizeCount(1, "recovery", "recoveries")).toBe("1 recovery");
    });

    it("renders 'recoveries' (not 'recoveryies') for n >= 2", () => {
      expect(pluralizeCount(2, "recovery", "recoveries")).toBe("2 recoveries");
      expect(pluralizeCount(3, "recovery", "recoveries")).toBe("3 recoveries");
      expect(pluralizeCount(11, "recovery", "recoveries")).toBe("11 recoveries");
    });

    it("uses the plural for zero (English: '0 recoveries')", () => {
      // Not rendered by the chip today (gated on n > 0), but the helper must
      // get the English rule right so a future caller can't reintroduce
      // "0 recovery".
      expect(pluralizeCount(0, "recovery", "recoveries")).toBe("0 recoveries");
    });
  });

  describe("partial-json day(s) label — regular -s default", () => {
    it("renders '1 day' singular", () => {
      expect(pluralizeCount(1, "day")).toBe("1 day");
    });

    it("renders '<n> days' plural for n !== 1", () => {
      expect(pluralizeCount(0, "day")).toBe("0 days");
      expect(pluralizeCount(3, "day")).toBe("3 days");
    });
  });

  it("defaults the plural to singular + 's' when none is given", () => {
    expect(pluralizeCount(2, "token")).toBe("2 tokens");
    expect(pluralizeCount(1, "token")).toBe("1 token");
  });
});
