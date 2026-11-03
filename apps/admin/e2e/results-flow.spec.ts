import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type APIRequestContext, type Page, type Request, type TestInfo } from "@playwright/test";
import { pickVariant, uuidToVisitorId } from "@wtt/core";
import { appAlert, changeStatus, controlHeaders, createExperiment, createSite, E2E_REGISTRY_DIR, e2eLogDir, EDGE_URL, login, pick, waitForHydration } from "./fixtures";

/**
 * D9 ③(plan ③ の Task 17・K26、設計書 §17): テストの結果の流れを、空の状態から画面で通す。
 * 結果を記録する Site → 目標 → 評価計画(開始の前の止め・未保存の入力の保持と離脱の確認)→ 開始(固定する内容の確認)→
 * edge の `/v1/sites/:id/event`(Mode A)に参加と CV を送る → 結果のタブの人数 → 終了のモーダルで B を採用 + B だけの下書き →
 * 一覧の採用の要約 → 終了したテストのメモと採用の記録し直し。ほかに説明(「?」)のキーボード操作とパネル。
 *
 * - edge は割り当てと違う参加を捨てるので、送る参加のパターンは `@wtt/core` の割り当ての関数(pickVariant)で訪問者 ID ごとに計算する
 * - edge は Site の設定・公開中の版を isolate に 60 秒持つので、この Site で edge に最初に触れるのは開始(公開)の後
 * - control は結果の速報を 5 分保存するので、結果を最初に読む(結果のタブ・終了のモーダル)のはすべて送った後
 * - edge の `/v1/*` は IP あたり 20 req / 10 秒。送るのは参加 8 + CV 4 = 12 件(429 なら 10 秒待って送り直す)
 * - 評価計画の日付はサイトのタイムゾーンで出す(設計書 §5.3)。ブラウザ(UTC−11)とサイト(UTC+14)を 25 時間離して、日付が必ず食い違うようにする
 *
 * ログインは最初の 1 回だけにして、同じページを引き回す(fixtures.ts の sign-in の予算)
 */

const SITE_FLOW = { id: "site_e2e_rflow", name: "E2E Results Flow" };
const EXP = { id: "exp_e2e_rflow", name: "E2E results flow" };
const GOAL = { id: "g_rflow_buy", name: "購入完了" };
/** サイトのタイムゾーン(UTC+14)とブラウザのタイムゾーン(UTC−11) */
const SITE_TZ = "Pacific/Kiritimati";
const BROWSER_TZ = "Pacific/Pago_Pago";
/** サイトのドメイン localhost の既定の allowedOrigins(control が `https://<domain>` で作る) */
const ORIGIN = "https://localhost";
/** 送る参加と CV(パターン ID → [参加, CV]) */
const PLAN_COUNTS: Record<string, { n: number; y: number }> = { a: { n: 4, y: 1 }, b: { n: 4, y: 3 } };

type Json = Record<string, unknown>;

/** 管理画面の BFF 経由で control を呼ぶ(ログイン中の Cookie を使う)。準備と読み取りだけに使い、確かめる操作は画面で行う */
async function control(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: Json | null }> {
  return page.evaluate(
    async ([m, p, b, h]) => {
      const r = await fetch(`/api/control${p}`, { method: m, headers: b === undefined ? h : { "content-type": "application/json", ...h }, body: b === undefined ? undefined : JSON.stringify(b) });
      const text = await r.text();
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = null;
      }
      return { status: r.status, json };
    },
    [method, path, body, controlHeaders()] as const,
  );
}

/** edge へ結果のイベントを 1 件送る(Mode A のブラウザ直接経路と同じ形。Origin は Site の allowedOrigins)。429 は 10 秒待って送り直す */
async function sendEvent(request: APIRequestContext, body: Json): Promise<Json> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await request.post(`${EDGE_URL}/v1/sites/${SITE_FLOW.id}/event`, { headers: { Origin: ORIGIN, "content-type": "application/json" }, data: body });
    if (res.status() === 429) {
      await new Promise((r) => setTimeout(r, 10_500));
      continue;
    }
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as Json;
  }
  throw new Error("edge kept answering 429");
}

/** 割り当てがそのパターンになる訪問者 ID を n 人分(edge と同じ pickVariant で計算する) */
function visitorsFor(exp: Parameters<typeof pickVariant>[0], variantId: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < 10_000 && out.length < n; i++) {
    const id = uuidToVisitorId(randomUUID())!;
    if (pickVariant(exp, id) === variantId) out.push(id);
  }
  if (out.length < n) throw new Error(`no visitors for ${variantId}`);
  return out;
}

/** dev registry の登録(ファイル名と中身)と control のログの末尾を、失敗の添付にする(結果の読み取りの失敗の調査用) */
async function attachDevDiagnostics(info: TestInfo): Promise<void> {
  const read = (fn: () => string): string => {
    try {
      return fn();
    } catch (e) {
      return `(unreadable: ${String(e)})`;
    }
  };
  const registry = read(() =>
    readdirSync(E2E_REGISTRY_DIR)
      .map((f) => `## ${f}\n${readFileSync(join(E2E_REGISTRY_DIR, f), "utf8")}`)
      .join("\n\n") || "(empty)",
  );
  await info.attach("dev-registry", { body: `${E2E_REGISTRY_DIR}\n\n${registry}`, contentType: "text/plain" });
  const controlLog = read(() => {
    const dir = e2eLogDir("control");
    const latest = readdirSync(dir)
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    if (!latest) return "(no log)";
    return `${latest}\n\n${readFileSync(latest, "utf8").split("\n").slice(-400).join("\n")}`;
  });
  await info.attach("control-log-tail", { body: controlLog, contentType: "text/plain" });
}

const statusPosts = (page: Page, experimentId: string) => {
  const posts: string[] = [];
  const on = (r: Request) => {
    if (r.method() === "POST" && r.url().includes(`/experiments/${experimentId}/status`)) posts.push(r.url());
  };
  page.on("request", on);
  return { posts, off: () => page.off("request", on) };
};

test.describe.serial("results flow (D9 ③)", () => {
  let page: Page;
  let siteUrl: string;
  /** 終了のモーダルで作った下書きの ID */
  let createdId = "";
  const openExperiment = async (id: string, tab?: string) => {
    await page.goto(`${siteUrl}/experiments/${id}${tab ? `?tab=${tab}` : ""}`);
    await waitForHydration(page);
  };

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ timezoneId: BROWSER_TZ });
    await login(page);
  });
  test.afterAll(async () => {
    await page.close();
  });

  test("a recording site, a goal and a test with a change in B", async () => {
    await createSite(page, SITE_FLOW, { results: true });
    siteUrl = page.url();
    // 準備(画面の確かめの対象ではない): サイトのタイムゾーン・目標・B の変更
    expect((await control(page, "PATCH", `/sites/${SITE_FLOW.id}`, { timezone: SITE_TZ })).status).toBe(200);
    expect((await control(page, "POST", `/sites/${SITE_FLOW.id}/goals`, { id: GOAL.id, name: GOAL.name, type: "CUSTOM", config: {} })).status).toBe(201);
    await page.reload();
    await waitForHydration(page);
    await createExperiment(page, EXP);
    expect((await control(page, "PUT", `/sites/${SITE_FLOW.id}/experiments/${EXP.id}/variants/b/changes`, [{ id: "c1", type: "TEXT", selector: ".hero-title", payload: { text: "結果 B" } }])).status).toBe(200);
    const site = (await control(page, "GET", `/sites/${SITE_FLOW.id}`)).json!;
    expect(site.resultsEnabled).toBe(true);
  });

  test("start_is_blocked_until_the_plan_has_a_goal", async () => {
    await openExperiment(EXP.id);
    // 結果のタブは下書きでは押せない
    await expect(page.getByRole("tab", { name: /^結果/ })).toBeDisabled();
    const { posts, off } = statusPosts(page, EXP.id);
    try {
      await page.getByRole("button", { name: "開始(公開して配信を始める)" }).click();
      await expect(appAlert(page).filter({ hasText: "評価計画のタブで判定に使う目標を選んでください" })).toBeVisible();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      expect(posts).toHaveLength(0);
    } finally {
      off();
    }
  });

  test("help_tip_keyboard_and_panel", async () => {
    await page.getByRole("tab", { name: "評価計画" }).click();
    const planTip = page.getByRole("button", { name: "評価計画とは" });
    const pop = page.getByTestId("help-pop");
    const panel = page.getByTestId("help-panel");
    // キーボードで「?」を開く → aria-expanded が true・吹き出しは dialog・フォーカスは「詳しく読む」
    await planTip.focus();
    await page.keyboard.press("Enter");
    await expect(planTip).toHaveAttribute("aria-expanded", "true");
    await expect(pop).toBeVisible();
    await expect(pop).toHaveAttribute("role", "dialog");
    await expect(page.getByRole("dialog")).toHaveCount(1); // 吹き出しは dialog として名前(項目の見出し)を持つ
    await expect(pop.getByRole("button", { name: /^詳しく読む/ })).toBeFocused();
    // Esc で閉じて起点にフォーカスが戻る
    await page.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);
    await expect(planTip).toHaveAttribute("aria-expanded", "false");
    await expect(planTip).toBeFocused();
    // 「詳しく読む」でパネルが開き、該当の項目に送られる
    await page.keyboard.press("Enter");
    await pop.getByRole("button", { name: /^詳しく読む/ }).click();
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-help-item="plan"]')).toHaveAttribute("aria-current", "true");
    await expect(panel.getByRole("button", { name: "閉じる" })).toBeFocused();
    // パネルを開いたまま別の「?」を開き、Esc で吹き出しだけを閉じる(パネルは閉じない)
    const evalTip = page.getByRole("button", { name: "評価時点の決まり方" });
    await evalTip.focus();
    await page.keyboard.press("Enter");
    await expect(evalTip).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);
    await expect(evalTip).toBeFocused();
    await expect(panel).toBeVisible();
    // パネルを閉じると、パネルを開いた「?」にフォーカスが戻る
    await panel.getByRole("button", { name: "閉じる" }).click();
    await expect(panel).toHaveCount(0);
    await expect(planTip).toBeFocused();
  });

  test("unsaved_plan_input_survives_a_tab_switch_guards_leaving_and_saves_with_the_bar", async () => {
    // B173 第 1 段(Q12): 評価計画は下の帯の「保存(下書き)」で、本体(ここではメモ)と一緒に保存する。評価計画のタブに保存のボタンは無い。
    // 評価計画のタブで入力(未保存)→ 基本設定のタブでメモを入力 → 評価計画の入力が残っている
    await pick(page, "判定に使う目標", new RegExp(`^${GOAL.name}`));
    await page.getByRole("spinbutton", { name: "最大期間", exact: true }).fill("9");
    await expect(page.getByRole("button", { name: "評価計画を保存" })).toHaveCount(0);
    await page.getByRole("tab", { name: "基本設定" }).click();
    await page.getByRole("textbox", { name: /^メモ/ }).fill("結果の E2E");
    await expect(page.getByTestId("plan-unsaved")).toHaveText("評価計画は保存した時点で反映されます(公開は不要)");
    await page.getByRole("tab", { name: "評価計画" }).click();
    await expect(page.getByRole("spinbutton", { name: "最大期間", exact: true })).toHaveValue("9");
    await expect(page.getByRole("combobox", { name: "判定に使う目標", exact: true })).toContainText(GOAL.name);
    // 画面の中の移動は確認する(「とどまる」なら移らない。B173 第 1 段の PageLeaveGuard)
    await page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "目標" }).click();
    const leave = page.getByRole("alertdialog", { name: "保存していない変更があります" });
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "とどまる", exact: true }).click();
    await expect(leave).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/experiments/${EXP.id}`));
    // 帯の「保存(下書き)」で、メモの PATCH と評価計画の PUT を 1 回ずつ送る
    const patched = page.waitForResponse((r) => r.url().includes(`/experiments/${EXP.id}`) && r.request().method() === "PATCH");
    const put = page.waitForResponse((r) => r.url().includes(`/experiments/${EXP.id}/evaluation-plan`) && r.request().method() === "PUT");
    await page.getByRole("button", { name: "保存(下書き)" }).click();
    expect((await patched).status()).toBe(200);
    expect((await put).status()).toBe(200);
    await expect(page.getByTestId("save-state")).toHaveText("保存しました。評価計画は反映済みです");
    await expect(page.getByTestId("plan-unsaved")).toHaveCount(0);
    await expect(page.getByRole("spinbutton", { name: "最大期間", exact: true })).toHaveValue("9");
  });

  test("start_shows_the_fixed_plan_and_starts", async () => {
    const { posts, off } = statusPosts(page, EXP.id);
    try {
      await page.getByRole("button", { name: "開始(公開して配信を始める)" }).click();
      const dialog = page.getByRole("alertdialog", { name: "開始して評価計画を固定しますか?" });
      await expect(dialog).toBeVisible();
      const fixed = dialog.getByTestId("start-fixed");
      await expect(fixed).toContainText(`判定に使う目標${GOAL.name}`);
      await expect(fixed).toContainText("基準A");
      await expect(fixed).toContainText("最低 14 日・最大 9 週");
      await expect(fixed).toContainText("上回る確率 95% 以上");
      expect(posts).toHaveLength(0); // 確認の前には送らない
      const done = page.waitForResponse((r) => r.url().includes(`/experiments/${EXP.id}/status`) && r.request().method() === "POST");
      await dialog.getByRole("button", { name: "開始する", exact: true }).click();
      const res = await done;
      expect(res.status()).toBe(200);
      expect(((await res.json()) as { publish: { ok: boolean } }).publish.ok).toBe(true);
      await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "running");
      expect(posts).toHaveLength(1);
    } finally {
      off();
    }
  });

  test("plan_dates_are_shown_in_the_site_timezone", async () => {
    await openExperiment(EXP.id, "plan");
    const times = page.getByTestId("plan-timeline").locator("time");
    await expect(times).toHaveCount(3);
    for (const t of await times.all()) {
      const at = Date.parse((await t.getAttribute("datetime"))!);
      const inSite = new Date(at).toLocaleDateString("ja-JP", { timeZone: SITE_TZ });
      await expect(t).toHaveText(inSite);
      // ブラウザのタイムゾーンとは 25 時間離れているので、必ず違う日付になる(= サイトのタイムゾーンで描いている)
      expect(new Date(at).toLocaleDateString("ja-JP", { timeZone: BROWSER_TZ })).not.toBe(inSite);
    }
  });

  test("participants_and_conversions_sent_to_the_edge_appear_in_the_results_tab", async () => {
    const exp = (await control(page, "GET", `/sites/${SITE_FLOW.id}/experiments/${EXP.id}`)).json as { runId: string | null; variants: Array<{ id: string; weight: number }> };
    expect(exp.runId).not.toBeNull();
    const assignment = { id: EXP.id, variants: exp.variants.map((v) => ({ id: v.id, weight: v.weight })) } as unknown as Parameters<typeof pickVariant>[0];
    for (const [variantId, { n, y }] of Object.entries(PLAN_COUNTS)) {
      const visitors = visitorsFor(assignment, variantId, n);
      for (const [i, visitorId] of visitors.entries()) {
        expect(await sendEvent(page.request, { type: "participant", v: 1, runId: exp.runId, variantId, device: "desktop", applied: "ok", visitorId })).toEqual({ result: "stored" });
        if (i < y) {
          const cv = await sendEvent(page.request, { type: "conversion", v: 1, goalId: GOAL.id, runIds: [exp.runId], visitorId });
          expect(cv).toMatchObject({ result: "stored", runs: { [exp.runId!]: { result: "stored" } } });
        }
      }
    }
    // 結果のタブ(速報)の人数が送った数と合う
    await openExperiment(EXP.id);
    await page.getByRole("tab", { name: /^結果/ }).click();
    // 注意(E2E だけの事情): control の結果の読み取りは、予算の Durable Object(edge の Worker が持つ)を wrangler dev の別プロセスから
    // dev registry 経由で呼ぶ(本番は同じアカウントの Worker どうしの binding なのでこの経路は無い)。この経路が切れていると
    // 結果のタブが「結果を読めませんでした」になり、ここで落ちる。再試行はしない(落ちたら落ちたまま)。原因を追えるよう、
    // 落ちたときは dev registry の中身と control のログの末尾を添付する
    try {
      await expect(page.getByTestId("results-tab")).toBeVisible();
    } catch (e) {
      await attachDevDiagnostics(test.info());
      throw e;
    }
    for (const [variantId, { n, y }] of Object.entries(PLAN_COUNTS)) {
      await expect(page.getByTestId(`results-card-${variantId}`)).toContainText(`${n} 人中 ${y} 人`);
    }
  });

  test("pause_and_resume_keep_the_recording_run", async () => {
    // 記録中のテストの一時停止 → 再開(どちらも公開を伴う)。再開では run_id を振り直さない(同じ記録を続ける)
    const runIdOf = async () => ((await control(page, "GET", `/sites/${SITE_FLOW.id}/experiments/${EXP.id}`)).json as { runId: string | null }).runId;
    const runId = await runIdOf();
    expect(runId).not.toBeNull();
    expect((await changeStatus(page, SITE_FLOW.id, EXP.id, "一時停止")).publish.ok).toBe(true);
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "paused");
    expect((await changeStatus(page, SITE_FLOW.id, EXP.id, "再開")).publish.ok).toBe(true);
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "running");
    expect(await runIdOf()).toBe(runId);
  });

  test("stop_adopts_b_and_lands_on_the_new_draft", async () => {
    await page.getByRole("button", { name: "終了して結果を記録", exact: true }).click();
    const dialog = page.getByRole("alertdialog", { name: "終了して結果を記録します" });
    await expect(dialog.getByTestId("stop-options")).toBeVisible();
    await dialog.getByRole("radio", { name: /^B を採用/ }).check();
    await dialog.getByLabel("メモ(任意)").fill("B の文言が良い");
    await dialog.getByTestId("stop-duplicate").getByRole("checkbox", { name: "B だけを表示する新しいエクスペリエンスも作成する(下書き)" }).check();
    const stopped = page.waitForResponse((r) => r.url().includes(`/experiments/${EXP.id}/status`) && r.request().method() === "POST");
    const duplicated = page.waitForResponse((r) => r.url().includes(`/experiments/${EXP.id}/duplicate`) && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "終了して記録" }).click();
    const stopRes = await stopped;
    expect(stopRes.status()).toBe(200);
    expect(stopRes.request().postDataJSON()).toMatchObject({ status: "archived", adoption: { variantId: "b", note: "B の文言が良い" } });
    expect(((await stopRes.json()) as { results?: { recorded: boolean } }).results).toEqual({ recorded: true });
    const dupRes = await duplicated;
    expect(dupRes.status()).toBe(201);
    expect(dupRes.request().postDataJSON()).toMatchObject({ mode: "variant", variantId: "b" });
    // 公開と記録が済んで下書きを作れたので、その下書きの概要に移る(全画面の遷移なので、応答の本文はもう読めない。ID は URL から取る)
    await page.waitForURL((u) => /\/experiments\/[^/]+$/.test(u.pathname) && !u.pathname.endsWith(`/experiments/${EXP.id}`));
    createdId = new URL(page.url()).pathname.split("/").pop()!;
    await waitForHydration(page);
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "draft");
    await expect(page.getByTestId("experiment-kind")).toHaveText("パーソナライズ");
    await expect(page.getByRole("tab", { name: "基本設定" })).toHaveAttribute("aria-selected", "true");
    // 一覧の採用の要約
    await page.goto(siteUrl); // サイトの画面 = エクスペリエンスの一覧
    await expect(page.getByTestId(`experiment-row-${createdId}`)).toContainText("B だけを表示"); // 作った下書き(名前は「<元の名前>(B だけを表示)」)
    await expect(page.getByTestId(`experiment-adoption-${EXP.id}`)).toHaveText(/^採用: B\(.+上回る確率 .+\)$/);
  });

  test("archived_test_keeps_memo_editable_and_name_read_only", async () => {
    await openExperiment(EXP.id);
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "archived");
    await expect(page.getByRole("textbox", { name: "名前(100 字以内)" })).toBeDisabled();
    const memo = page.getByRole("textbox", { name: /^メモ/ });
    await expect(memo).toBeEditable();
    await memo.fill("結果の E2E(終了後のメモ)");
    const saved = page.waitForResponse((r) => r.url().includes(`/experiments/${EXP.id}`) && r.request().method() === "PATCH");
    await page.getByRole("button", { name: "保存(下書き)" }).click();
    const res = await saved;
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ description: "結果の E2E(終了後のメモ)" });
    await page.reload();
    await waitForHydration(page);
    await expect(page.getByRole("textbox", { name: /^メモ/ })).toHaveValue("結果の E2E(終了後のメモ)");
  });

  test("adoption_can_be_changed_after_the_stop", async () => {
    await openExperiment(EXP.id, "results");
    const adoption = page.getByTestId("results-adoption");
    await expect(adoption).toContainText("B の文言が良い");
    await expect(adoption.getByTestId("results-adopt")).toHaveText("採用を変更");
    await adoption.getByTestId("results-adopt").click();
    const dialog = page.getByRole("alertdialog", { name: "採用を記録します" });
    await dialog.getByRole("radio", { name: /^採用なし/ }).check();
    await dialog.getByLabel("メモ(任意)").fill("今回は見送る");
    const put = page.waitForResponse((r) => r.url().includes(`/experiments/${EXP.id}/adoption`) && r.request().method() === "PUT");
    await dialog.getByRole("button", { name: "採用を記録" }).click();
    const res = await put;
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ variantId: null, note: "今回は見送る" });
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("results-adoption")).toContainText("今回は見送る");
    await page.goto(siteUrl); // サイトの画面 = エクスペリエンスの一覧
    await expect(page.getByTestId(`experiment-adoption-${EXP.id}`)).toHaveText("採用なし");
  });
});
