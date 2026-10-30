import { test, expect } from "./fixtures";
import { queryResults, visitorKeySql } from "./helpers";
import { EXAMPLE_EDGE_PERSIST, EXAMPLE_ORIGIN, FORM_ORIGIN } from "./results-key";

// B139 Task 13: 訪問者 ID の Cookie が、Cloudflare 経由のホスト(www.example.test。/__ab/*)と Cloudflare の外のホスト(form.example.test。/v1/)をつなぐこと。
// 土台(ポート無しの https・名前の解決・元のホスト名で edge が受ける・CORS)は Task 8 のもの。経路の条件は本番と同じで、テストのために緩めていない。
// D-lite の Site(site_demo_dlite)は shareSubdomains 既定 ON・cookieDomains ["example.test"] を焼いてある(fixtures/demo-dlite.json)ので、
// edge は ID の Cookie を Domain=example.test・HttpOnly なしで書く(どちらのホストの JavaScript からも読める)

const SITE = "site_demo_dlite";
const GOAL = "g_dlite_buy";
const RUN = "e2eDliteShared00000001"; // fixtures/demo-dlite.json の results.runs.exp_dlite

const participantsOf = (key: string) => queryResults(`SELECT run_id FROM participants WHERE site_id = '${SITE}' AND visitor_key = ${key}`, EXAMPLE_EDGE_PERSIST);

test("shared_id_connects_cloudflare_and_outside_hosts", async ({ context, page }) => {
  // 経路の記録: 2 回の訪問(www → form)の間じゅうの /__ab/*・/v1/ の要求を、訪問ごとに分けて集める
  let visit: "www" | "form" = "www";
  const seen: Record<"www" | "form", string[]> = { www: [], form: [] };
  page.on("request", (r) => {
    const { pathname } = new URL(r.url());
    if (pathname.startsWith("/__ab/") || pathname.startsWith("/v1/")) seen[visit].push(`${r.method()} ${r.url()}`);
  });

  // 1. Cloudflare 経由のホスト: 事前の Cookie なし。edge が /__ab/decision で ID を発行する
  const [decision] = await Promise.all([page.waitForResponse((r) => r.url().includes("/__ab/decision")), page.goto(`${EXAMPLE_ORIGIN}/dlite.html`)]);
  expect(decision.status()).toBe(200);
  const setCookies = (await decision.headersArray()).filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);
  const issued = setCookies.find((v) => v.startsWith("_ab_vid="));
  expect(issued, "edge が ID の Cookie を書いていない").toBeDefined();
  expect(issued).toContain("Domain=example.test"); // 共有の範囲 = 登録ドメイン
  expect(issued).not.toMatch(/HttpOnly/i); // 別ホストの JavaScript が読めるように HttpOnly を付けない
  const cookie = (await context.cookies()).find((c) => c.name === "_ab_vid");
  expect(cookie).toMatchObject({ domain: ".example.test", httpOnly: false, secure: true, path: "/" });
  const vid = cookie!.value;
  const key = visitorKeySql(SITE, vid);

  // 参加の記録(edge が CV の run を引く元)が先に D1 へ入っていること。D-lite は Cookie が正で、本文に ID を載せない
  await expect.poll(async () => (await participantsOf(key)).length, { timeout: 15_000, intervals: [500, 1000, 2000] }).toBeGreaterThan(0);

  // 2. Cloudflare の外のホスト: 同じ ID の Cookie が document.cookie で読める
  visit = "form";
  const [form] = await Promise.all([page.waitForResponse((r) => r.url().includes(`/v1/sites/${SITE}/decision`)), page.goto(`${FORM_ORIGIN}/dlite.html`)]);
  expect(form.status()).toBe(200);
  expect(await page.evaluate(() => document.cookie.split("; ").find((c) => c.startsWith("_ab_vid=")))).toBe(`_ab_vid=${vid}`);
  expect((form.request().postDataJSON() as { visitorId?: string }).visitorId).toBe(vid); // 本文の ID も同じ(Mode A の経路)

  // 3. 目標を達成 → /v1/ へ。この Site は履歴の条件(hist: converted)を持つ = needsProfile なので、runtime は目標の /event(type: "goal")だけを送り、
  //    結果の CV は edge がその goal の処理で参加の記録の run に対して書く(目標だけの CV(版 2)を別に送るのは needsProfile でない Site。results.spec.ts が見る)
  const [goal] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/v1/sites/${SITE}/event`) && String(r.request().postData()).includes('"type":"goal"')),
    page.click("#buy"),
  ]);
  expect(goal.request().postDataJSON()).toEqual({ type: "goal", goalId: GOAL, visitorId: vid });
  expect(goal.status()).toBe(204);

  // 4. 結果の D1: 同じ訪問者の CV が、www で参加した run に入っている(edge は 204 を返す前に書く。応答を待った後に 1 回読む)
  expect(await queryResults(`SELECT run_id, goal_id FROM conversions WHERE visitor_key = ${key}`, EXAMPLE_EDGE_PERSIST)).toEqual([{ run_id: RUN, goal_id: GOAL }]);

  // 経路の使い分け: www は /__ab/*(同じオリジン)だけ、form は /v1/(焼いた apiBase = www のオリジン。別オリジン)だけ
  expect(seen.www.length).toBeGreaterThan(0);
  expect(seen.www.filter((u) => !u.includes(`${EXAMPLE_ORIGIN}/__ab/`))).toEqual([]);
  expect(seen.form.length).toBeGreaterThan(0);
  expect(seen.form.filter((u) => !u.includes(`${EXAMPLE_ORIGIN}/v1/sites/${SITE}/`))).toEqual([]);
});
