/**
 * The optimistic-rollback client names a bad reply for what it is (#197).
 *
 * `callApi` never checked `res.ok`: it ran `res.json()` and read `body.ok`, so
 * any throw landed in `onImprove`'s catch and rendered `network error: <msg>`.
 * Measured on `main` 8453f46: a 500 showed "network error: Unexpected token
 * 'I', "Internal S"... is not valid JSON", a 200 `null` body "network error:
 * Cannot read properties of null (reading 'ok')". The other four clients show
 * `HTTP <status>` (#189/#191/#193 fixed the same class in the SSE clients).
 *
 * React's hooks are mocked: `useState` applies setter updaters to a local
 * copy, `useOptimistic` is a pass-through, `useTransition` hands back the
 * transition's promise, and `React.createElement` records each button's
 * `onClick` so the first item's Improve click can be driven directly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Item = { id: string; name: string; status: string; lastReason: string | null };
let items: Item[] = [];
let transition: Promise<unknown> | null = null;

vi.mock("react", () => ({
  useState: (initial: () => Item[]) => {
    items = initial();
    return [
      items,
      (u: (prev: Item[]) => Item[]) => {
        items = u(items);
      },
    ];
  },
  useOptimistic: (state: unknown) => [state, () => {}],
  useTransition: () => [
    false,
    (fn: () => Promise<unknown>) => {
      transition = fn();
    },
  ],
}));

async function click(fetchImpl: () => Promise<Response>): Promise<Item> {
  const clicks: (() => void)[] = [];
  vi.stubGlobal("React", {
    createElement: (type: unknown, props: Record<string, unknown> | null) => {
      if (type === "button" && typeof props?.onClick === "function") {
        clicks.push(props.onClick as () => void);
      }
      return null;
    },
  });
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  const { OptimisticRollbackClient } = await import(
    "../components/optimistic-rollback-client"
  );
  OptimisticRollbackClient();
  clicks[0]();
  await transition;
  return items[0];
}

const reply = (status: number, body: string | null) => async () =>
  new Response(body, { status });

afterEach(() => {
  vi.unstubAllGlobals();
  transition = null;
});

describe("a non-OK status shows HTTP <status> (#197)", () => {
  it.each([
    ["500 plain text", 500, "Internal Server Error"],
    ["502 HTML from a proxy", 502, "<!DOCTYPE html><html><body>Bad Gateway</body></html>"],
    ["504 empty body", 504, ""],
    ["503 JSON that looks like a decision", 503, '{"ok":true,"improved_name":"x.md"}'],
  ])("%s", async (_label, status, body) => {
    const it0 = await click(reply(status, body));
    expect(it0.status).toBe("rolled-back");
    expect(it0.lastReason).toBe(`HTTP ${status}`);
  });
});

describe("a 200 whose body is not a decision is a malformed response (#197)", () => {
  it.each([
    ["null", "null"],
    ["not JSON", "upstream overloaded"],
    ["empty", ""],
    ["a JSON array", "[]"],
    ["a JSON string", '"ok"'],
    ["ok:true without improved_name", '{"ok":true}'],
    ["ok:false with a numeric reason", '{"ok":false,"reason":5}'],
    ["no ok key", '{"reason":"nope"}'],
  ])("%s", async (_label, body) => {
    const it0 = await click(reply(200, body));
    expect(it0.status).toBe("rolled-back");
    expect(it0.lastReason).toBe("malformed response");
  });
});

describe("controls: what already worked still does", () => {
  it("a 200 rollback shows the server's reason", async () => {
    const it0 = await click(
      reply(200, '{"ok":false,"reason":"the model wasn\'t confident"}'),
    );
    expect(it0.status).toBe("rolled-back");
    expect(it0.lastReason).toBe("the model wasn't confident");
  });

  it("a 200 success commits the new name", async () => {
    const it0 = await click(reply(200, '{"ok":true,"improved_name":"renamed.md"}'));
    expect(it0.status).toBe("idle");
    expect(it0.name).toBe("renamed.md");
    expect(it0.lastReason).toBeNull();
  });

  it("a fetch that rejects is still a network error", async () => {
    const it0 = await click(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(it0.status).toBe("rolled-back");
    expect(it0.lastReason).toBe("network error: Failed to fetch");
  });
});
