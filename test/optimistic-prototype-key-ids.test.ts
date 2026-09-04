import { describe, expect, it } from "vitest";

import { POST } from "@/app/api/optimistic/route";
import { DEMO_NAMES, decide } from "@/lib/optimistic-decision";

/**
 * An id naming an `Object.prototype` member must not break the response
 * contract (#120).
 *
 * `IMPROVEMENTS` is an object literal, so `IMPROVEMENTS[id]` walks the
 * prototype chain. The old known-id test — `!options || options.length === 0`
 * — was a *proxy* for "is this a known demo id", and whether an inherited
 * member satisfied it depended on that member's **arity**. Three of the five
 * `Object.prototype` names below returned `undefined` from a function declared
 * to return `string`; the other two took the intended fallback only because
 * their arity happens to be 0.
 *
 * The population below is `Object.getOwnPropertyNames(Object.prototype)`
 * rather than a hand-listed five, so a prototype member added by a future
 * runtime is covered without editing this file.
 */

const PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype);

/** The rows that were broken, and the two that were accidentally correct. */
const AFFECTED = ["constructor", "hasOwnProperty", "__proto__"] as const;
const ACCIDENTALLY_CORRECT = ["toString", "valueOf"] as const;

describe("prototype-member ids", () => {
  it("has a population worth testing", () => {
    // Anti-vacuous: if this walk ever returns [] the table below passes on
    // nothing at all.
    expect(PROTOTYPE_KEYS.length).toBeGreaterThan(5);
    for (const key of [...AFFECTED, ...ACCIDENTALLY_CORRECT]) {
      expect(PROTOTYPE_KEYS).toContain(key);
    }
  });

  it.each(PROTOTYPE_KEYS)(
    "decide({ id: %j }) returns a real improved_name on the success branch",
    (id) => {
      // click_count 1 always succeeds (the first-click bias), so this reaches
      // pickImprovement by construction rather than by luck of the hash.
      const decision = decide({ id, click_count: 1 });
      expect(decision.ok).toBe(true);
      if (!decision.ok) return;
      expect(typeof decision.improved_name).toBe("string");
      expect(decision.improved_name.length).toBeGreaterThan(0);
    },
  );

  it.each(PROTOTYPE_KEYS)(
    "every ok decision for id %j carries improved_name across click counts",
    (id) => {
      // The contract, stated over the whole branch rather than one click:
      // *every* ok:true decision has a non-empty string improved_name.
      for (let clicks = 1; clicks <= 12; clicks++) {
        const decision = decide({ id, click_count: clicks });
        if (decision.ok) {
          expect(typeof decision.improved_name).toBe("string");
          expect(decision.improved_name.length).toBeGreaterThan(0);
        } else {
          expect(typeof decision.reason).toBe("string");
        }
      }
    },
  );

  it("keeps the two rows that were accidentally correct on the fallback path", () => {
    // `toString`/`valueOf` have arity 0, so `options.length === 0` sent them
    // down the custom-id fallback before this fix. That was the right answer
    // for the wrong reason, and it must stay the right answer.
    for (const id of ACCIDENTALLY_CORRECT) {
      const decision = decide({ id, click_count: 1 });
      expect(decision.ok).toBe(true);
      if (!decision.ok) return;
      expect(decision.improved_name).toBe(`${id}-improved.md`);
    }
  });

  it("gives the three broken rows the same fallback as any other custom id", () => {
    for (const id of AFFECTED) {
      const decision = decide({ id, click_count: 1 });
      expect(decision.ok).toBe(true);
      if (!decision.ok) return;
      // `__proto__` has no extension to strip, same as `constructor`.
      expect(decision.improved_name).toBe(`${id}-improved.md`);
    }
  });
});

describe("the neighbouring fix that reads as correct", () => {
  it("`id in IMPROVEMENTS` would have changed nothing", () => {
    // `in` walks the prototype chain exactly like a bare index does, so
    // swapping the truthiness proxy for `in` leaves every affected row broken.
    // `Object.hasOwn` is the question the guard actually means.
    const objectLiteral: Record<string, ReadonlyArray<string>> = { "a.txt": ["b.md"] };
    for (const id of AFFECTED) {
      expect(id in objectLiteral).toBe(true); // the neighbour says "known id"
      expect(Object.hasOwn(objectLiteral, id)).toBe(false); // what shipped
    }
    // And neither one may reject a genuinely known id.
    expect(Object.hasOwn(objectLiteral, "a.txt")).toBe(true);
  });
});

describe("the demo ids are unaffected", () => {
  it.each(DEMO_NAMES)("%s still resolves to a curated improvement", (id) => {
    const decision = decide({ id, click_count: 1 });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    // Curated names end in .md and are NOT the generic fallback shape.
    expect(decision.improved_name).not.toBe(
      `${id.replace(/\.[^.]+$/, "")}-improved.md`,
    );
    expect(decision.improved_name.endsWith(".md")).toBe(true);
  });
});

describe("POST /api/optimistic", () => {
  async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await POST(
      new Request("http://localhost/api/optimistic", {
        method: "POST",
        body: JSON.stringify(body),
      }) as never,
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it.each([...AFFECTED, ...ACCIDENTALLY_CORRECT])(
    "a %j id gets a 200 that actually carries improved_name",
    async (id) => {
      // The harm's final form: `JSON.stringify` drops an `undefined` value, so
      // the client received `200 {"ok":true}` — no `improved_name` key at all
      // — against a route documented as `200 {ok: true, improved_name: string}`.
      const { status, json } = await post({ id, click_count: 1 });
      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      expect(Object.hasOwn(json, "improved_name")).toBe(true);
      expect(typeof json.improved_name).toBe("string");
    },
  );

  it("still answers a normal demo id the same way", async () => {
    const { status, json } = await post({ id: DEMO_NAMES[0], click_count: 1 });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, improved_name: "meeting-notes.md" });
  });
});
