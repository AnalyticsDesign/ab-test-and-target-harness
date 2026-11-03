import { test, expect, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import { ADMIN_URL, CONTROL_URL, WORKSPACE_NAME, controlHeaders, createExperiment, createSite, login, waitForHydration } from "./fixtures";

/**
 * 管理画面の速さ: 主な画面を 1 回表示するたびに、admin から control への問い合わせ(lib/control.ts の controlRequest。E2E でも本番と同じ
 * service binding)が何回起きるかを数え、画面ごとの上限を超えたら落とす。
 *
 * 目的: 管理画面は複数の人が同時に使う前提で、control への往復 1 回ごとに subrequest・D1 の往復・Worker の CPU(Workers Free は 1 回 10 ms)が掛かる。
 * 1 画面の往復が増えたことを、deploy の前に毎回検知する。経緯: plan12 で control の呼び出しを service binding に替えたことで vinext の
 * 同じ GET のまとめが外れ、1 画面で約 20 回の往復と CPU の超過(exceededResources)になって、気づくまで 9 日かかった。
 *
 * 対象の画面(SCREENS): ホーム・ワークスペースのホーム・サイトのトップ(= エクスペリエンスの一覧)・目標・オーディエンスの一覧・
 * エクスペリエンスの詳細・オーディエンスの詳細(設定)・サイト設定・メンバー(ワークスペースの設定)・公開・公開履歴。
 * B148: サイト設定のドメインの節(siteSettingsDomains)は、直接(?section=domains)・節のリンク・節の保存 1 回を SCREENS の外で数える(節の切り替えはルーターを通らない)。
 * 目標には詳細の画面が無い(一覧の中で編集する)ので、目標の一覧で代える。画面ごとに次の 2 通りを数える:
 * - 直接: page.goto で URL を開く(HTML の要求)
 * - 遷移: 遷移元の画面を開き、落ち着いてからリンクにマウスを乗せ、その先読みも落ち着いてから押す(RSC の要求 `?_rsc=`)。
 *   遷移元を開いた後〜落ち着くまでの分(表示の後の先読みなど)と、マウスを乗せたときの先読みの分は別に数えて記録だけする
 * ほかに、一覧を開いて何もしない間の要求(IDLE_LIMITS)と、エクスペリエンスの保存 1 回(SAVE_LIMITS。別の test
 * 「experience save: one write and one refresh …」)を数える。保存の test は、押してから落ち着くまでの窓の admin への要求を
 * 書き込み・読み直し・許したもの(SAVE_ALLOWED)に分け、それ以外の要求が無いことも表明する
 *
 * 数え方: admin の wrangler dev の手元の観測(`/cdn-cgi/local/explorer/api/local/observability/query`。wrangler が起動時のログに案内する、
 * 読み取りだけの SQL の口)を読む。admin への要求 1 件ごとに根の span があり、その中で control へ出した要求が子の fetch の span
 * (url.full が control の URL)として同じ trace_id に残るので、「どの画面の要求が control を何回呼んだか」が分かる。
 * admin・control のコードは変えない(本番の挙動に影響しない)。wrangler のログ(WRANGLER_LOG_PATH)には要求ごとの行が出ないので使えない(実測)。
 * wrangler の版が変わって観測の口が消える・子の span が出なくなると、すべての数が 0 になり上限の表明が素通りするので、
 * 準備の段と、画面ごとの直接・遷移の数で「数が 0 より大きい」ことを表明して落とす(保険。最終レビュー CX-R2)。
 *
 * 表明するのは**対象の画面そのものの要求**(その画面の URL への HTML / RSC の要求)が呼んだ分で、画面ごとに
 * (1) 合計が上限以下、(2) 同じパスへの重複が無い(lib/control-dedupe.ts のまとめが効いている)。表示の後に画面の JS が出す要求
 * (ほかのリンクの先読み・BFF の /api/control/*)は記録だけする。表明は soft にし、ある画面が上限を超えても・操作で落ちても
 * 残りの画面まで数えて、全画面の数を 1 回の実行で出す(最後に表 `summary` を標準出力と添付に残す)。
 *
 * 余裕の付け方: 上限 = 直した後の実測(request-count を 3 回走らせたときの最大)+ 1。数は毎回同じ(揺れない)ことを 3 回で確かめてある。
 * 「+ 1」は観測の誤差のためではなく、無関係な小さな変更で毎回上限を上げずに済むための幅。2 増えたら落ちる。
 *
 * 上限を上げるときの手順(REQUEST_LIMITS・IDLE_LIMITS・SAVE_LIMITS の値を変える前、SAVE_ALLOWED に足す前に必ず):
 * 1. 先に減らせないかを確かめる: 同じ GET は 1 回の描画の中で lib/control-dedupe.ts がまとめる(controlRequest を通していれば効く)。
 *    互いに依らない取得は lib/loaders.ts の allInOrder で並べる(回数は減らないが直列の待ちが減る)。新しい呼び方で controlRequest を迂回していないか
 * 2. それでも増えるなら、増える理由(どの画面で、どの control の呼び出しが、なぜ要るか)を、上げる値の横のコメントと commit の本文に書いてから上げる
 * 3. 規則と背景はリポジトリの CLAUDE.md の「性能と同時利用」を参照
 */

/** 画面の名前(REQUEST_LIMITS と SCREENS の鍵) */
type ScreenName =
  | "home"
  | "workspace"
  | "siteTop"
  | "goals"
  | "audiences"
  | "experiment"
  | "audience"
  | "siteSettings"
  | "siteSettingsDomains"
  | "members"
  | "publish"
  | "history";

/**
 * 回数の上限(画面ごと。直す側が変えやすいよう 1 か所に置く)。値 = 実測 + 1(余裕の付け方はファイルの先頭)。
 * direct = page.goto で開いたときの、その HTML の要求が control を呼ぶ回数 / navigation = リンクで移ったときの、その RSC の要求が呼ぶ回数(先読みの分を除く)。
 * 実測の値は各画面の添付(request-counts-*)と、最後の表(summary)に残る
 */
export const REQUEST_LIMITS: Record<ScreenName, { direct: number; navigation: number }> = {
  // 実測(2026-10-30。直接 / 遷移)の後ろに書く。共通の 3〜4 回 = 外枠の /me・/workspaces/summary・/capabilities(+ サイトの下は /sites/:sid)
  home: { direct: 4, navigation: 4 }, // 実測 3 / 3(外枠だけ)
  workspace: { direct: 5, navigation: 5 }, // 実測 4 / 4(+ workspaces/:wid/sites)
  siteTop: { direct: 7, navigation: 7 }, // 実測 6 / 6(+ publishes・experiments)
  goals: { direct: 6, navigation: 6 }, // 実測 5 / 5(+ goals)
  audiences: { direct: 7, navigation: 7 }, // 実測 6 / 6(+ goals・audiences)
  experiment: { direct: 9, navigation: 9 }, // 実測 8 / 8(+ audiences・goals・experiments/:eid・evaluation-plan)
  audience: { direct: 8, navigation: 8 }, // 実測 7 / 7(+ audiences/:aid・audiences・goals)
  siteSettings: { direct: 6, navigation: 6 }, // 実測 5 / 5(+ experiments)。B139 の訪問者 ID の共有のカードが入った後も同じ(カードは control を呼ばない。2026-11-01)
  // B148: サイト設定のドメインの節。上限は siteSettings と同じ(節を増やしても admin → control の要求を増やさない)。
  // direct = ?section=domains を直接開く / navigation = 一般の節から設定のメニューの「ドメイン」で移る(ルーターを通さない節の切り替え)
  siteSettingsDomains: { direct: 6, navigation: 6 }, // 実測 5 / 0(2026-11-02。節のリンクはルーターを通らないので control を呼ばない)
  members: { direct: 6, navigation: 6 }, // 実測 5 / 5(サイトの外。+ members・invitations)
  publish: { direct: 6, navigation: 6 }, // 実測 5 / 5(+ publish-preview)
  history: { direct: 6, navigation: 6 }, // 実測 5 / 5(+ publishes)
};

/**
 * 一覧の画面を開いて何もしない(マウスを乗せない)間に、画面の JS が出す要求の上限(最終レビュー CX-R3。管理画面の速さ D の効き目の見張り)。
 * D の前は、見えたリンクをすべて先読みし、一覧を開いただけで control への要求が数十回増えた。D の後は先読みの RSC は 0 件で、
 * 残るのは先読みではない BFF の呼び出し(/api/control/static/status など)だけ。値 = 実測 + 1(余裕の付け方はファイルの先頭)。
 * 先読みの RSC の要求の数(prefetches)は 0 であることも表明する
 */
export const IDLE_LIMITS = {
  siteTop: 2, // 実測 1(BFF の /static/status。2026-11-01)
  audiences: 2, // 実測 1(同上)
} as const;

/**
 * 書き込みの回数の上限(REQUEST_LIMITS とは別のまとまり。値の上げ方はファイルの先頭の手順と同じ)。
 *
 * B148: ドメインの節の保存 1 回(BFF の PATCH 1 + 保存の後の読み直し)が control を呼ぶ回数。
 * 上限は siteSettings の直接の表示と同じ(読み直しは画面の表示と同じ取得で、PATCH の 1 回はその余裕の中に収める)
 *
 * B173 第 1 段: エクスペリエンスの保存 1 回の上限。
 * 名前だけ変えて「保存(下書き)」を押したときの、押してから「保存しました」が出て画面が新しい名前を出すまでの数。値 = 実測 + 1(ただし
 * writeRequests・refreshRsc は 1 回ちょうどを表明する)。
 * - writeRequests = 保存の BFF の書き込みの要求(PATCH /api/control/sites/:sid/experiments/:eid)の数
 * - writeControl = その書き込みの要求が control を呼んだ数
 * - refreshRsc = 保存の後の読み直し(エクスペリエンスの詳細の RSC の要求)の数
 * - refreshControl = その RSC の要求が control を呼んだ数
 */
export const SAVE_LIMITS = {
  // 実測 6(2026-11-02。PATCH 1 + 読み直し 5)。余裕は 0: 読み直しの取得が 1 つ増えたら落ちる(上げる前にファイルの先頭の手順)
  siteSettingsDomains: REQUEST_LIMITS.siteSettings.direct,
  // 実測(2026-11-02。1 回押し・二度押しとも、3 回の実行で同じ): writeControl 1(PATCH 1 回)/ refreshControl 8。
  // refreshControl の 8 は上の REQUEST_LIMITS.experiment(詳細の遷移 = 実測 8)と同じ: 保存の後の読み直しはその画面の RSC を描き直すだけで、
  // 外枠の /me・/workspaces/summary・/capabilities・/sites/:sid + audiences・goals・experiments/:eid・evaluation-plan を 1 回ずつ呼ぶ(重複なし)
  experimentNameSave: { writeRequests: 1, writeControl: 2, refreshRsc: 1, refreshControl: 9 },
} as const;

/**
 * 保存の窓(SAVE_LIMITS の test)で、書き込み・読み直しのほかに許す admin への要求。ここに無い要求が窓の中に出たら落とす
 * (余計な往復が増えたことを見張る。最終レビュー FR-Medium-5)。足すときは、なぜ要るかを横に書く
 */
const SAVE_ALLOWED: ReadonlyArray<(url: URL) => boolean> = [];

const SITE_RC = { id: "site_e2e_rcount", name: "E2E Request Count" };
const EXP = { id: "exp_e2e_rcount", name: "E2E request count experience" };
const AUD = { id: "aud_e2e_rcount", name: "E2E request count audience" };
const GOAL = { id: "goal_e2e_rcount", name: "E2E request count goal" };
/** 観測の口(admin の wrangler dev) */
const OBSERVABILITY = `${ADMIN_URL}/cdn-cgi/local/explorer/api/local/observability/query`;
/** 新しい要求がこの間来なければ「落ち着いた」とみなす */
const QUIET_MS = 2_000;

/** admin への要求 1 件と、その中で control へ出した要求の URL */
type AdminRequest = { url: string; control: string[] };
/** 数えた結果。total は control への要求の数、byPath はそのパスごとの内訳 */
type Counts = { total: number; byPath: Record<string, number> };

/** 観測の口に SQL を投げて行を返す */
async function query(sql: string): Promise<unknown[][]> {
  const res = await fetch(OBSERVABILITY, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql }) });
  const body = (await res.json().catch(() => null)) as { success?: boolean; result?: { rows?: unknown[][] } } | null;
  if (!res.ok || body?.success !== true) throw new Error(`observability query failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body.result?.rows ?? [];
}

/**
 * 時刻の窓 [from, to) に始まった admin への要求(http の根の span)と、それぞれが control へ出した要求(同じ trace の fetch の子)。
 * 時刻は wrangler の span の start_ms(この Mac の時計。テストの Date.now() と同じ)
 */
async function adminRequests(from: number, to = Number.MAX_SAFE_INTEGER): Promise<AdminRequest[]> {
  const rows = await query(
    `SELECT r.span_id, json_extract(r.attributes, '$."url.full"'), json_extract(c.attributes, '$."url.full"')
     FROM spans r
     LEFT JOIN spans c ON c.trace_id = r.trace_id AND c.name = 'fetch' AND json_extract(c.attributes, '$."url.full"') LIKE '${CONTROL_URL}/%'
     WHERE r.service = 'wtt-admin' AND r.parent_id IS NULL AND json_extract(r.attributes, '$."faas.trigger"') = 'http'
       AND r.start_ms >= ${Math.floor(from)} AND r.start_ms < ${Math.ceil(to)}
     ORDER BY r.start_ms, c.start_ms`,
  );
  const byRoot = new Map<string, AdminRequest>();
  for (const [id, url, controlUrl] of rows) {
    const req = byRoot.get(String(id)) ?? { url: String(url), control: [] };
    if (controlUrl) req.control.push(String(controlUrl));
    byRoot.set(String(id), req);
  }
  return [...byRoot.values()];
}

/** admin への要求と control への要求の数が QUIET_MS の間変わらなくなるまで待ち、その時刻を返す(先読み・表示の後の取り直しを含めるため) */
async function waitQuiet(from: number): Promise<number> {
  const deadline = Date.now() + 30_000;
  let last = "";
  let since = Date.now();
  while (Date.now() < deadline) {
    const reqs = await adminRequests(from);
    const now = `${reqs.length}/${reqs.reduce((n, r) => n + r.control.length, 0)}`;
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= QUIET_MS) {
      return Date.now();
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("admin への要求が 30 秒たっても落ち着かない");
}

/** 要求の URL・パスの ID を記号に置き換える(記録の鍵。ワークスペースの ID は実行ごとに変わる) */
function symbolize(path: string, wid: string): string {
  return path
    .replaceAll(SITE_RC.id, ":sid")
    .replaceAll(EXP.id, ":eid")
    .replaceAll(AUD.id, ":aid")
    .replaceAll(GOAL.id, ":gid")
    .replaceAll(wid, ":wid");
}

/** URL を記録の鍵にする(RSC の `?_rsc=` の値は毎回変わるので `?_rsc` にまとめる) */
function key(url: string, wid: string): string {
  const u = new URL(url);
  const search = u.searchParams.has("_rsc") ? "?_rsc" : u.search;
  return symbolize(`${u.pathname}${search}`, wid);
}

/** control への要求をパスごとに数える */
function count(reqs: AdminRequest[], wid: string): Counts {
  const byPath: Record<string, number> = {};
  for (const u of reqs.flatMap((r) => r.control)) byPath[key(u, wid)] = (byPath[key(u, wid)] ?? 0) + 1;
  return { total: Object.values(byPath).reduce((a, b) => a + b, 0), byPath };
}

/** admin への要求ごとの control の回数(どの要求が何回呼んだかの記録) */
const perRequest = (reqs: AdminRequest[], wid: string) => reqs.map((r) => ({ admin: key(r.url, wid), control: r.control.length }));

/** 同じパスへの要求が 2 回以上あったもの(/me が 3 回 など) */
const duplicates = (c: Counts) => Object.fromEntries(Object.entries(c.byPath).filter(([, n]) => n > 1));

/** 数えた結果をテストの添付と標準出力に残す(直す前後の比較に使う) */
async function record(testInfo: TestInfo, name: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  console.log(`[request-count] ${name}\n${json}`);
  await testInfo.attach(`request-counts-${name}`, { body: json, contentType: "application/json" });
}

/** ブラウザが admin へ送った要求(メソッド・pathname)を、stop() まで集める。観測の口の span にはメソッドが無いので、書き込みの識別に使う */
function watchBrowserRequests(page: Page): { seen: Array<{ method: string; pathname: string }>; stop: () => void } {
  const seen: Array<{ method: string; pathname: string }> = [];
  const origin = new URL(ADMIN_URL).origin;
  const on = (req: Request) => {
    const u = new URL(req.url());
    if (u.origin === origin) seen.push({ method: req.method(), pathname: u.pathname });
  };
  page.on("request", on);
  return { seen, stop: () => page.off("request", on) };
}

/** 画面の URL を組むための ID(ワークスペースの ID はサイトを作った後に分かる) */
type Ids = { wid: string };
const siteBase = ({ wid }: Ids) => `/w/${wid}/sites/${SITE_RC.id}`;

/** メインメニュー(左のサイドバー)のリンク。exact: 「サイト設定」などと取り違えない */
const navLink = (page: Page, name: string) => page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name, exact: true });
/** 本文(<main>)のリンク。サイドバーの切替の一覧にも同じ名前のリンクがあるので本文に絞る */
const mainLink = (page: Page, name: string) => page.locator("main").getByRole("link", { name, exact: true });
/** 画面の見出し(PageHeader の h1) */
const heading = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });

/**
 * 対象の画面。path = 画面の URL(パスだけ。この pathname への HTML / RSC の要求を「その画面の要求」として数える)/
 * ready = 表示が済んだ印 / from = 遷移元の画面 / open = 遷移元でリンクを出すための操作(無ければ不要)/ link = 押すリンク
 */
type Screen = {
  name: ScreenName;
  path: (ids: Ids) => string;
  ready: (page: Page) => Promise<void>;
  from: (ids: Ids) => string;
  open?: (page: Page) => Promise<void>;
  link: (page: Page) => Locator;
};

const SCREENS: Screen[] = [
  // ホーム: ワークスペースのホームから左上のロゴで戻る
  { name: "home", path: () => "/w", ready: (p) => expect(heading(p, "ホーム")).toBeVisible(), from: ({ wid }) => `/w/${wid}`, link: (p) => navLink(p, "AB Test and Target Harness") },
  // ワークスペースのホーム(サイト一覧): ホームのワークスペースのカードから(fixtures.ts の openWorkspace と同じ)
  {
    name: "workspace",
    path: ({ wid }) => `/w/${wid}`,
    ready: (p) => expect(heading(p, "サイト一覧")).toBeVisible(),
    from: () => "/w",
    link: (p) => p.getByTestId("workspace-card").getByRole("link", { name: WORKSPACE_NAME, exact: true }),
  },
  // サイトのトップ(= エクスペリエンスの一覧): サイト一覧から
  { name: "siteTop", path: siteBase, ready: (p) => expect(heading(p, "エクスペリエンス")).toBeVisible(), from: ({ wid }) => `/w/${wid}`, link: (p) => mainLink(p, SITE_RC.name) },
  // 目標(詳細の画面は無いので一覧で代える): サイトのトップから左メニューで
  { name: "goals", path: (ids) => `${siteBase(ids)}/goals`, ready: (p) => expect(heading(p, "目標")).toBeVisible(), from: siteBase, link: (p) => navLink(p, "目標") },
  { name: "audiences", path: (ids) => `${siteBase(ids)}/audiences`, ready: (p) => expect(heading(p, "オーディエンス")).toBeVisible(), from: siteBase, link: (p) => navLink(p, "オーディエンス") },
  // エクスペリエンスの詳細: サイトのトップの一覧の行から
  { name: "experiment", path: (ids) => `${siteBase(ids)}/experiments/${EXP.id}`, ready: (p) => expect(heading(p, EXP.name)).toBeVisible(), from: siteBase, link: (p) => mainLink(p, EXP.name) },
  // オーディエンスの詳細(設定): オーディエンスの一覧の行から
  {
    name: "audience",
    path: (ids) => `${siteBase(ids)}/audiences/${AUD.id}`,
    ready: (p) => expect(p.getByLabel("名前", { exact: true })).toHaveValue(AUD.name),
    from: (ids) => `${siteBase(ids)}/audiences`,
    link: (p) => mainLink(p, AUD.name),
  },
  // サイト設定: サイトのトップから左メニューの最下部の「設定」(サイトから開くとサイト設定になる)
  { name: "siteSettings", path: (ids) => `${siteBase(ids)}/settings`, ready: async (p) => { await expect(heading(p, "サイト設定")).toBeVisible(); await expect(p.getByTestId("sharing-card")).toBeAttached(); }, from: siteBase, link: (p) => navLink(p, "設定") }, // B139: 訪問者 ID の共有のカードも描かれた画面を数える(カードは control を呼ばない)
  // メンバー(ワークスペースの設定): ワークスペースのホームから「設定」(owner がワークスペースから開くとメンバーになる)
  { name: "members", path: ({ wid }) => `/w/${wid}/members`, ready: (p) => expect(heading(p, "メンバー")).toBeVisible(), from: ({ wid }) => `/w/${wid}`, link: (p) => navLink(p, "設定") },
  // 公開: 上部バーの「公開」
  { name: "publish", path: (ids) => `${siteBase(ids)}/publish`, ready: (p) => expect(heading(p, "公開")).toBeVisible(), from: siteBase, link: (p) => p.getByTestId("topbar-publish") },
  // 公開履歴: 上部バーの版の札を開き(BFF の GET publishes を 1 回呼ぶ。open の分として記録)、「すべての公開履歴」から
  {
    name: "history",
    path: (ids) => `${siteBase(ids)}/history`,
    ready: (p) => expect(heading(p, "公開履歴")).toBeVisible(),
    from: siteBase,
    open: async (p) => {
      await p.getByTestId("version-chip").click();
      await expect(p.getByTestId("version-popover")).toBeVisible();
    },
    link: (p) => p.getByTestId("version-popover").getByRole("link", { name: "すべての公開履歴 →", exact: true }),
  },
];

/** 画面ごとの実測(最後の表) */
type Row = { direct: number | null; navigation: number | null; prefetchOnHover: number | null; afterLoad: number | null; open?: number | null; save?: number | null };

/**
 * 全画面を 1 つのテストの段(test.step)にする: 表明は soft にして、ある画面が上限を超えても・操作で落ちても残りの画面まで数えて記録する
 * (別のテストに分けると、serial では前のテストの失敗で後が走らず、全画面の数が 1 回で出ない)。ログインも 1 回で済む(fixtures.ts の login() の予算)
 */
test("main screens: control requests per view stay within the budget (direct HTML / client navigation RSC)", async ({ page }, testInfo) => {
  // 11 画面 × (直接 + 遷移元 + ホバー + 押した後)の落ち着き待ち(各 2 秒以上)が要るので、既定の 60 秒では足りない
  test.setTimeout(300_000);
  // 観測の口の span は E2E の実行全体でたまるので、読むのはここから後の分だけにする(窓が無いと trace_id の結合が重い)
  const started = Date.now();
  const ids: Ids = { wid: "" };
  const summary: Partial<Record<ScreenName, Row>> = {};

  await test.step("setup: a dedicated site with one experience, one audience and one goal", async () => {
    await login(page);
    // ほかの project の状態を変えないよう、専用のサイトにエクスペリエンス・オーディエンス・目標を 1 件ずつ置く
    await createSite(page, SITE_RC);
    ids.wid = new URL(page.url()).pathname.split("/")[2]!;
    await createExperiment(page, EXP);
    const aud = await page.request.post(`/api/control/sites/${SITE_RC.id}/audiences`, {
      headers: controlHeaders(),
      data: { id: AUD.id, name: AUD.name, definition: { ctx: "path", op: "regex", value: "^/$" } },
    });
    expect(aud.status()).toBe(201);
    const goal = await page.request.post(`/api/control/sites/${SITE_RC.id}/goals`, { headers: controlHeaders(), data: { id: GOAL.id, name: GOAL.name, type: "CUSTOM", config: {} } });
    expect(goal.status()).toBe(201);
    // 観測の口が使え、control への要求が子の span として見えること(見えないと下の数が 0 になり、上限の表明が素通りする)
    expect(count(await adminRequests(started), ids.wid).total).toBeGreaterThan(0);
    // 準備(ログイン・作成)の分を数えないよう、落ち着いてから数え始める(以降の段はどれも落ち着くまで待って終わる)
    await waitQuiet(Date.now() - 5_000);
  });

  for (const s of SCREENS) {
    const limit = REQUEST_LIMITS[s.name];
    const path = s.path(ids);
    const row: Row = { direct: null, navigation: null, prefetchOnHover: null, afterLoad: null };
    summary[s.name] = row;
    /** その画面そのもの(HTML / RSC)の要求 */
    const isOwn = (r: AdminRequest) => new URL(r.url).pathname === path;
    /** 操作で落ちたら(リンクが見つからない・落ち着かない など)その画面の失敗として記録し、次の画面へ進む */
    const guard = async (what: string, body: () => Promise<void>) => {
      try {
        await body();
      } catch (e) {
        expect.soft(String(e), `${s.name}: ${what} の操作が最後まで進む`).toBe("");
        // 途中で落ちた分が次の画面の数に混ざらないよう落ち着くまで待つ
        await waitQuiet(Date.now() - 5_000).catch(() => undefined);
      }
    };

    await test.step(`${s.name}: direct load (HTML)`, () =>
      guard("direct", async () => {
        const from = Date.now();
        await page.goto(path);
        await waitForHydration(page);
        await s.ready(page);
        const to = await waitQuiet(from);
        const reqs = await adminRequests(from, to);
        const own = reqs.filter(isOwn);
        const direct = count(own, ids.wid);
        row.direct = direct.total;
        // others = 表示の後に画面の JS が出した要求(リンクの先読み・BFF)の分
        await record(testInfo, `${s.name}-direct`, { direct, others: count(reqs.filter((r) => !isOwn(r)), ids.wid), requests: perRequest(reqs, ids.wid) });

        expect.soft(own, `${s.name}: 直接: 画面の HTML の要求が 1 件ある`).toHaveLength(1);
        expect.soft(duplicates(direct), `${s.name}: 直接: 同じパスへの重複が無い`).toEqual({});
        // どの画面も外枠で /me などを必ず呼ぶので 0 回はありえない。0 = 観測の口が壊れた(子の span が出ない)ので、上限の表明が素通りしないよう落とす
        expect.soft(direct.total, `${s.name}: 直接: control への要求が数えられている(≥ 1)`).toBeGreaterThan(0);
        expect.soft(direct.total, `${s.name}: 直接の表示で control への要求 ≤ ${limit.direct}`).toBeLessThanOrEqual(limit.direct);
      }),
    );

    await test.step(`${s.name}: client navigation (RSC)`, () =>
      guard("navigation", async () => {
        // 遷移元を開く。遷移元の HTML の要求以外(開いた後〜落ち着くまでの先読みなど)は表示の後の分として別に記録する
        const fromPath = s.from(ids);
        const isFromHtml = (r: AdminRequest) => new URL(r.url).pathname === fromPath && !new URL(r.url).searchParams.has("_rsc");
        const loadFrom = Date.now();
        await page.goto(fromPath);
        await waitForHydration(page);
        const loadTo = await waitQuiet(loadFrom);
        const loadReqs = await adminRequests(loadFrom, loadTo);
        row.afterLoad = count(loadReqs.filter((r) => !isFromHtml(r)), ids.wid).total;

        // リンクを出す操作(版の札を開く など)。その分も別に記録する
        let openReqs: AdminRequest[] = [];
        if (s.open) {
          const openFrom = Date.now();
          await s.open(page);
          openReqs = await adminRequests(openFrom, await waitQuiet(openFrom));
          row.open = count(openReqs, ids.wid).total;
        }

        // 押す前にマウスを乗せ、その先読み(AppLink はマウスが乗ったときだけ先読みする)が落ち着くのを待つ。人が押すときと同じ順で、
        // 先読みの要求を押した後の分に混ぜない(混ざると、その画面の URL への要求が 2 件になり、遷移の回数と重複の表明が先読みの分まで数える)
        const link = s.link(page);
        await expect(link).toBeVisible();
        const hoverFrom = Date.now();
        await link.hover();
        const hoverReqs = await adminRequests(hoverFrom, await waitQuiet(hoverFrom));
        row.prefetchOnHover = count(hoverReqs, ids.wid).total;

        // ここからが遷移の分(押した後だけ)
        const from = Date.now();
        await link.click();
        await expect(page).toHaveURL((u) => u.pathname === path);
        await s.ready(page);
        const to = await waitQuiet(from);
        const reqs = await adminRequests(from, to);
        const own = reqs.filter(isOwn);
        const navigation = count(own, ids.wid);
        row.navigation = navigation.total;
        await record(testInfo, `${s.name}-navigation`, {
          navigation,
          othersAfterClick: count(reqs.filter((r) => !isOwn(r)), ids.wid),
          requestsAfterClick: perRequest(reqs, ids.wid),
          fromLoad: count(loadReqs.filter(isFromHtml), ids.wid),
          afterLoad: count(loadReqs.filter((r) => !isFromHtml(r)), ids.wid),
          requestsWhileFrom: perRequest(loadReqs, ids.wid),
          ...(s.open ? { open: count(openReqs, ids.wid), requestsOnOpen: perRequest(openReqs, ids.wid) } : {}),
          prefetchOnHover: count(hoverReqs, ids.wid),
          requestsOnHover: perRequest(hoverReqs, ids.wid),
        });

        // 押した後にその画面の RSC の要求が無い = 先読みの結果だけで描いた。その場合の回数は requestsOnHover の行を見る。
        // 実測(2026-10-30)では、loading.tsx の無い画面(ホーム・ワークスペースのホーム・サイトのトップ・サイト設定)もホバーの先読みで
        // 画面全体を描いた後、押すともう一度要求が出る(ホバーの分と押した後の分が同じ数)。表明は押した後の分だけ
        expect.soft(own.length, `${s.name}: 押した後に画面の RSC の要求がある`).toBeGreaterThan(0);
        expect.soft(duplicates(navigation), `${s.name}: 遷移: 同じパスへの重複が無い`).toEqual({});
        expect.soft(navigation.total, `${s.name}: 遷移: control への要求が数えられている(≥ 1)`).toBeGreaterThan(0);
        expect.soft(navigation.total, `${s.name}: 遷移で control への要求 ≤ ${limit.navigation}`).toBeLessThanOrEqual(limit.navigation);
      }),
    );
  }

  // B148: サイト設定のドメインの節。節はルーターを通さずに切り替わる(lib/settings-section.ts)ので、SCREENS の遷移の形(押した後の RSC の要求)にならない。
  // 直接(?section=domains の HTML)・節のリンク(押した後の要求の全部)・節の保存 1 回(BFF の PATCH と保存の後の読み直しの RSC)を数える
  {
    const settingsPath = `${siteBase(ids)}/settings`;
    const limit = REQUEST_LIMITS.siteSettingsDomains;
    const row: Row = { direct: null, navigation: null, prefetchOnHover: null, afterLoad: null, save: null };
    summary.siteSettingsDomains = row;
    const domainsSection = page.getByTestId("domains-section");
    const isOwnHtml = (r: AdminRequest) => new URL(r.url).pathname === settingsPath && !new URL(r.url).searchParams.has("_rsc");
    const guard = async (what: string, body: () => Promise<void>) => {
      try {
        await body();
      } catch (e) {
        expect.soft(String(e), `siteSettingsDomains: ${what} の操作が最後まで進む`).toBe("");
        await waitQuiet(Date.now() - 5_000).catch(() => undefined);
      }
    };

    await test.step("siteSettingsDomains: direct load (HTML, ?section=domains)", () =>
      guard("direct", async () => {
        const from = Date.now();
        await page.goto(`${settingsPath}?section=domains`);
        await waitForHydration(page);
        await expect(domainsSection).toBeVisible();
        const to = await waitQuiet(from);
        const reqs = await adminRequests(from, to);
        const own = reqs.filter(isOwnHtml);
        const direct = count(own, ids.wid);
        row.direct = direct.total;
        await record(testInfo, "siteSettingsDomains-direct", { direct, others: count(reqs.filter((r) => !isOwnHtml(r)), ids.wid), requests: perRequest(reqs, ids.wid) });
        expect.soft(own, "siteSettingsDomains: 直接: 画面の HTML の要求が 1 件ある").toHaveLength(1);
        expect.soft(duplicates(direct), "siteSettingsDomains: 直接: 同じパスへの重複が無い").toEqual({});
        expect.soft(direct.total, "siteSettingsDomains: 直接: control への要求が数えられている(≥ 1)").toBeGreaterThan(0);
        expect.soft(direct.total, `siteSettingsDomains: 直接の表示で control への要求 ≤ ${limit.direct}`).toBeLessThanOrEqual(limit.direct);
      }),
    );

    await test.step("siteSettingsDomains: section link from the general section", () =>
      guard("navigation", async () => {
        await page.goto(settingsPath);
        await waitForHydration(page);
        await waitQuiet(Date.now() - 5_000);
        const link = page.getByTestId("section-domains");
        await link.hover();
        await waitQuiet(Date.now());
        const from = Date.now();
        await link.click();
        await expect(domainsSection).toBeVisible();
        await expect(page).toHaveURL(/[?&]section=domains/);
        const to = await waitQuiet(from);
        const reqs = await adminRequests(from, to);
        const navigation = count(reqs, ids.wid);
        row.navigation = navigation.total;
        await record(testInfo, "siteSettingsDomains-navigation", { navigation, requests: perRequest(reqs, ids.wid) });
        expect.soft(navigation.total, `siteSettingsDomains: 節のリンクで control への要求 ≤ ${limit.navigation}`).toBeLessThanOrEqual(limit.navigation);
      }),
    );

    await test.step("siteSettingsDomains: one save of the section (PATCH + refresh)", () =>
      guard("save", async () => {
        await expect(domainsSection).toBeVisible();
        await waitQuiet(Date.now() - 5_000);
        const from = Date.now();
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await expect(page.getByText("保存しました")).toBeVisible();
        const to = await waitQuiet(from);
        const reqs = await adminRequests(from, to);
        // 表明するのは保存そのものの要求: BFF の PATCH と、保存の後の読み直し(この画面の RSC)。ほかは記録だけ
        const isSaveOwn = (r: AdminRequest) => {
          const u = new URL(r.url);
          return u.pathname === `/api/control/sites/${SITE_RC.id}` || (u.pathname === settingsPath && u.searchParams.has("_rsc"));
        };
        const own = reqs.filter(isSaveOwn);
        const save = count(own, ids.wid);
        row.save = save.total;
        await record(testInfo, "siteSettingsDomains-save", { save, others: count(reqs.filter((r) => !isSaveOwn(r)), ids.wid), requests: perRequest(reqs, ids.wid), limit: SAVE_LIMITS.siteSettingsDomains });
        expect.soft(own.length, "siteSettingsDomains: 保存: PATCH と読み直しの 2 件の要求がある").toBe(2);
        // PATCH の分が数えられている(0 = 観測の口が壊れた)
        expect.soft(save.total, "siteSettingsDomains: 保存: control への要求が数えられている(≥ 1)").toBeGreaterThan(0);
        expect.soft(save.total, `siteSettingsDomains: 節の保存 1 回で control への要求 ≤ ${SAVE_LIMITS.siteSettingsDomains}`).toBeLessThanOrEqual(SAVE_LIMITS.siteSettingsDomains);
      }),
    );
  }

  // CX-R3: 一覧を開いて何もしない間の要求(見えたリンクの先読みが戻っていないこと)。マウスはリンクの無い所(画面の右下)に置く
  const idle: Record<string, unknown> = {};
  for (const [name, path] of [
    ["siteTop", siteBase(ids)],
    ["audiences", `${siteBase(ids)}/audiences`],
  ] as const) {
    await test.step(`${name}: idle after load (no hover)`, async () => {
      const vp = page.viewportSize() ?? { width: 1280, height: 720 };
      await page.mouse.move(vp.width - 5, vp.height - 5);
      const from = Date.now();
      await page.goto(path);
      await waitForHydration(page);
      // 何もしないで待つ(QUIET_MS 以上、新しい要求が来なくなるまで)
      const to = await waitQuiet(from);
      const reqs = (await adminRequests(from, to)).filter((r) => !(new URL(r.url).pathname === path && !new URL(r.url).searchParams.has("_rsc")));
      const prefetches = reqs.filter((r) => new URL(r.url).searchParams.has("_rsc")).length;
      const c = count(reqs, ids.wid);
      idle[name] = { control: c, prefetches, requests: perRequest(reqs, ids.wid), limit: IDLE_LIMITS[name] };
      expect.soft(prefetches, `${name}: 何もしない間に先読みの RSC の要求が無い`).toBe(0);
      expect.soft(c.total, `${name}: 何もしない間の control への要求 ≤ ${IDLE_LIMITS[name]}`).toBeLessThanOrEqual(IDLE_LIMITS[name]);
    });
  }
  await record(testInfo, "idle", idle);

  // 全画面の実測と上限の表(上限を見直すときはこれを見る)
  await record(
    testInfo,
    "summary",
    Object.fromEntries(Object.entries(summary).map(([name, r]) => [name, { ...r, limit: REQUEST_LIMITS[name as ScreenName] }])),
  );
});

/**
 * エクスペリエンスの保存 1 回(名前だけ変える)の回数。保存は覆いの部品で 1 回の書き込み + 1 回の読み直しにしてある(二度押しでも同じ)ので、
 * 書き込み・読み直しの要求がちょうど 1 回ずつであることと、それぞれが control を呼んだ数が上限以下であることを見る。
 * 専用のサイトを作る(上の test の状態に頼らない)。ID は SITE_RC / EXP の ID の先頭に一致しないものにする(symbolize が置き換えてしまうため)
 */
test("experience save: one write and one refresh stay within the control request budget (single click and double click)", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const started = Date.now();
  const site = { id: "site_e2e_savecount", name: "E2E Save Count" };
  const exp = { id: "exp_e2e_savecount", name: "E2E save count experience" };
  const limit = SAVE_LIMITS.experimentNameSave;

  await login(page);
  await createSite(page, site);
  const wid = new URL(page.url()).pathname.split("/")[2]!;
  const siteUrl = page.url();
  await createExperiment(page, exp);
  // 観測の口が使えること(見えないと下の数が 0 になる。下の「≥ 1」の表明と合わせた保険)
  expect(count(await adminRequests(started), wid).total).toBeGreaterThan(0);

  const expPath = `${new URL(siteUrl).pathname}/experiments/${exp.id}`;
  const writePath = `/api/control/sites/${site.id}/experiments/${exp.id}`;
  const region = page.getByRole("region", { name: "基本設定" });
  const nameInput = region.getByLabel("名前(100 字以内)");
  const saveButton = page.getByRole("button", { name: "保存(下書き)" });

  /** 名前を変えて保存し、帯に「保存しました」が出て画面が新しい名前を出したところまでの admin への要求を数える */
  const measure = async (label: string, newName: string, press: () => Promise<void>) => {
    await page.goto(expPath);
    await waitForHydration(page);
    await expect(nameInput).toBeVisible();
    // 開いた分(HTML・先読みなど)を数えないよう、落ち着いてから数え始める
    await waitQuiet(Date.now() - 5_000);
    await nameInput.fill(newName);
    const browser = watchBrowserRequests(page);
    const from = Date.now();
    await press();
    await expect(page.getByTestId("save-state")).toHaveText("保存しました");
    await expect(heading(page, newName)).toBeVisible();
    // 帯の文と画面の名前を確かめた後、遅れて来る要求も含めて落ち着くまで待ってから閉じる
    const reqs = await adminRequests(from, await waitQuiet(from));
    browser.stop();
    // 窓の中の admin への要求を分類する: 書き込み(保存の PATCH)・読み直し(詳細の RSC)・許したもの(SAVE_ALLOWED)・その他。
    // 観測の口の span には HTTP のメソッドが無いので、書き込みの path への要求はブラウザ側で見た PATCH の数と照らす(下の表明)
    const writes = reqs.filter((r) => new URL(r.url).pathname === writePath);
    const refreshes = reqs.filter((r) => new URL(r.url).pathname === expPath && new URL(r.url).searchParams.has("_rsc"));
    const allowed = reqs.filter((r) => !writes.includes(r) && !refreshes.includes(r) && SAVE_ALLOWED.some((ok) => ok(new URL(r.url))));
    const others = reqs.filter((r) => !writes.includes(r) && !refreshes.includes(r) && !allowed.includes(r));
    const browserPatches = browser.seen.filter((r) => r.method === "PATCH" && r.pathname === writePath);
    // ブラウザが admin へ送った GET 以外の要求のうち、保存の PATCH でないもの(別の書き込みが増えたら落とす)
    const browserOtherWrites = browser.seen.filter((r) => r.method !== "GET" && r.method !== "HEAD" && !(r.method === "PATCH" && r.pathname === writePath));
    const result = {
      writeRequests: writes.length,
      writeControl: count(writes, wid).total,
      refreshRsc: refreshes.length,
      refreshControl: count(refreshes, wid).total,
    };
    await record(testInfo, `experimentNameSave-${label}`, {
      ...result,
      writeByPath: count(writes, wid).byPath,
      refreshByPath: count(refreshes, wid).byPath,
      allowed: perRequest(allowed, wid),
      others: perRequest(others, wid),
      browserPatches: browserPatches.length,
      browserOtherWrites: browserOtherWrites.map((r) => `${r.method} ${symbolize(r.pathname, wid)}`),
      requests: perRequest(reqs, wid),
      limit,
    });
    // 書き込み・読み直しの要求はちょうど 1 回。control を呼んだ数は、0 件(観測の口が壊れた)で素通りしないよう 0 より大きいことも見る
    expect.soft(result.writeRequests, `${label}: 保存の書き込みの要求がちょうど ${limit.writeRequests} 件`).toBe(limit.writeRequests);
    expect.soft(result.refreshRsc, `${label}: 保存の後の読み直し(RSC)の要求がちょうど ${limit.refreshRsc} 件`).toBe(limit.refreshRsc);
    expect.soft(result.writeControl, `${label}: 書き込みが control を呼んだ数が数えられている(≥ 1)`).toBeGreaterThan(0);
    expect.soft(result.writeControl, `${label}: 書き込みが control を呼んだ数 ≤ ${limit.writeControl}`).toBeLessThanOrEqual(limit.writeControl);
    expect.soft(result.refreshControl, `${label}: 読み直しが control を呼んだ数が数えられている(≥ 1)`).toBeGreaterThan(0);
    expect.soft(result.refreshControl, `${label}: 読み直しが control を呼んだ数 ≤ ${limit.refreshControl}`).toBeLessThanOrEqual(limit.refreshControl);
    // 書き込みの path への要求は、すべてブラウザが送った PATCH(同じ path への GET などが紛れて書き込みに数えられていない)
    expect.soft(browserPatches.length, `${label}: ブラウザが送った保存の PATCH の数が、観測の口の書き込みの要求の数と同じ`).toBe(result.writeRequests);
    expect.soft(browserOtherWrites.map((r) => `${r.method} ${symbolize(r.pathname, wid)}`), `${label}: 保存の PATCH のほかに書き込みの要求が無い`).toEqual([]);
    // 書き込み・読み直し・許したもののほかに、admin への要求が無い(余計な BFF の GET・別の画面の RSC が増えたら落とす)
    expect.soft(perRequest(others, wid), `${label}: 保存の窓に、書き込み・読み直し・許したもの以外の要求が無い`).toEqual([]);
    return result;
  };

  const single = await measure("single-click", "E2E save count renamed 1", () => saveButton.click());
  // 二度押し: 1 回目で覆いが出て 2 回目は効かないので、数は 1 回押しと同じ
  const double = await measure("double-click", "E2E save count renamed 2", () => saveButton.dblclick());
  expect.soft(double, "二度押しの数が 1 回押しと同じ").toEqual(single);
});
