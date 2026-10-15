import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { uuidToVisitorId, visitorIdToUuid, bucketOf, hashByoidValue } from "@wtt/core";
import type { CompiledConfig } from "@wtt/core";
import { createRuntime, type AbApi, type RuntimeDeps } from "../src/runtime";
import { baseConfig, baseSettings, goalsConfig, namedConfig, namedSettings, remoteConfig } from "./fixtures";

/** exp_hero(50/50)で指定の半分に入る canonical ID を探す */
function findVisitor(half: "A" | "B"): string {
  for (let i = 0; i < 5000; i++) {
    const id = uuidToVisitorId(`00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`)!;
    const b = bucketOf(id, "exp_hero");
    if (half === "A" ? b < 5000 : b >= 5000) return id;
  }
  throw new Error("visitor not found");
}
const VB = findVisitor("B");

/**
 * 手動 resolve の fetch。応答は実 `Response` ではなく `{ ok, json }` の最小スタブにする —
 * 実 Response の body 読み出しがマイクロタスク何回で解決するかに依存させないため(r1 CL-Medium-4)。
 * 実測: vitest 4.1.11 の `useFakeTimers()` は既定で `queueMicrotask` / `nextTick` を faked しないので、
 * `flush()` のマイクロタスク送りは効く。それでも実 Response の内部ジョブ数には依存させない
 */
function deferredFetch() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = ((url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return promise;
  }) as typeof fetch;
  const okRes = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
  return { fn, resolve, calls, okRes };
}

/**
 * 呼び出しごとに別々の Promise を返す fetch。`deferredFetch` は全呼び出しで同じ Promise を共有するため、
 * 「旧世代の応答だけを着弾させ、新世代は in-flight のまま保つ」テストには使えない
 */
function perCallDeferredFetch() {
  const calls: Array<{ url: string; init: RequestInit | undefined; resolve: (r: Response) => void; cookieAtCall: string }> = [];
  const fn = ((url: RequestInfo | URL, init?: RequestInit) => {
    let resolve!: (r: Response) => void;
    const promise = new Promise<Response>((r) => (resolve = r));
    // 呼出時点の Cookie を記録し、送信と削除の順序を discriminating に検証する(forget は削除前に控えた ID で送る)
    calls.push({ url: String(url), init, resolve, cookieAtCall: document.cookie });
    return promise;
  }) as typeof fetch;
  const okRes = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
  return { fn, calls, okRes };
}

function makeDeps(fetchFn: typeof fetch, nonce: string | null = null): RuntimeDeps {
  return { win: window as RuntimeDeps["win"], doc: document, fetchFn, scriptSrc: "https://edge.test/s/site_unit.js", nonce };
}

function dataLayer(): Array<Record<string, unknown>> {
  return ((window as unknown as { dataLayer?: Array<Record<string, unknown>> }).dataLayer ?? []);
}

function clearCookies(): void {
  for (const part of document.cookie.split(/;\s*/)) {
    const name = part.split("=")[0];
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  clearCookies();
  document.body.innerHTML = `<h1 class="hero-title">orig</h1>`;
  // 前 test の engine が consent(false) の直前に(afterEach の consent(false) より先に届く MutationObserver 通知で)
  // 自身が手動 remove した <style> を再接続してしまうことがある(happy-dom のマイクロタスク配送順。r1 CL-Medium-3 と同種)。
  // <head> の CSS Change <style> は前 test の PageState だけが参照する DOM ノードなので、次 test 開始前に一掃しても
  // 各 test は必ず自前の PageState / assertion を持つため無害(apply.test.ts の既存パターンと同じ)
  document.head.querySelectorAll("style[data-ab-change]").forEach((s) => s.remove());
  delete (window as unknown as Record<string, unknown> & Window).dataLayer;
  delete (window as unknown as Record<string, unknown> & Window).__ab;
});
afterEach(() => {
  // ⚠ happy-dom アダプタ(test 間の分離のみ。実装の挙動は変えない)。
  // 各 test は共有の happy-dom document に別々の runtime を起動する。ApplyEngine の MutationObserver は
  // ページ寿命いっぱい生き続ける設計(§10.4)なので、止めないと次の test の `body.innerHTML = ...` を
  // 変異として拾い、新しい .hero-title へ前の test の Change を再適用してしまう。
  // AbApi に stop() は無く、engine.stop() に到達する公開経路は revoke だけなので consent(false) で止める
  //(§16 の onRevoke が engine.stop() を呼ぶ)。`window.AB` は createRuntime が必ず設置する現行 API(§10.8)
  ((window as RuntimeDeps["win"]).AB as AbApi | undefined)?.consent(false);
  delete (window as unknown as Record<string, unknown> & Window).AB;
  vi.useRealTimers();
});

/** fake timers 下で pending の Promise チェーンを進める */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * ⚠ happy-dom アダプタ(テスト環境の非互換を実ブラウザ挙動に寄せるだけのもの)。
 * **実装が書く内容は一切変えない**。翻訳するのは「実装がすでに発行した失効指示」の解釈だけで、
 * 削除を発行しなかった runtime は依然として assertion に落ちる(下記 2. を参照)。
 *
 * 1. accessor の所在: happy-dom の document は複数段の HTMLDocument を挟むため、グローバルの
 *    `Document.prototype` に `cookie` accessor が無い(`getOwnPropertyDescriptor` が undefined)。
 *    prototype chain を辿って本物を取る。
 * 2. `Max-Age=0` が効かない: happy-dom の CookieContainer は
 *    `hasExpired = expires.getTime() < Date.now()` でしか Cookie を消さず、`Max-Age=0` は
 *    `expires === Date.now()` になるので「空値のまま残る」(`_ab_vid=`)。しかも本ファイルは
 *    `vi.useFakeTimers()` で時計が止まるため決して期限切れにならず、削除が永久に成立しない。
 *    そこで **入力文字列に Max-Age <= 0 が含まれるときだけ** 過去 Expires を追記して実ブラウザに合わせる。
 *    つまり変換のトリガは実装自身が書いた削除属性であり、削除を書かなければ変換は起きない —
 *    `not.toContain("_ab_vid=")` 系の assertion は vacuous にならない。
 */
const nativeCookie = ((): PropertyDescriptor => {
  for (let o: object | null = document; o; o = Object.getPrototypeOf(o) as object | null) {
    const d = Object.getOwnPropertyDescriptor(o, "cookie");
    if (d?.get && d.set) return d;
  }
  throw new Error("cookie accessor not found");
})();
Object.defineProperty(document, "cookie", {
  configurable: true,
  get(): string {
    return nativeCookie.get!.call(document) as string;
  },
  set(raw: string) {
    // `raw` は改変しない。実装が Max-Age <= 0(= 削除)を書いたときだけ、happy-dom が解釈できる
    // 過去 Expires を **追記** する(属性は後勝ちなので Expires が効く)。書き込み内容の意味は変えず、
    // 削除を書かなかった場合は何も起きない = 実装をごまかせない
    const maxAge = /;\s*Max-Age=\s*(-?\d+)/i.exec(raw)?.[1];
    const isDeletion = maxAge !== undefined && Number(maxAge) <= 0;
    nativeCookie.set!.call(document, isDeletion ? `${raw}; Expires=Thu, 01 Jan 1970 00:00:00 GMT` : raw);
  },
});

it("boots locally for mode A needsProfile=false: no request, applies, exposes (spec §7.1 / §10.5)", async () => {
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = deferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: baseConfig, settings: baseSettings });
  await flush();
  expect(f.calls.length).toBe(0); // リクエストゼロ特性
  expect(document.querySelector(".hero-title")!.textContent).toBe("B!");
  expect(document.getElementById("__ab_prehide")).toBeNull(); // 適用後に解除
  expect(dataLayer().filter((e) => e.event === "ab_exposure")).toHaveLength(1);
  expect(api.getAssignments()).toEqual({ exp_hero: "vB" });
});

it("AB.track pushes ab_conversion for a known CUSTOM goal (spec §10.6 / §10.8)", async () => {
  const f = deferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: baseConfig, settings: baseSettings });
  await flush();
  api.track("g_cta");
  api.track("g_unknown"); // 未知は無視
  expect(dataLayer().filter((e) => e.event === "ab_conversion")).toEqual([
    { event: "ab_conversion", ab_goal_id: "g_cta", ab_goal_name: "CTA click", ab_extra: null },
  ]);
});

it("renamed_keys_are_applied_to_exposure_and_conversion", async () => {
  // spec §10.9: 名札はサイト設定、値は compile 済みの exposurePayloads。runtime は当てて push するだけ
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = deferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: namedConfig, settings: namedSettings });
  await flush();
  expect(dataLayer()).toEqual([
    { wtt_x: null },
    { event: "wtt_exposure", wtt_exp_id: "exp_hero", wtt_exp_name: "Hero Q3", wtt_var_id: "vB", wtt_var_name: "New hero", wtt_x: { test_group: "pricing_q3", external_exp_id: "E-101" } },
  ]);
  api.track("g_cta");
  expect(dataLayer()[2]).toEqual({ event: "wtt_conversion", wtt_goal_id: "g_cta", wtt_goal_name: "CTA click", wtt_x: null });
  // 既定名はどこにも出ない
  for (const e of dataLayer()) for (const k of Object.keys(e)) expect(k.startsWith("ab_"), k).toBe(false);
  for (const e of dataLayer()) expect(e.event === "ab_exposure" || e.event === "ab_conversion").toBe(false);
});

it("legacy_config_without_analytics_uses_default_names", async () => {
  // settings.analytics も config.exposurePayloads も無い旧 record → 既定名・導出値・extra なし。消去 push は入る(§10.9「バージョンと異常時」)
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = deferredFetch();
  expect("analytics" in baseSettings).toBe(false);
  expect("exposurePayloads" in baseConfig).toBe(false);
  const api = createRuntime(makeDeps(f.fn), { config: baseConfig, settings: baseSettings });
  await flush();
  expect(dataLayer()).toEqual([
    { ab_extra: null },
    { event: "ab_exposure", ab_experiment_id: "exp_hero", ab_experiment_name: "Hero", ab_variant_id: "vB", ab_variant_name: "B", ab_extra: null },
  ]);
  api.track("g_cta");
  expect(dataLayer()[2]).toEqual({ event: "ab_conversion", ab_goal_id: "g_cta", ab_goal_name: "CTA click", ab_extra: null });
});

it("conversion_push_clears_extra_namespace", async () => {
  // Exposure が extra を載せた後の Conversion は、同じ push の中で名前空間を null にする(§10.6 / §10.9。消去は直前のみ、直後には行わない)
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = deferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: namedConfig, settings: namedSettings });
  await flush();
  expect(dataLayer()[1]).toMatchObject({ wtt_x: { test_group: "pricing_q3" } }); // 前提: Exposure が extra を載せた
  expect(dataLayer()).toHaveLength(2); // Exposure の直後には消去 push を足さない
  api.track("g_cta");
  const conv = dataLayer()[2]!;
  expect(conv.event).toBe("wtt_conversion");
  expect(conv).toHaveProperty("wtt_x", null);
  // GTM のデータモデル(push をマージ、null は置換)で畳み込むと Conversion 時点の wtt_x は null になる
  const model: Record<string, unknown> = {};
  for (const p of dataLayer()) for (const [k, v] of Object.entries(p)) model[k] = v; // 1 階層の置換で十分(null / 標準キーはスカラー、extra はオブジェクトごと置換)
  expect(model.wtt_x).toBeNull();
  expect(model.wtt_exp_id).toBe("exp_hero"); // 標準キーは残る(Exposure 後の残留は許容。§10.9)
});

it("malformed exposure payloads reject the whole boot: no DOM change, no push (§10.9 型不正は fail-closed)", async () => {
  // isExposurePayloads が起動前に弾くので、apply engine が DOM を変えた後で expose() が例外になる経路は存在しない
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = deferredFetch();
  const broken = { ...namedConfig, exposurePayloads: { exp_hero: { vB: { ...namedConfig.exposurePayloads!.exp_hero!.vB!, extra: null } } } };
  const api = createRuntime(makeDeps(f.fn), { config: broken as unknown as CompiledConfig, settings: namedSettings });
  await flush();
  expect(document.querySelector(".hero-title")!.textContent).toBe("orig");
  expect(dataLayer()).toEqual([]);
  expect(api.getAssignments()).toEqual({});
});

it("boot_failure_removes_prehide_and_leaves_original_dom", async () => {
  // r1 CL-High-1: start() は async で void 呼びされるため、例外は unhandled rejection になり
  // prehide は deadline まで残る(最大 3 秒の白紙)。§10.7 の「何もしない / 元表示」を非同期経路でも守る。
  // r2 CX-Medium-9: **Cookie を置かない** — 有効な canonical Cookie があると generateVisitorId を通らず、
  // 例外が起きないまま runtime が正常動作してしまい、このテストは何も証明しない
  const f = deferredFetch();
  const spy = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
    throw new Error("identity exploded");
  });
  const api = createRuntime(makeDeps(f.fn), { config: baseConfig, settings: baseSettings });
  await flush();
  expect(spy).toHaveBeenCalled(); // 例外経路を実際に通ったことを先に固定する
  spy.mockRestore();
  expect(document.getElementById("__ab_prehide")).toBeNull(); // deadline を待たずに解除されている
  expect(document.querySelector(".hero-title")!.textContent).toBe("orig");
  expect(dataLayer().filter((e) => e.event === "ab_exposure")).toHaveLength(0);
  expect(api.getAssignments()).toEqual({});
});

it("revoke_resets_exposure_and_assignments_with_only_the_forget_request", async () => {
  // 決定 30 (4): revoke は Identity + assignments + Exposure の発火済み記録を捨てる。
  // 再 grant は新しい訪問者としての開始なので、同じ Experiment の Exposure が再び発火する。
  // r2 CX-Medium-10: この配線(onRevoke → exposure.reset())は tracker 単体テストでは証明できない。
  // r2 CX-Low-4 → backlog B53 で改定: Mode A の revoke が起こす通信は forget の 1 要求だけ(needsProfile=false でも送る。決定 37 C と揃える)。
  // decision は撤回の前後とも送らない
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = perCallDeferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: baseConfig, settings: baseSettings });
  await flush();
  expect(f.calls.length).toBe(0); // needsProfile=false はブラウザ内評価(§7.1)
  expect(dataLayer().filter((e) => e.event === "ab_exposure")).toHaveLength(1);
  api.consent(false);
  await flush();
  expect(f.calls.map((c) => c.url.replace(/^.*\/v1/, "/v1"))).toEqual(["/v1/sites/site_unit/event"]); // forget だけ(siteId は fixtures の config)
  expect(JSON.parse(String(f.calls[0]!.init?.body))).toEqual({ type: "forget", visitorId: VB });
  expect(api.getAssignments()).toEqual({});
  f.calls[0]!.resolve({ ok: true, status: 204, json: async () => ({}) } as unknown as Response); // 新世代は forget の settle を待つ
  api.consent(true);
  await flush();
  // 新しい ID で再起動。vB なら適用経由、vA なら exposureSelectors(.hero-title は DOM にある)経由で必ず発火する
  expect(dataLayer().filter((e) => e.event === "ab_exposure")).toHaveLength(2);
  expect(Object.keys(api.getAssignments())).toEqual(["exp_hero"]);
  expect(f.calls.filter((c) => c.url.includes("/decision"))).toHaveLength(0);
});

it("d_lite_initial_denied_starts_nothing", async () => {
  // 決定 30 (1): D-lite の事前 denied では consent body も decision も送らず、Cookie API にも触れない
  //(正本は edge 所有で、削除には通信が要るため「denied の間は通信しない」を優先する)。
  // r2 CX-Medium-11: createConsent の unit は状態しか見ないので、この分岐の退行はここでしか捕まらない。
  // 決定 30 (6) の「implicit でも明示 denied は尊重する」経路も同時に通る
  const counts = { reads: 0, writes: 0 };
  const desc = Object.getOwnPropertyDescriptor(document, "cookie")!;
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get() { counts.reads++; return desc.get!.call(document); },
    set(v: string) { counts.writes++; desc.set!.call(document, v); },
  });
  try {
    (window as unknown as Record<string, unknown> & Window).__ab = { consent: "denied" };
    const f = deferredFetch();
    const api = createRuntime(makeDeps(f.fn), { config: baseConfig, settings: { ...baseSettings, mode: "B" } });
    await flush();
    vi.advanceTimersByTime(3000);
    await flush();
    expect(f.calls.length).toBe(0);
    expect(counts.writes).toBe(0);
    expect(counts.reads).toBe(0);
    expect(document.getElementById("__ab_prehide")).toBeNull();
    expect(api.getAssignments()).toEqual({});
  } finally {
    Object.defineProperty(document, "cookie", desc);
  }
});

it("required_with_denied_bootstrap_clears_existing_identity", async () => {
  // r1 CX-High-1: 事前状態 denied で読み込まれた場合も残存 Identity を掃除する(通信は伴わない)。
  // 掃除しないと denied の間ずっと旧 Cookie が生き、再 grant で §16 の「新しい ID を発行」が破れる
  document.cookie = `_ab_vid=${VB}; Path=/`;
  // uuidCookieEnabled: true の起動が書いたのと同じ状態を作る。両方置かないと `_ab_uuid` の assertion は
  // 「元から無いだけ」で必ず通ってしまい、revokeIdentity が uuidCookieEnabled を尊重するかを判定できない
  document.cookie = `_ab_uuid=${visitorIdToUuid(VB)!}; Path=/`;
  (window as unknown as Record<string, unknown> & Window).__ab = { consent: "denied" };
  const f = deferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: baseConfig, settings: { ...baseSettings, consentMode: "required", uuidCookieEnabled: true } });
  await flush();
  expect(document.cookie).not.toContain("_ab_vid=");
  expect(document.cookie).not.toContain("_ab_uuid=");
  expect(f.calls.length).toBe(0); // §16: denied の間は送らない
  api.consent(true);
  await flush();
  expect(document.cookie).toContain("_ab_vid=");
  expect(document.cookie).not.toContain(VB); // 旧 ID は復元しない
});

it("required_without_bootstrap_stays_pending", async () => {
  const f = deferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: baseConfig, settings: { ...baseSettings, consentMode: "required" } });
  await flush();
  vi.advanceTimersByTime(3000);
  await flush();
  // §16: 事前状態なしは pending のまま — Cookie なし・リクエストなし・prehide なし
  expect(document.cookie).toBe("");
  expect(f.calls.length).toBe(0);
  expect(document.getElementById("__ab_prehide")).toBeNull();
  expect(document.querySelector(".hero-title")!.textContent).toBe("orig");
  // §16: pending / denied の間は event を送らない。既知の CUSTOM goal でも dataLayer に何も積まない
  api.track("g_cta");
  api.consent(false); // denied へ遷移しても同じ
  api.track("g_cta");
  expect(dataLayer()).toHaveLength(0);
});

it("grant_starts_identity_once", async () => {
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = deferredFetch();
  // remote 経路(persistAssignment)でリクエスト数 = 起動回数を数える
  const api = createRuntime(makeDeps(f.fn), { config: remoteConfig, settings: { ...baseSettings, consentMode: "required" } });
  await flush();
  expect(f.calls.length).toBe(0);
  api.consent(true);
  await flush();
  expect(f.calls.length).toBe(1);
  api.consent(true); // granted -> granted は起動しない(§16: 起動処理は 1 回だけ)
  await flush();
  expect(f.calls.length).toBe(1);
});

it("revocation_ignores_inflight_decision_response", async () => {
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = deferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: remoteConfig, settings: baseSettings });
  await flush();
  expect(f.calls.length).toBe(1); // in-flight
  api.consent(false); // revoke(§16)
  await flush();
  expect(document.cookie).not.toContain("_ab_vid="); // Cookie は削除済み
  f.resolve(f.okRes({ v: 3, experiments: [{ id: "exp_hero", variant: "vB" }] }));
  await flush();
  // 期限内の応答でも revoke 後は破棄: 適用も Exposure も再発行もしない
  expect(document.querySelector(".hero-title")!.textContent).toBe("orig");
  expect(dataLayer().filter((e) => e.event === "ab_exposure")).toHaveLength(0);
  expect(document.cookie).not.toContain("_ab_vid=");
  expect(api.getAssignments()).toEqual({}); // 旧 Identity 由来の割当も残さない(r1 CX-Medium-1)
});

it("decision_at_deadline_minus_1ms_applies_once", async () => {
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = deferredFetch();
  createRuntime(makeDeps(f.fn), { config: remoteConfig, settings: baseSettings }); // decisionTimeoutMs = 1000
  await flush();
  expect(document.getElementById("__ab_prehide")).not.toBeNull(); // 期限まで prehide 継続
  vi.advanceTimersByTime(999); // 期限の 1ms 前
  f.resolve(f.okRes({ v: 3, experiments: [{ id: "exp_hero", variant: "vB" }] }));
  await flush();
  expect(document.querySelector(".hero-title")!.textContent).toBe("B!");
  expect(document.getElementById("__ab_prehide")).toBeNull();
  expect(dataLayer().filter((e) => e.event === "ab_exposure")).toHaveLength(1); // 1 回だけ
  vi.advanceTimersByTime(5000); // 期限タイマーが後から発火しても二重処理しない
  await flush();
  expect(dataLayer().filter((e) => e.event === "ab_exposure")).toHaveLength(1);
});

it("decision_after_deadline_is_ignored_and_never_exposes", async () => {
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = deferredFetch();
  createRuntime(makeDeps(f.fn), { config: remoteConfig, settings: baseSettings });
  await flush();
  vi.advanceTimersByTime(1000); // 期限到達
  await flush();
  expect(document.getElementById("__ab_prehide")).toBeNull(); // 期限で解除して元表示(§10.3)
  f.resolve(f.okRes({ v: 3, experiments: [{ id: "exp_hero", variant: "vB" }] }));
  await flush();
  expect(document.querySelector(".hero-title")!.textContent).toBe("orig"); // 期限後の応答は破棄
  expect(dataLayer().filter((e) => e.event === "ab_exposure")).toHaveLength(0); // Exposure も送らない
});

it("keeps the new generation's prehide when a revoked generation finishes late (spec §10.3)", async () => {
  // R8: `finally` の removePrehide が世代で守られていないと、gen 1 の終了処理が gen 3 の prehide を剥がす。
  // 1. gen 1 が起動し prehide を張って decision 待ちに入る
  // 2. revoke で世代が進み prehide が外れる
  // 3. 再 grant の start() は最初の await より前に **同期で** prehide を張り直す
  // 4. そこへ gen 1 の応答が着弾 → isStale() で破棄されるが、その finally が gen 3 の prehide を消してしまう
  // injectPrehide は既存要素があると no-op なので gen 3 は張り直さず、決定窓の残りが無防備になり
  // 適用時にちらつく(§10.3 の「決定窓の間は隠し続ける」が破れる)
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = perCallDeferredFetch(); // 旧世代の応答だけを着弾させるため呼び出しごとに別 Promise
  const api = createRuntime(makeDeps(f.fn), { config: remoteConfig, settings: baseSettings });
  await flush();
  expect(f.calls.length).toBe(1); // gen 1 が in-flight
  expect(document.getElementById("__ab_prehide")).not.toBeNull();

  api.consent(false); // gen 2: revoke — prehide は一旦外れる
  await flush();
  expect(document.getElementById("__ab_prehide")).toBeNull();

  api.consent(true); // gen 3: 新世代が同期で prehide を張り直す
  await flush();
  // r2 CX-Medium-4: remoteConfig(needsProfile)なので撤回で forget が送られ、新世代は forget が settle するまで待つ
  f.calls.find((c) => String(c.init?.body).includes("forget"))!.resolve({ ok: true, status: 204, json: async () => ({}) } as unknown as Response);
  await flush();
  expect(f.calls.filter((c) => c.url.includes("/decision"))).toHaveLength(2); // 旧・新の decision(forget は URL で除外)
  expect(document.getElementById("__ab_prehide")).not.toBeNull();

  // gen 1 の応答だけが遅れて着弾する(gen 3 は未解決のまま)
  f.calls[0]!.resolve(f.okRes({ v: 3, experiments: [{ id: "exp_hero", variant: "vB" }] }));
  await flush();
  // 旧世代の終了で現世代の prehide を剥がさない
  expect(document.getElementById("__ab_prehide")).not.toBeNull();
  // 旧世代の応答は破棄されたまま: 適用も Exposure もしない
  expect(document.querySelector(".hero-title")!.textContent).toBe("orig");
  expect(dataLayer().filter((e) => e.event === "ab_exposure")).toHaveLength(0);
});

it("does nothing for an unknown schemaVersion (spec §6.4)", async () => {
  const f = deferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: { ...baseConfig, schemaVersion: 3 as unknown as 2 }, settings: baseSettings });
  await flush();
  expect(document.cookie).toBe("");
  expect(f.calls.length).toBe(0);
  expect(api.getAssignments()).toEqual({}); // AB は無害なスタブとして残る
});

it("aborts the in-flight decision before posting the d-lite consent body (spec §16 / §9.6)", async () => {
  // R14 finding 1: D-lite の decision 応答は正本 Cookie の Set-Cookie(Max-Age=1 年)を伴い、
  // ブラウザは JS が応答をどう扱うかに関係なくそれを適用する。中断しないと
  // 「revoke で削除 → 直前の decision 応答が着弾 → Cookie が 1 年分再発行」になり §16 が破れる。
  // isStale() による応答の破棄では防げない(破棄されるのは本体だけ)ので、中断そのものを固定する
  const f = perCallDeferredFetch(); // decision を in-flight のまま保つ(共有 Promise では中断を観測できない)
  const api = createRuntime(makeDeps(f.fn), { config: baseConfig, settings: { ...baseSettings, mode: "B" } });
  await flush();
  expect(f.calls.length).toBe(1); // decision が in-flight
  const signal = f.calls[0]!.init!.signal as AbortSignal;
  expect(signal.aborted).toBe(false);
  // 中断が consent body の送信より **前** であることも見る(edge が最後に見るのが削除になる順序)
  let abortedBeforeConsentPost = false;
  signal.addEventListener("abort", () => { abortedBeforeConsentPost = f.calls.length === 1; });

  api.consent(false);
  expect(signal.aborted).toBe(true);
  expect(abortedBeforeConsentPost).toBe(true);
  await flush();
  expect(f.calls.length).toBe(2);
  expect(JSON.parse(String(f.calls[1]!.init?.body))).toEqual({ kind: "consent", value: "denied" }); // consent body は送られている
  expect(f.calls[1]!.init?.signal).toBeUndefined(); // 削除の送信自体は中断しない
});

it("d-lite revoke posts a consent body and never writes document.cookie (spec §16 / §9.6)", async () => {
  const f = deferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: baseConfig, settings: { ...baseSettings, mode: "B" } });
  await flush();
  expect(f.calls.length).toBe(1); // D-lite は毎 PV decision
  expect(f.calls[0]!.url).toBe("/__ab/decision");
  // §9.6: 正本 Cookie は edge 所有。runtime は自分が持たない ID を decision body に混ぜない
  expect(JSON.parse(String(f.calls[0]!.init?.body))).not.toHaveProperty("visitorId");
  api.consent(false);
  await flush();
  expect(f.calls.length).toBe(2);
  expect(JSON.parse(String(f.calls[1]!.init?.body))).toEqual({ kind: "consent", value: "denied" });
  expect(document.cookie).toBe("");
});

const eventCalls = (f: ReturnType<typeof perCallDeferredFetch>) => f.calls.filter((c) => c.url.includes("/event")).map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);

it("pageview_goal_fires_once_per_load_and_posts_event", async () => {
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = perCallDeferredFetch();
  createRuntime(makeDeps(f.fn), { config: goalsConfig, settings: baseSettings });
  await flush();
  expect(dataLayer().filter((e) => e.event === "ab_conversion")).toEqual([
    { event: "ab_conversion", ab_goal_id: "g_pv", ab_goal_name: "Pricing view", ab_extra: null },
  ]);
  expect(eventCalls(f)).toEqual([{ type: "goal", goalId: "g_pv", visitorId: VB }]);
  expect(f.calls.find((c) => c.url.includes("/event"))!.url).toBe("https://edge.test/v1/sites/site_unit/event"); // scriptSrc 基準
  expect(f.calls.find((c) => c.url.includes("/event"))!.init?.keepalive).toBe(true);
});

it("click goals and AB.track go through the same conversion path (spec §10.6)", async () => {
  document.body.innerHTML = `<h1 class="hero-title">orig</h1><a class="cta">buy</a>`;
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = perCallDeferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: goalsConfig, settings: baseSettings });
  await flush();
  document.querySelector<HTMLElement>(".cta")!.click();
  document.querySelector<HTMLElement>(".cta")!.click();
  api.track("g_cta");
  expect(dataLayer().filter((e) => e.event === "ab_conversion").map((e) => e.ab_goal_id)).toEqual(["g_pv", "g_click", "g_click", "g_cta"]);
  expect(eventCalls(f).map((b) => b.goalId)).toEqual(["g_pv", "g_click", "g_click", "g_cta"]);
});

it("events_are_not_sent_when_needs_profile_is_false", async () => {
  document.body.innerHTML = `<h1 class="hero-title">orig</h1><a class="cta">buy</a>`;
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = perCallDeferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: { ...goalsConfig, needsProfile: false, experiments: baseConfig.experiments }, settings: baseSettings });
  await flush();
  document.querySelector<HTMLElement>(".cta")!.click();
  api.track("g_cta");
  expect(dataLayer().filter((e) => e.event === "ab_conversion")).toHaveLength(3); // dataLayer には出る
  expect(f.calls).toHaveLength(0); // §9.2: needsProfile=false は送らない
});

it("revoke_posts_forget_with_the_id_captured_before_identity_removal", async () => {
  // 順序の証明: Cookie は撤回で即時に消える(fetch 呼出時点で既に無い)のに、forget の body には撤回前の ID が入っている = 削除前に控えた ID
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = perCallDeferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: goalsConfig, settings: baseSettings });
  await flush();
  const pv = f.calls.find((c) => c.url.includes("/event"))!; // PAGEVIEW の goal event が in-flight
  const before = f.calls.length;
  api.consent(false);
  await flush();
  expect(document.cookie).not.toContain("_ab_vid="); // Cookie は即時に消える
  expect(f.calls.slice(before).filter((c) => c.url.includes("/event"))).toHaveLength(0); // in-flight の goal が settle するまで forget は送らない
  pv.resolve({ ok: true, status: 204, json: async () => ({}) } as unknown as Response);
  await flush();
  const forget = f.calls.slice(before).filter((c) => c.url.includes("/event"));
  expect(forget.map((c) => JSON.parse(String(c.init?.body)))).toEqual([{ type: "forget", visitorId: VB }]); // 撤回前に控えた ID
  expect(forget[0]!.cookieAtCall).not.toContain("_ab_vid="); // 送信時点で Cookie は既に無い(ID は変数から)
  expect(forget[0]!.init?.keepalive).toBe(true);
  expect(forget[0]!.init?.signal).toBeUndefined(); // forget は中断しない
  api.consent(false); // denied → denied は遷移ではないので何も送らない
  await flush();
  expect(f.calls.slice(before).filter((c) => c.url.includes("/event"))).toHaveLength(1);
});

it("forget_disabled_setting_skips_the_request", async () => {
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = perCallDeferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: goalsConfig, settings: { ...baseSettings, forgetOnRevoke: false } });
  await flush();
  const before = f.calls.length;
  api.consent(false);
  await flush();
  expect(f.calls.slice(before).filter((c) => c.url.includes("/event"))).toHaveLength(0);
  expect(document.cookie).not.toContain("_ab_vid="); // Identity の削除は変わらず行う
});

it("forget_is_sent_even_when_the_current_config_does_not_need_a_profile", async () => {
  // Codex Security F10(2026-10-08): 以前は `config.needsProfile` のときだけ forget を送っていたが、needsProfile の版で作られた Profile は
  // 現行の版が needsProfile=false になっても DO に残る(Mode C では再同意で旧履歴に再接続する)。edge の forget は config を見ずに
  // 常に処理する(決定 37 C)ので、runtime も「Cookie の ID があり forgetOnRevoke が有効なら送る」に揃える
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = perCallDeferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: { ...baseConfig, needsProfile: false }, settings: baseSettings });
  await flush();
  expect(f.calls).toHaveLength(0); // needsProfile=false は decision を送らない(変わらず)
  api.consent(false);
  await flush();
  const forget = f.calls.filter((c) => c.url.includes("/event"));
  expect(forget.map((c) => JSON.parse(String(c.init?.body)))).toEqual([{ type: "forget", visitorId: VB }]);
  expect(document.cookie).not.toContain("_ab_vid=");
  // forgetOnRevoke が off なら送らない(変わらず)
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const g = perCallDeferredFetch();
  const api2 = createRuntime(makeDeps(g.fn), { config: { ...baseConfig, needsProfile: false }, settings: { ...baseSettings, forgetOnRevoke: false } });
  await flush();
  api2.consent(false);
  await flush();
  expect(g.calls).toHaveLength(0);
});

it("revoke_waits_for_inflight_goal_events_before_forget", async () => {
  // r2 CX-High-2: goal event が DO で処理済み(settle)になってから forget を送る。abort では送信済みのサーバー処理を止められない
  document.body.innerHTML = `<h1 class="hero-title">orig</h1><a class="cta">buy</a>`;
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = perCallDeferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: goalsConfig, settings: baseSettings });
  await flush();
  f.calls.find((c) => c.url.includes("/event"))!.resolve({ ok: true, status: 204, json: async () => ({}) } as unknown as Response); // PAGEVIEW は settle 済みにしておく
  await flush();
  document.querySelector<HTMLElement>(".cta")!.click();
  const goal = f.calls.filter((c) => c.url.includes("/event") && String(c.init?.body).includes("g_click"))[0]!;
  api.consent(false);
  await flush();
  expect(f.calls.some((c) => String(c.init?.body).includes("forget"))).toBe(false); // click の goal が in-flight の間は送らない
  goal.resolve({ ok: true, status: 204, json: async () => ({}) } as unknown as Response);
  await flush();
  const forget = f.calls.filter((c) => String(c.init?.body).includes("forget"));
  expect(forget).toHaveLength(1);
  expect(forget[0]!.init?.signal).toBeUndefined();
});

it("forget_is_sent_after_the_wait_cap_when_a_goal_event_hangs", async () => {
  // r2 CX-High-2: 通信断で goal が settle しなくても、上限 2 秒で forget を送る(撤回を無期限に遅らせない)
  document.body.innerHTML = `<h1 class="hero-title">orig</h1><a class="cta">buy</a>`;
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = perCallDeferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: goalsConfig, settings: baseSettings });
  await flush();
  document.querySelector<HTMLElement>(".cta")!.click(); // 解決しない goal event
  api.consent(false);
  await flush();
  expect(f.calls.some((c) => String(c.init?.body).includes("forget"))).toBe(false);
  vi.advanceTimersByTime(2000);
  await flush();
  expect(f.calls.filter((c) => String(c.init?.body).includes("forget"))).toHaveLength(1);
});

it("regrant_waits_for_forget_before_sending_decision", async () => {
  // CX-High-2: 再許可の decision は forget が settle するまで送らない(forget より先に decision が届くと旧履歴で割り当てる)
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = perCallDeferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: goalsConfig, settings: baseSettings });
  await flush();
  f.calls.find((c) => c.url.includes("/event"))!.resolve({ ok: true, status: 204, json: async () => ({}) } as unknown as Response); // PAGEVIEW を settle させてから撤回(forget は in-flight goal の settle 後に送る)
  await flush();
  api.consent(false);
  await flush();
  const forget = f.calls.filter((c) => String(c.init?.body).includes("forget"))[0]!;
  const before = f.calls.length;
  api.consent(true);
  await flush();
  expect(f.calls.slice(before).filter((c) => c.url.includes("/decision"))).toHaveLength(0); // forget 未完了なので待つ
  forget.resolve({ ok: true, status: 204, json: async () => ({}) } as unknown as Response);
  await flush();
  expect(f.calls.slice(before).filter((c) => c.url.includes("/decision"))).toHaveLength(1);
});

it("revoke_stops_click_detection_and_regrant_restarts_it", async () => {
  document.body.innerHTML = `<h1 class="hero-title">orig</h1><a class="cta">buy</a>`;
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = perCallDeferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: goalsConfig, settings: baseSettings });
  await flush();
  const settle = (c: { resolve: (r: Response) => void }) => c.resolve({ ok: true, status: 204, json: async () => ({}) } as unknown as Response);
  settle(f.calls.find((c) => c.url.includes("/event"))!); // PAGEVIEW を settle
  await flush();
  api.consent(false);
  await flush();
  const before = dataLayer().length;
  document.querySelector<HTMLElement>(".cta")!.click();
  api.track("g_cta");
  expect(dataLayer()).toHaveLength(before); // denied 中は検知も push もしない(§16)
  settle(f.calls.find((c) => String(c.init?.body).includes("forget"))!); // forget を完了させてから再 grant(r2 CX-Medium-4)
  api.consent(true);
  await flush();
  expect(f.calls.filter((c) => c.url.includes("/decision"))).toHaveLength(2); // 新世代の decision が実際に送られた
  document.querySelector<HTMLElement>(".cta")!.click();
  const goalIds = () => dataLayer().filter((e) => e.event === "ab_conversion").map((e) => e.ab_goal_id);
  expect(goalIds().filter((g) => g === "g_click")).toHaveLength(1); // 撤回前 0(click していない)+ 再 grant 後 1
  expect(goalIds().filter((g) => g === "g_pv")).toHaveLength(2); // PAGEVIEW は起動ごと = 初回 + 再 grant(新しい訪問者としての開始、§16。決定 37 (4) の r1 追記)
});

it("d_lite_first_pageview_event_is_sent_after_the_decision_settles", async () => {
  // CX-High-1: D-lite の Cookie は decision 応答で発行される。PAGEVIEW は検知時に溜め、応答が settle してから /__ab/event へ送る
  const f = perCallDeferredFetch();
  createRuntime(makeDeps(f.fn), { config: goalsConfig, settings: { ...baseSettings, mode: "B" } });
  await flush();
  expect(f.calls.map((c) => c.url)).toEqual(["/__ab/decision"]); // まだ event は送らない
  expect(dataLayer().filter((e) => e.event === "ab_conversion")).toHaveLength(1); // dataLayer には即時に出る
  f.calls[0]!.resolve(f.okRes({ v: 3, experiments: [] }));
  await flush();
  expect(f.calls.map((c) => c.url)).toEqual(["/__ab/decision", "/__ab/event"]);
  expect(JSON.parse(String(f.calls[1]!.init?.body))).toEqual({ type: "goal", goalId: "g_pv" }); // Cookie が正なので visitorId は付けない
});

it("regrant_starts_goal_detection_even_if_forget_outlasts_the_decision_timeout", async () => {
  // r2 CX-High-1: forget 待ちは期限タイマーの外。decisionTimeoutMs(1000)を超えて forget が settle しても新世代は起動する
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = perCallDeferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: goalsConfig, settings: baseSettings });
  await flush();
  f.calls.find((c) => c.url.includes("/event"))!.resolve({ ok: true, status: 204, json: async () => ({}) } as unknown as Response);
  await flush();
  api.consent(false);
  await flush();
  const forget = f.calls.find((c) => String(c.init?.body).includes("forget"))!;
  api.consent(true);
  vi.advanceTimersByTime(1500); // 期限(1000)を超えて待たせる
  await flush();
  forget.resolve({ ok: true, status: 204, json: async () => ({}) } as unknown as Response);
  await flush();
  expect(f.calls.filter((c) => c.url.includes("/decision"))).toHaveLength(2); // 新世代の decision が送られた
  expect(dataLayer().filter((e) => e.event === "ab_conversion" && e.ab_goal_id === "g_pv")).toHaveLength(2); // PAGEVIEW も再発火
});

it("regrant_proceeds_after_the_forget_wait_cap_when_forget_hangs", async () => {
  // 判定 R2 / spec §16: forget は best-effort(失敗は Retention に委ねる)。通信断で forget が settle しないとき、
  // 再 grant の待ちを FORGET_WAIT_MS(2000)で打ち切り、新世代を起動する — 打ち切らないとブラウザのネットワーク
  // タイムアウトまで prehide も期限タイマーも張られないまま止まる
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = perCallDeferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: goalsConfig, settings: baseSettings });
  await flush();
  f.calls.find((c) => c.url.includes("/event"))!.resolve({ ok: true, status: 204, json: async () => ({}) } as unknown as Response); // PAGEVIEW を settle → forget は即時に出る
  await flush();
  api.consent(false);
  await flush();
  expect(f.calls.filter((c) => String(c.init?.body).includes("forget"))).toHaveLength(1); // forget は送られたが解決しない
  api.consent(true);
  await flush();
  expect(f.calls.filter((c) => c.url.includes("/decision"))).toHaveLength(1); // 上限前は待つ
  vi.advanceTimersByTime(2000); // 上限に到達
  await flush();
  expect(f.calls.filter((c) => c.url.includes("/decision"))).toHaveLength(2); // forget が hang しても新世代の decision は送られた
  expect(dataLayer().filter((e) => e.event === "ab_conversion" && e.ab_goal_id === "g_pv")).toHaveLength(2); // 検知も始まっている
});

it("d_lite_flushes_goal_events_after_a_decision_timeout", async () => {
  // r2 CX-High-1: D-lite の decision が期限で abort されても Goal の送信は始まる(以後の CLICK も溜まらない)
  document.body.innerHTML = `<h1 class="hero-title">orig</h1><a class="cta">buy</a>`;
  const f = perCallDeferredFetch();
  createRuntime(makeDeps(f.fn), { config: goalsConfig, settings: { ...baseSettings, mode: "B" } });
  await flush();
  expect(f.calls.map((c) => c.url)).toEqual(["/__ab/decision"]);
  vi.advanceTimersByTime(1000); // 期限到達 → abort(スタブは signal に反応しないので、期限後の応答を手で届ける)
  f.calls[0]!.resolve(f.okRes({ v: 3, experiments: [] }));
  await flush();
  expect(document.getElementById("__ab_prehide")).toBeNull(); // 期限で元表示(§10.3)
  expect(f.calls.map((c) => c.url)).toEqual(["/__ab/decision", "/__ab/event"]); // 期限後の応答は捨てるが、溜めていた PAGEVIEW は送る
  document.querySelector<HTMLElement>(".cta")!.click();
  expect(f.calls.map((c) => c.url)).toEqual(["/__ab/decision", "/__ab/event", "/__ab/event"]); // 以後は即時
});

it("track_before_identity_is_forwarded_once_after_identity", async () => {
  // CX-High-1: 起動直後(Identity 確立前)の AB.track も落とさず、確立後に同じ visitorId で 1 回だけ送る
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = perCallDeferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: goalsConfig, settings: baseSettings });
  api.track("g_cta"); // establishIdentity の await より前
  await flush();
  const events = f.calls.filter((c) => c.url.includes("/event")).map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);
  expect(events).toEqual([{ type: "goal", goalId: "g_cta", visitorId: VB }, { type: "goal", goalId: "g_pv", visitorId: VB }]); // 検知順(track が先)
  expect(dataLayer().filter((e) => e.event === "ab_conversion")).toHaveLength(2);
});

it("boot payload rejects a non-boolean forgetOnRevoke (fail-closed like the other settings)", async () => {
  const f = deferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: baseConfig, settings: { ...baseSettings, forgetOnRevoke: "no" as unknown as boolean } });
  await flush();
  expect(api.getAssignments()).toEqual({});
  expect(document.cookie).toBe("");
});

it("passes the runtime nonce to prehide / injected <style> and the variantId to the engine (decision 38)", async () => {
  // CSS Change だけの Variant を持つ config(vB 100%): prehide と注入した <style> に nonce、<style> に variant が付き、注入時に Exposure
  const cssConfig: CompiledConfig = {
    ...baseConfig,
    prehide: { exp_hero: [".hero-title"] },
    exposureSelectors: { exp_hero: [".hero-title", ":root"] },
    experiments: [{ ...baseConfig.experiments[0]!, variants: [
      { id: "vA", name: "A", weight: 0, changes: [] },
      { id: "vB", name: "B", weight: 100, changes: [{ id: "c_css", type: "CSS", payload: { css: ".hero-title{color:red}" } }] },
    ] }],
  };
  const seenPrehideNonce: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const r of records) for (const n of Array.from(r.addedNodes)) if ((n as Element).id === "__ab_prehide") seenPrehideNonce.push((n as Element).getAttribute("nonce") ?? "");
  });
  observer.observe(document.head, { childList: true });
  const f = perCallDeferredFetch();
  createRuntime(makeDeps(f.fn, "n-runtime"), { config: cssConfig, settings: baseSettings });
  await flush();
  observer.disconnect();
  expect(seenPrehideNonce).toEqual(["n-runtime"]); // prehide の <style> にも nonce(style-src の CSP)
  const st = document.head.querySelector("style[data-ab-change='c_css']")!;
  expect(st).not.toBeNull();
  expect(st.getAttribute("nonce")).toBe("n-runtime");
  expect(st.getAttribute("data-ab-experiment")).toBe("exp_hero");
  expect(st.getAttribute("data-ab-variant")).toBe("vB");
  expect(dataLayer().filter((e) => e.event === "ab_exposure").map((e) => e.ab_variant_id)).toEqual(["vB"]); // 注入時に Exposure
  st.remove(); // 次のテストに残さない
});

it("code_changes_do_not_rerun_after_regrant", async () => {
  // spec §10.4(ページ読込ごとに 1 回)+ §16(再許可は Exposure を再発火): 撤回 → 再許可の新世代で HTML(replace で selector が消える)は
  // 二重適用されず、<style> は 1 枚のまま、CUSTOM_JS は再試行されず、Exposure は 2 件目が出る(r1 CX-High-1 / CL-High-3、r2 CX-High-1)
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  const codeConfig: CompiledConfig = {
    ...baseConfig,
    prehide: { exp_hero: [".hero-title"] },
    exposureSelectors: { exp_hero: [".hero-title", ":root"] },
    experiments: [{ ...baseConfig.experiments[0]!, variants: [
      { id: "vA", name: "A", weight: 0, changes: [] },
      { id: "vB", name: "B", weight: 100, changes: [
        { id: "c_js", type: "CUSTOM_JS", selector: ".hero-title", payload: { code: "1" } }, // 既定環境では登録が取れず失敗 → debug 1 回(c_html より先に試行させる)
        { id: "c_html", type: "HTML", selector: ".hero-title", payload: { html: "<h2 class=\"changed\">B</h2>", position: "replace", runScripts: false } }, // 適用後は .hero-title が消える
        { id: "c_css", type: "CSS", payload: { css: ".x{}" } },
      ] },
    ] }],
  };
  const f = perCallDeferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: codeConfig, settings: baseSettings });
  await flush();
  expect(document.querySelectorAll(".changed")).toHaveLength(1);
  expect(document.querySelectorAll(".hero-title")).toHaveLength(0); // replace で selector は DOM から消えた
  expect(document.head.querySelectorAll("style[data-ab-change='c_css']")).toHaveLength(1);
  expect(debug.mock.calls.filter((c) => c[0] === "wtt: custom js failed")).toHaveLength(1);
  expect(dataLayer().filter((e) => e.event === "ab_exposure")).toHaveLength(1);

  api.consent(false);
  await flush();
  // B53: needsProfile=false でも撤回で forget を送り、新世代はその settle を待つ
  f.calls.find((c) => String(c.init?.body).includes("forget"))!.resolve({ ok: true, status: 204, json: async () => ({}) } as unknown as Response);
  api.consent(true);
  await flush();
  expect(document.querySelectorAll(".changed")).toHaveLength(1); // 二重適用しない
  expect(document.head.querySelectorAll("style[data-ab-change='c_css']")).toHaveLength(1); // 1 枚のまま
  expect(debug.mock.calls.filter((c) => c[0] === "wtt: custom js failed")).toHaveLength(1); // 再試行しない
  expect(dataLayer().filter((e) => e.event === "ab_exposure")).toHaveLength(2); // 新しい訪問者として再発火(§16)。selector が消えていても succeeded から出る
  document.head.querySelector("style[data-ab-change='c_css']")?.remove();
  debug.mockRestore();
});

it("decision の body に browser / os / firstVisitAt を入れ、viewport は meta があるときだけ送る(決定 49 §9 / §11)", async () => {
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = deferredFetch();
  createRuntime(makeDeps(f.fn), { config: remoteConfig, settings: baseSettings });
  await flush();
  const body = JSON.parse(String(f.calls[0]!.init!.body)) as Record<string, unknown>;
  expect(body).toMatchObject({ visitorId: VB, firstVisitAt: null }); // VB は v4 = 発行時刻が不明
  expect(typeof body.browser).toBe("string");
  expect(typeof body.os).toBe("string");
  expect("viewport" in body).toBe(false); // happy-dom の文書には viewport の meta が無い

  const meta = document.createElement("meta");
  meta.name = "viewport";
  meta.content = "width=device-width";
  document.head.appendChild(meta);
  try {
    const g = deferredFetch();
    createRuntime(makeDeps(g.fn), { config: remoteConfig, settings: baseSettings });
    await flush();
    expect(JSON.parse(String(g.calls[0]!.init!.body)).viewport).toEqual({ w: window.innerWidth, h: window.innerHeight });
  } finally {
    meta.remove();
  }
});

it("mode_c_does_not_send_reference_id", async () => {
  // 決定 49 §7.4: Mode C は参考用の _ab_vid を持つが、decision の body には ID を入れず発行時刻(firstVisitAt)だけを送る
  document.cookie = `_ab_vid=${VB}; Path=/`;
  document.cookie = "_site_session=sess-1; Path=/";
  vi.useRealTimers(); // BYOID のハッシュ(crypto.subtle)はマイクロタスクの外で解決するので、偽のタイマーでは待てない
  const f = deferredFetch();
  createRuntime(makeDeps(f.fn), { config: remoteConfig, settings: { ...baseSettings, idSource: "cookie:_site_session" } });
  await vi.waitFor(() => expect(f.calls.length).toBe(1));
  const raw = String(f.calls[0]!.init!.body);
  expect(JSON.parse(raw).visitorId).toBe(await hashByoidValue("salt", "sess-1"));
  expect(raw).not.toContain(VB);
  expect(JSON.parse(raw).firstVisitAt).toBeNull();
});

it("revoke_deletes_reference_ab_vid", async () => {
  // Mode C の撤回は参考用の _ab_vid を消す(サイトの BYOID Cookie には触れない)
  document.cookie = "_site_session=sess-1; Path=/";
  vi.useRealTimers(); // 同上(BYOID のハッシュ)
  const f = deferredFetch();
  const api = createRuntime(makeDeps(f.fn), { config: baseConfig, settings: { ...baseSettings, idSource: "cookie:_site_session" } });
  await vi.waitFor(() => expect(api.getAssignments()).not.toEqual({}));
  expect(document.cookie).toContain("_ab_vid=");
  api.consent(false);
  await flush();
  expect(document.cookie).not.toMatch(/_ab_vid=[^;]/);
  expect(document.cookie).toContain("_site_session=sess-1");
});

it("static_bootstrap_uses_baked_api_base", async () => {
  // 決定 52 (7): ドメインなし構成では設置タグ(配信専用の Worker)と edge が別ホスト。decision も event も焼き込んだ apiBase に送る
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = perCallDeferredFetch();
  createRuntime(makeDeps(f.fn), { config: goalsConfig, settings: baseSettings, apiBase: "https://api.example" });
  await flush();
  expect(f.calls.find((c) => c.url.includes("/decision"))!.url).toBe(`https://api.example/v1/sites/${goalsConfig.siteId}/decision`);
  expect(f.calls.find((c) => c.url.includes("/event"))!.url).toBe(`https://api.example/v1/sites/${goalsConfig.siteId}/event`);
});

it("apiBase が無い bootstrap(古い焼き方)は今までどおり設置タグの src から宛先を作る", async () => {
  document.cookie = `_ab_vid=${VB}; Path=/`;
  const f = deferredFetch();
  createRuntime(makeDeps(f.fn), { config: remoteConfig, settings: baseSettings });
  await flush();
  expect(f.calls[0]!.url).toBe(`https://edge.test/v1/sites/${remoteConfig.siteId}/decision`);
});
