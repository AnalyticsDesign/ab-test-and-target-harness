import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * admin speed B: ページ・layout の取得を並べる(lib/loaders.ts の allInOrder)と、requireUser を React の cache で包む(lib/control.ts)。
 * node の vitest が読む react(react-server の条件でない版)の cache は素通しなので、包んだ関数を覚える差し替えにして「包んだこと」を見る
 */

const cached = new Set<unknown>();
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <F extends (...args: never[]) => unknown>(fn: F): F => {
    const wrapped = ((...args: Parameters<F>) => fn(...args)) as F;
    cached.add(wrapped);
    return wrapped;
  },
}));

let meStatus = 200;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "wtt_session" ? { value: "t1" } : undefined) }),
  headers: async () => new Headers({ host: "localhost:3000" }),
}));
vi.mock("@/lib/control-binding", () => ({
  controlBinding: async () => ({ fetch: async () => (meStatus === 200 ? Response.json({ id: "u1", email: "a@example.com" }) : new Response(null, { status: meStatus })) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

const { requireUser } = await import("@/lib/control");
const { allInOrder } = await import("@/lib/loaders");

/** ms 後に値で解決する / 理由で reject する */
const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const failLater = (ms: number, reason: unknown) => new Promise<never>((_, reject) => setTimeout(() => reject(reason), ms));

beforeEach(() => {
  meStatus = 200;
});

describe("requireUser(admin speed B)", () => {
  it("React の cache で包んである(同じ描画の layout とページが 1 つの結果を使う)", () => {
    expect(cached.has(requireUser)).toBe(true);
  });

  it("ログイン中なら利用者を返し、/me が 200 でなければ /login へ redirect する", async () => {
    await expect(requireUser()).resolves.toMatchObject({ id: "u1" });
    meStatus = 401;
    await expect(requireUser()).rejects.toThrow("redirect:/login");
  });
});

describe("allInOrder: 並べて始め、並べた順に判定する(admin speed B)", () => {
  it("全部成功したら、並べた順の値を返す(終わった順ではない)", async () => {
    await expect(allInOrder([later(20, "a"), later(0, 1), Promise.resolve(true)])).resolves.toEqual(["a", 1, true]);
  });

  it("後ろが先に reject しても、前の reject の理由を投げる(直列に await していたときと同じ)", async () => {
    // 未ログイン: requireUser の redirect(遅い)と requireSummary の例外(速い)が同時に起きても、ログインへの redirect が出る
    const login = new Error("redirect:/login");
    await expect(allInOrder([failLater(20, login), failLater(0, new Error("summary"))])).rejects.toBe(login);
  });

  it("前が成功なら、後ろの reject の理由をそのまま投げる(redirect・notFound の印を保つため加工しない)", async () => {
    const notFound = Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    await expect(allInOrder([later(0, "user"), failLater(5, notFound)])).rejects.toBe(notFound);
  });

  it("前の reject で終わるときも、後ろの reject を未処理のまま残さない", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(allInOrder([failLater(0, new Error("first")), failLater(10, new Error("second"))])).rejects.toThrow("first");
      await later(30, null); // 後ろの reject が起きた後まで待つ
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
