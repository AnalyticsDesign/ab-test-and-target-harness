import { test, expect, type BrowserContext, type Locator, type Page, type Request, type Route } from "@playwright/test";
import {
  acceptInvite,
  createExperiment,
  createSite,
  d1Local,
  dropImages,
  issueInvite,
  login,
  openMembers,
  pngFile,
  putImageChanges,
  uploadImage,
  waitForHydration,
  type UploadedImage,
} from "./fixtures";

/**
 * B68: サイトの画像のライブラリ(spec §9・§14 の admin(E2E)・§10.1)。
 * - 一覧の画面: アップロード(ファイルを選ぶ 3 枚、うち 1 枚は名前が重なる)・画面へのドロップ・名前の変更の重なり・使用中の削除が押せない理由・
 *   削除待ちにした画像が一覧から消えて使用量の「うち削除待ち」に数えられる・閲覧者に入口が出ない・格子の名前と札の切れ方(幅 1280 / 390、ライト / ダーク)
 * - パターンの画面: 選ぶ窓から選んで保存 → 一覧の「使用 1」・IMAGE の欄へのドロップ・ドロップの直後にパターンを切り替えても上がった画像が窓に入る・
 *   送っている間の離れる前の確認・開始の 409 asset_missing の一覧の「今開いているエクスペリエンス」の行(遷移せず、確認も往復も無い)
 * - 表示の後のブラウザからの一覧の取得(BFF の GET /sites/:sid/assets)の回数(Task 9 Step 2。request-count の描画の上限とは別の表明)
 *
 * E2E の control は R2 があり(AB_ASSET_PUBLIC_BASE = control の /dev-assets)、Images はローカルの実装(sharp)。縮小版の有無には頼らない
 * (作れなくても一覧は元の画像を出す)。ログインは 1 回(fixtures.ts の login() の予算)、閲覧者は招待の受諾で 1 人作る
 */

const SITE = { id: "site_e2e_images", name: "E2E Images" };
/** IMAGE の変更が無いパターン(表示の後の取得 0 回・窓を初めて開いたときに 1 回) */
const EXP_NONE = { id: "exp_e2e_img_none", name: "E2E images none" };
/** IMAGE の変更が 2 つあるパターン(表示の後の取得 1 回・窓を開き直しても 0 回) */
const EXP_TWO = { id: "exp_e2e_img_two", name: "E2E images two" };
/** 選ぶ窓から選んで保存する・IMAGE の欄に落とす */
const EXP_PICK = { id: "exp_e2e_img_pick", name: "E2E images pick" };
/** 開始の 409 asset_missing(消す途中の印を付けた画像を IMAGE に持つ) */
const EXP_GUARD = { id: "exp_e2e_img_guard", name: "E2E images guard" };
const VIEWER_EMAIL = "images-viewer@e2e.example";

/** 格子の札の確かめに使う 100 字の名前(ASCII。拡張子なし) */
const LONG_NAME = `long-${"x".repeat(95)}`;
/** 一覧・窓のページ分けを起こす数(窓は 24 枚ずつ。一覧は「一度に表示」を 24 にして確かめる) */
const SEED_COUNT = 26;

let ctx: BrowserContext;
let page: Page;
let wid = "";
const seeded: UploadedImage[] = [];
let used1: UploadedImage; // EXP_TWO の 1 つ目(使用中の削除が押せない)
let used2: UploadedImage;
let guardImage: UploadedImage; // EXP_GUARD の IMAGE(消す途中の印を付ける)
let delivered: UploadedImage; // 公開した内容で使用
let kept: UploadedImage; // Cron が戻した(残しました)
let longImage: UploadedImage;

const sitePath = () => `/w/${wid}/sites/${SITE.id}`;
const imagesPath = (search = "") => `${sitePath()}/images${search}`;
const expPath = (id: string, search = "") => `${sitePath()}/experiments/${id}${search}`;
const assetsApi = `/api/control/sites/${SITE.id}/assets`;

const h1 = (p: Page, name: string) => p.getByRole("heading", { level: 1, name, exact: true });
const navLink = (p: Page, name: string) => p.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name, exact: true });
/** 格子の 1 枚(title = 名前の全文) */
const tile = (scope: Page | Locator, name: string) => scope.locator(`button[title="${name}"]`);
const detail = (p: Page) => p.getByRole("complementary", { name: "画像の詳細" });
const picker = (p: Page) => p.getByRole("dialog", { name: "画像を選ぶ" });
const queueCard = (p: Page) => p.getByRole("status", { name: "アップロードの結果" });
const uploadingConfirm = (p: Page) => p.getByRole("alertdialog", { name: "アップロードの途中です" });
const unsavedConfirm = (p: Page) => p.getByRole("alertdialog", { name: "保存していない変更があります" });

async function open(p: Page, path: string): Promise<void> {
  await p.goto(path);
  await waitForHydration(p);
}

/** ブラウザから BFF への一覧の GET(表示の後の取得)を数える */
function countAssetGets(p: Page): { count: () => number; stop: () => void } {
  let n = 0;
  const on = (req: Request) => {
    const u = new URL(req.url());
    if (req.method() === "GET" && u.pathname === assetsApi) n += 1;
  };
  p.on("request", on);
  return { count: () => n, stop: () => p.off("request", on) };
}

/** 画面の描画の要求(RSC・HTML の文書)を数える(先読みは除く)。今開いている画面の中で切り替えるときに 0 であることを見る */
function countRenders(p: Page, path: string): { count: () => number; list: () => string[]; stop: () => void } {
  const seen: string[] = [];
  const on = (req: Request) => {
    const u = new URL(req.url());
    if (req.method() !== "GET" || u.pathname !== path) return;
    if (req.headers()["next-router-prefetch"]) return;
    if (u.searchParams.has("_rsc") || req.isNavigationRequest()) seen.push(req.url());
  };
  p.on("request", on);
  return { count: () => seen.length, list: () => [...seen], stop: () => p.off("request", on) };
}

/** 画像のアップロード(BFF の POST)を release まで止める。止めている間に「送っている途中」の場面を確かめる */
async function holdUploads(p: Page): Promise<{ release: () => void; undo: () => Promise<void> }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const handler = async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    await gate;
    return route.continue().catch(() => {});
  };
  await p.route(`**${assetsApi}`, handler);
  return { release, undo: () => p.unroute(`**${assetsApi}`, handler) };
}

/** 少し待って、まだ要求が来ないことを確かめるための待ち(表示の後の取得はマウントの直後に出るので、その分を含める) */
const settle = (p: Page) => p.waitForTimeout(1_500);

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await ctx.newPage();
  await login(page);
  await createSite(page, SITE);
  wid = new URL(page.url()).pathname.split("/")[2]!;
  // 画像を API で置く(画面の操作の確かめは各テストで行う)
  for (let i = 1; i <= SEED_COUNT; i++) seeded.push(await uploadImage(page, SITE.id, { fileName: `seed-${String(i).padStart(2, "0")}.png` }));
  used1 = await uploadImage(page, SITE.id, { name: "used-1" });
  used2 = await uploadImage(page, SITE.id, { name: "used-2" });
  guardImage = await uploadImage(page, SITE.id, { name: "guard-image" });
  delivered = await uploadImage(page, SITE.id, { name: "delivered-only" });
  kept = await uploadImage(page, SITE.id, { name: "kept-image" });
  longImage = await uploadImage(page, SITE.id, { name: LONG_NAME });
  expect(longImage.name).toBe(LONG_NAME);

  for (const exp of [EXP_NONE, EXP_TWO, EXP_PICK, EXP_GUARD]) {
    await open(page, sitePath());
    await createExperiment(page, exp);
  }
  await putImageChanges(page, SITE.id, EXP_TWO.id, [used1.publicUrl, used2.publicUrl]);
  await putImageChanges(page, SITE.id, EXP_GUARD.id, [guardImage.publicUrl]);
  // 札の 3 種類と「残しました」を Cron を待たずに作る: 公開したときの定義だけが使う画像(下書きの変更には無い)と、Cron が戻した画像
  d1Local(`insert into asset_delivered_refs (site_id, asset_id, experiment_id) values ('${SITE.id}', '${delivered.id}', '${EXP_NONE.id}')`);
  d1Local(`update assets set kept_at = ${Date.now()} where id = '${kept.id}'`);
});

test.afterAll(async () => {
  await ctx?.close();
});

test("library: upload three files with one name clash, then drop a file on the screen", async () => {
  await open(page, imagesPath());
  await expect(h1(page, "画像")).toBeVisible();
  // 3 枚のうち 1 枚(seed-01.png)は今ある名前と重なり、番号が付く
  await page.locator('input[type="file"]').setInputFiles([pngFile("upload-a.png"), pngFile("upload-b.png"), pngFile("seed-01.png")]);
  await expect(queueCard(page).getByRole("heading", { name: "アップロード(3 / 3)" })).toBeVisible({ timeout: 30_000 });
  await expect(queueCard(page)).toContainText("seed-01 (2).png(同じ名前があったので番号を付けました)");
  await expect(tile(page, "upload-a.png")).toBeVisible();
  await expect(tile(page, "seed-01 (2).png")).toBeVisible();
  await queueCard(page).getByRole("button", { name: "閉じる" }).click();
  await expect(queueCard(page)).toHaveCount(0);

  // 画面のどこにでも落とせる(覆いはファイルを持ってきている間だけ出る)
  await dropImages(page, null, ["dropped-1.png"]);
  await expect(queueCard(page).getByRole("heading", { name: "アップロード(1 / 1)" })).toBeVisible({ timeout: 30_000 });
  await expect(tile(page, "dropped-1.png")).toBeVisible();
  await expect(page.getByText("ここにドロップしてアップロード")).toHaveCount(0);
});

test("library: a name clash on rename is shown under the field", async () => {
  await open(page, imagesPath("?per=all"));
  await tile(page, "upload-b.png").click();
  const name = detail(page).getByLabel("名前(管理用。公開される URL には入りません)");
  await expect(name).toHaveValue("upload-b.png");
  await name.fill("upload-a.png");
  await detail(page).getByRole("button", { name: "名前を保存" }).click();
  await expect(detail(page).getByRole("alert")).toBeVisible();
  // 名前は変わっていない(格子の名前もそのまま)
  await expect(tile(page, "upload-b.png")).toBeVisible();
});

test("library: an image in use cannot be deleted and says why; a deleted image leaves the grid and counts as pending deletion", async () => {
  await open(page, imagesPath("?per=all"));
  await tile(page, used1.name).click();
  await expect(detail(page).getByRole("button", { name: "削除する" })).toBeDisabled();
  await expect(detail(page)).toContainText("パターンの変更で使われているため削除できません");
  await expect(detail(page).getByRole("link", { name: /E2E images two/ })).toBeVisible();

  await expect(page.getByText(/うち削除待ち/)).toHaveCount(0);
  await tile(page, "upload-b.png").click();
  await detail(page).getByRole("button", { name: "削除する" }).click();
  const dialog = page.getByRole("alertdialog", { name: "「upload-b.png」を削除しますか" });
  await expect(dialog).toContainText("削除待ちにします");
  // 確認は開いた直後のクリックを受けない(二度押しの守り)ので、ほかの E2E と同じく Enter で確定する
  await dialog.getByRole("button", { name: "削除する" }).press("Enter");
  await expect(tile(page, "upload-b.png")).toHaveCount(0);
  await expect(page.getByText("(うち削除待ち 1 枚)")).toBeVisible();
  // 開き直しても一覧に出ず、使用量に数える(control の正)
  await open(page, imagesPath("?per=all"));
  await expect(tile(page, "upload-b.png")).toHaveCount(0);
  await expect(page.getByText("(うち削除待ち 1 枚)")).toBeVisible();
});

/** 1 枚の画像への書き込み(BFF の PATCH・DELETE)を release まで止める */
async function holdAssetWrite(p: Page, id: string, method: "PATCH" | "DELETE"): Promise<{ release: () => void; undo: () => Promise<void> }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const handler = async (route: Route) => {
    if (route.request().method() !== method) return route.continue();
    await gate;
    return route.continue().catch(() => {});
  };
  await p.route(`**${assetsApi}/${id}`, handler);
  return { release, undo: () => p.unroute(`**${assetsApi}/${id}`, handler) };
}

test("library: a rename or delete still in flight lands in the grid even after another image is selected", async () => {
  const renameMe = await uploadImage(page, SITE.id, { name: "race-rename.png" });
  const deleteMe = await uploadImage(page, SITE.id, { name: "race-delete.png" });
  const other = await uploadImage(page, SITE.id, { name: "race-other.png" });
  await open(page, imagesPath("?per=all"));

  // 名前の変更を送っている間に、格子で別の画像を選ぶ(詳細は外れる)
  const patch = await holdAssetWrite(page, renameMe.id, "PATCH");
  await tile(page, renameMe.name).click();
  await detail(page).getByLabel("名前(管理用。公開される URL には入りません)").fill("race-renamed.png");
  await detail(page).getByRole("button", { name: "名前を保存" }).click();
  await tile(page, other.name).click();
  await expect(detail(page).getByLabel("名前(管理用。公開される URL には入りません)")).toHaveValue(other.name);
  patch.release();
  await expect(tile(page, "race-renamed.png")).toBeVisible();
  await expect(tile(page, renameMe.name)).toHaveCount(0);
  await patch.undo();

  // 削除を送っている間に、格子で別の画像を選ぶ。削除した画像は格子から消え、開いている画像の選択は外れない
  const del = await holdAssetWrite(page, deleteMe.id, "DELETE");
  await tile(page, deleteMe.name).click();
  await detail(page).getByRole("button", { name: "削除する" }).click();
  await page.getByRole("alertdialog", { name: `「${deleteMe.name}」を削除しますか` }).getByRole("button", { name: "削除する" }).press("Enter");
  await tile(page, other.name).click();
  await expect(detail(page).getByLabel("名前(管理用。公開される URL には入りません)")).toHaveValue(other.name);
  del.release();
  await expect(tile(page, deleteMe.name)).toHaveCount(0);
  await expect(page.getByText("(うち削除待ち 2 枚)")).toBeVisible();
  await expect(detail(page).getByLabel("名前(管理用。公開される URL には入りません)")).toHaveValue(other.name);
  await del.undo();
});

test("library: long names end with an ellipsis and badges are not cut mid-word (1280 / 390, light / dark)", async ({}, testInfo) => {
  for (const scheme of ["light", "dark"] as const) {
    for (const width of [1280, 390]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await open(page, imagesPath("?per=all"));
      await expect(tile(page, LONG_NAME)).toBeVisible();
      const label = `${width}px ${scheme}`;
      await testInfo.attach(`images-${width}-${scheme}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

      const m = await page.evaluate((longName) => {
        const tiles = [...document.querySelectorAll<HTMLButtonElement>("main button[title]")].filter((b) => b.querySelector("img"));
        const long = tiles.find((b) => b.title === longName)!;
        // 1 枚 = 縮小画像(.thumb。作り待ちなら中に「縮小版を作成中」の span がある)+ .meta。名前は .meta の最初の子
        const nameEl = long.children[1]!.firstElementChild as HTMLElement;
        const grid = long.parentElement!;
        const gridBox = grid.getBoundingClientRect();
        const badges = tiles.flatMap((t) => {
          const tb = t.getBoundingClientRect();
          return [...t.querySelectorAll<HTMLElement>("span > span > span")]
            .filter((s) => /^(使用 \d+|公開した内容で使用|未使用|残しました)$/.test(s.textContent ?? ""))
            .map((s) => {
              const r = s.getBoundingClientRect();
              return {
                text: s.textContent,
                clipped: s.scrollWidth > s.clientWidth + 1,
                outside: r.left < tb.left - 0.5 || r.right > tb.right + 0.5,
              };
            });
        });
        return {
          nameEllipsis: getComputedStyle(nameEl).textOverflow === "ellipsis" && nameEl.scrollWidth > nameEl.clientWidth,
          tilesOutsideGrid: tiles.filter((t) => {
            const r = t.getBoundingClientRect();
            return r.left < gridBox.left - 0.5 || r.right > gridBox.right + 0.5;
          }).length,
          gridOverflow: grid.scrollWidth > grid.clientWidth + 1,
          badgeTexts: [...new Set(badges.map((b) => b.text))].sort(),
          badBadges: badges.filter((b) => b.clipped || b.outside),
          docScroll: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
          mainWidth: document.querySelector("main")?.clientWidth ?? null,
          tileWidth: Math.round(long.getBoundingClientRect().width),
        };
      }, LONG_NAME);
      await testInfo.attach(`images-layout-${width}-${scheme}`, { body: JSON.stringify(m, null, 2), contentType: "application/json" });
      expect.soft(m.nameEllipsis, `${label}: 100 字の名前が「…」で切れる`).toBe(true);
      expect.soft(m.badgeTexts, `${label}: 4 種類の札が出ている`).toEqual(["使用 1", "公開した内容で使用", "未使用", "残しました"].sort());
      // 札は格子の 1 枚の外にはみ出さない(どの幅でも)
      expect.soft(m.badBadges.filter((b) => b.outside), `${label}: 札が格子の 1 枚の外にはみ出さない`).toEqual([]);
      // 札が文字の途中で切れないことは 1280px で表明する。390px は殻のサイドバーが畳まれず本文が約 154px しか無い(2 列で 1 枚 約 39px。2026-11-05 の実測)ため、
      // 1 文字も収まらない札が出る。これは管理画面全体の前からの制約なので記録だけにする(殻が狭い幅で畳まれるようになったら 390px でも表明する)
      if (width === 1280) expect.soft(m.badBadges.filter((b) => b.clipped), `${label}: 札が文字の途中で切れない`).toEqual([]);
      expect.soft(m.tilesOutsideGrid, `${label}: 格子の 1 枚が格子の外に出ない`).toBe(0);
      expect.soft(m.gridOverflow, `${label}: 格子が横にはみ出さない`).toBe(false);
      // どの幅でも画面全体が横にスクロールしない
      expect.soft(m.docScroll.scrollWidth, `${label}: 画面が横にスクロールしない`).toBeLessThanOrEqual(m.docScroll.clientWidth);
    }
  }
  // 390px で見出しの右の主ボタンが本文の幅から出るのは、画像の画面に固有かを比べる記録(エクスペリエンスの一覧の「新しいエクスペリエンス」と同じ測り方)
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 900 });
  const headerButton: Record<string, unknown> = {};
  for (const [name, path, label] of [
    ["images", imagesPath(), "画像をアップロード"],
    ["experiments", sitePath(), "新しいエクスペリエンス"],
  ] as const) {
    await open(page, path);
    const button = page.locator("main").getByRole(name === "images" ? "button" : "link", { name: label, exact: true }).first();
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    const main = await page.locator("main").boundingBox();
    headerButton[name] = { buttonRight: box ? Math.round(box.x + box.width) : null, mainRight: main ? Math.round(main.x + main.width) : null, viewport: 390 };
    await testInfo.attach(`header-button-390-${name}`, { body: await page.screenshot(), contentType: "image/png" });
  }
  await testInfo.attach("header-button-390", { body: JSON.stringify(headerButton, null, 2), contentType: "application/json" });
  await page.emulateMedia({ colorScheme: null });
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("library: leaving while uploading asks first", async () => {
  await open(page, imagesPath());
  const hold = await holdUploads(page);
  try {
    await page.locator('input[type="file"]').setInputFiles([pngFile("held-library.png")]);
    await expect(queueCard(page)).toContainText("アップロード中");
    await navLink(page, "目標").click();
    await expect(uploadingConfirm(page)).toBeVisible();
    await uploadingConfirm(page).getByRole("button", { name: "とどまる" }).press("Enter");
    await expect(h1(page, "画像")).toBeVisible();
    hold.release();
    await expect(queueCard(page).getByRole("heading", { name: "アップロード(1 / 1)" })).toBeVisible({ timeout: 30_000 });
  } finally {
    hold.release();
    await hold.undo();
  }
  // 送り終えた後は確認なしで移れる
  await navLink(page, "目標").click();
  await expect(h1(page, "目標")).toBeVisible();
});

test("experience: picking an image and saving shows 使用 1 in the library; dropping on the field replaces the image", async () => {
  const target = seeded[0]!;
  await open(page, expPath(EXP_PICK.id, "?tab=variants&variant=b"));
  const variant = page.getByTestId("variant-b");
  await variant.getByRole("button", { name: "画像の変更を追加" }).click();
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).getByLabel("名前で絞り込む")).toBeFocused();
  await picker(page).getByLabel("名前で絞り込む").fill(target.name);
  await tile(picker(page), target.name).click();
  await expect(picker(page)).toContainText(`選択中: ${target.name}`);
  await picker(page).getByRole("button", { name: "この画像を使う" }).click();
  await expect(picker(page)).toBeHidden();
  const field = variant.getByTestId("image-field");
  await expect(field).toContainText(target.name);
  await variant.getByLabel("セレクタ(500 字以内)").fill("img.hero");
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes(`/experiments/${EXP_PICK.id}/variants/b/changes`));
  await page.getByRole("button", { name: "保存(下書き)" }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByTestId("save-state")).toHaveText("保存しました");

  await open(page, imagesPath(`?q=${target.name}`));
  await expect(tile(page, target.name)).toContainText("使用 1");

  // IMAGE の欄に落とすと、上げてその画像にする
  await open(page, expPath(EXP_PICK.id, "?tab=variants&variant=b"));
  const field2 = page.getByTestId("variant-b").getByTestId("image-field");
  await expect(field2).toContainText(target.name);
  await dropImages(page, field2, ["field-drop.png"]);
  await expect(field2).toContainText("field-drop.png", { timeout: 30_000 });
});

test("experience: the start 409 lists the missing image; the row for this experience switches in place (unsaved draft, field upload in flight)", async () => {
  // 削除待ちにした後に Cron が消す途中の印を付けた状態を作る(実際には参照の無いことを確かめてから付く。ここでは D1 に直接書く)。開始は CAS の前に 409 asset_missing で断る
  d1Local(`update assets set deleted_at = ${Date.now() - 86_400_000}, purge_marked_at = ${Date.now()} where id = '${guardImage.id}'`);
  const path = expPath(EXP_GUARD.id);
  await open(page, path);
  const status = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/experiments/${EXP_GUARD.id}/status`));
  await page.getByRole("button", { name: /^開始/ }).click();
  const confirm = page.getByRole("alertdialog", { name: /^開始/ });
  await confirm.getByRole("button", { name: /^開始する$/ }).press("Enter");
  const res = await status;
  expect(res.status()).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe("asset_missing");
  await expect(confirm).toBeHidden();
  const problems = page.getByTestId("status-asset-problems");
  await expect(problems).toContainText("見つからない画像");
  const row = problems.getByRole("link", { name: `${EXP_GUARD.name} / B` });
  await expect(row).toBeVisible();
  const tab = (name: string) => page.getByRole("tab", { name, exact: true });

  // (a) 下書きが未保存のとき: 基本設定で名前を変えてから行を押す
  await expect(tab("基本設定")).toHaveAttribute("aria-selected", "true");
  await page.getByRole("region", { name: "基本", exact: true }).getByLabel("名前(100 字以内)").fill("E2E images guard edited");
  // 押す前に下書きが未保存であること(未保存のまま押した場面であることを確かめる)
  await expect(page.getByTestId("save-state")).toHaveText("未保存の変更あり");
  let renders = countRenders(page, path);
  await row.click();
  await expect(tab("パターン")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("variant-pick-b")).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/[?&]tab=variants/);
  await expect(page).toHaveURL(/[?&]variant=b/);
  await settle(page);
  await expect(unsavedConfirm(page)).toHaveCount(0);
  await expect(uploadingConfirm(page)).toHaveCount(0);
  renders.stop();
  expect(renders.list(), "(a) 画面の中の切り替えで描画の要求が無い").toEqual([]);

  // (b) 欄に画像を落として送っている途中: パターン A に切り替え(欄が外れる)、基本設定に戻ってから行を押す
  const hold = await holdUploads(page);
  try {
    const field = page.getByTestId("variant-b").getByTestId("image-field");
    await expect(field).toContainText("この画像はサイトの画像の一覧にありません");
    await dropImages(page, field, ["guard-replacement.png"]);
    await expect(page.getByTestId("variant-b").getByRole("status").filter({ hasText: "アップロード中" })).toBeVisible();
    await page.getByTestId("variant-pick-a").click();
    await expect(page.getByTestId("variant-a")).toBeVisible();
    // 送っている間は離れる前の確認が「アップロードの途中です」(未保存の変更より優先)
    await navLink(page, "画像").click();
    await expect(uploadingConfirm(page)).toBeVisible();
    await uploadingConfirm(page).getByRole("button", { name: "とどまる" }).press("Enter");
    await expect(uploadingConfirm(page)).toBeHidden();

    await tab("基本設定").click();
    await expect(tab("基本設定")).toHaveAttribute("aria-selected", "true");
    renders = countRenders(page, path);
    await row.click();
    await expect(tab("パターン")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("variant-pick-b")).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/[?&]tab=variants/);
    await expect(page).toHaveURL(/[?&]variant=b/);
    // 下書きは未保存のまま(切り替えで捨てていない)
    await expect(page.getByTestId("save-state")).toHaveText("未保存の変更あり");
    await settle(page);
    await expect(unsavedConfirm(page)).toHaveCount(0);
    await expect(uploadingConfirm(page)).toHaveCount(0);
    renders.stop();
    expect(renders.list(), "(b) 画面の中の切り替えで描画の要求が無い").toEqual([]);

    // 欄が外れていた間に上がった画像も、窓の一覧に入る
    // 入り方は手元の一覧への足し込み(一覧を読み直さない)ので、窓を開いても BFF の一覧の GET は増えない
    const gets = countAssetGets(page);
    hold.release();
    await page.getByTestId("variant-pick-a").click();
    await expect.poll(async () => (await page.request.get(assetsApi)).json().then((b: { assets: Array<{ name: string }> }) => b.assets.some((a) => a.name === "guard-replacement.png")), { timeout: 30_000 }).toBe(true);
    await page.getByTestId("variant-pick-b").click();
    await page.getByTestId("variant-b").getByTestId("image-field").getByRole("button", { name: "画像を選ぶ" }).click();
    await expect(picker(page)).toBeVisible();
    await picker(page).getByLabel("名前で絞り込む").fill("guard-replacement");
    await expect(tile(picker(page), "guard-replacement.png")).toBeVisible();
    await settle(page);
    gets.stop();
    expect(gets.count(), "欄が外れていた間に上がった画像は、一覧を読み直さずに窓に入る(GET 0 回)").toBe(0);
    await picker(page).getByRole("button", { name: "キャンセル" }).click();
    await expect(picker(page)).toBeHidden();
  } finally {
    hold.release();
    await hold.undo();
  }
});

test("after load: the image list is read once per screen at most (pattern screens, picker, library)", async () => {
  // 1. IMAGE の無いパターンの画面: 表示の後の取得 0 回
  let gets = countAssetGets(page);
  await open(page, expPath(EXP_NONE.id, "?tab=variants&variant=b"));
  await settle(page);
  expect(gets.count(), "1. IMAGE の無いパターンの画面: 表示の後の取得 0 回").toBe(0);

  // 4. 同じ画面で初めて窓を開く: 1 回
  await page.getByTestId("variant-b").getByRole("button", { name: "画像の変更を追加" }).click();
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).locator("button[title]").first()).toBeVisible();
  expect(gets.count(), "4. 初めて窓を開く: 1 回").toBe(1);
  //    窓の中のアップロード: POST だけ(GET は増えない)
  const posted = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === assetsApi);
  await picker(page).locator('input[type="file"]').setInputFiles([pngFile("in-picker.png")]);
  expect((await posted).status()).toBe(201);
  await expect(picker(page)).toContainText("選択中: in-picker.png");
  //    窓の中のページ分け・絞り込み
  await picker(page).getByRole("navigation", { name: "ページ" }).getByRole("button", { name: "次へ" }).click();
  await expect(picker(page).getByRole("navigation", { name: "ページ" }).getByRole("button", { name: "2", exact: true })).toHaveAttribute("aria-current", "page");
  await picker(page).getByLabel("名前で絞り込む").fill("seed-0");
  await expect(tile(picker(page), seeded[0]!.name)).toBeVisible();
  await settle(page);
  expect(gets.count(), "4. 窓の中のアップロード・ページ分け・絞り込みで GET が増えない").toBe(1);
  await picker(page).getByRole("button", { name: "キャンセル" }).click();
  gets.stop();

  // 2. IMAGE が 2 つあるパターンの画面: 1 回(欄の数だけ増えない)
  gets = countAssetGets(page);
  await open(page, expPath(EXP_TWO.id, "?tab=variants&variant=b"));
  const fields = page.getByTestId("variant-b").getByTestId("image-field");
  await expect(fields).toHaveCount(2);
  await expect(fields.nth(1)).toContainText(used2.name);
  await settle(page);
  expect(gets.count(), "2. IMAGE が 2 つあるパターンの画面: 1 回").toBe(1);
  // 3. 窓を開く → 閉じる → 開き直す: 追加 0 回
  for (let i = 0; i < 2; i++) {
    await fields.first().getByRole("button", { name: "別の画像にする" }).click();
    await expect(picker(page)).toBeVisible();
    await expect(tile(picker(page), used1.name)).toHaveAttribute("aria-pressed", "true");
    await picker(page).getByRole("button", { name: "キャンセル" }).click();
    await expect(picker(page)).toBeHidden();
  }
  await settle(page);
  expect(gets.count(), "3. 窓を開き直しても追加の取得 0 回").toBe(1);
  gets.stop();

  // 5. 画像の一覧の画面: 一覧は描画(サーバー)で読み、全件が INLINE_ASSETS_MAX(96)以下なら全件を渡すので、表示の後のブラウザからの取得は 0 回。
  //    ページ分け・絞り込み・並べ替え・アップロードの後も 0 回(96 を超えるサイトは次の test で、マウントの後に 1 回)
  gets = countAssetGets(page);
  await open(page, imagesPath());
  await page.getByRole("group", { name: "一度に表示" }).getByRole("button", { name: "24", exact: true }).click();
  await page.getByRole("navigation", { name: "ページ" }).getByRole("button", { name: "次へ" }).click();
  await expect(page.getByRole("navigation", { name: "ページ" }).getByRole("button", { name: "2", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByLabel("並べる順").selectOption("name");
  await page.getByRole("group", { name: "使っているか" }).getByRole("button", { name: "使っている", exact: true }).click();
  await page.getByLabel("名前で絞り込む").fill("used");
  await expect(tile(page, used1.name)).toBeVisible();
  const posted2 = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === assetsApi);
  await page.locator('input[type="file"]').setInputFiles([pngFile("after-filters.png")]);
  expect((await posted2).status()).toBe(201);
  await expect(queueCard(page).getByRole("heading", { name: "アップロード(1 / 1)" })).toBeVisible();
  await settle(page);
  expect(gets.count(), "5. 一覧の画面のページ分け・絞り込み・並べ替え・アップロードで GET 0 回").toBe(0);
  gets.stop();
});

/**
 * 一覧の GET(BFF)を release まで止め、止める前に読んでおいた古い本文を返す(control には届けない)。
 * GET が画面の書き込みより前に読んでいた場合(応答に書き込みが入っていない)を作り、手元の当て直しを部品の配線ごと確かめる
 */
async function holdListGetWithStaleBody(p: Page): Promise<{ release: () => void; undo: () => Promise<void>; stale: { assets: { id: string }[] } }> {
  const res = await p.request.get(assetsApi);
  expect(res.status()).toBe(200);
  const body = await res.text();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const handler = async (route: Route) => {
    if (route.request().method() !== "GET") return route.continue();
    await gate;
    return route.fulfill({ status: 200, contentType: "application/json", body }).catch(() => {});
  };
  await p.route(`**${assetsApi}`, handler);
  return { release, undo: () => p.unroute(`**${assetsApi}`, handler), stale: JSON.parse(body) };
}

test("library over 96 images: the first page comes with the screen, the rest is read once after mount, and edits made meanwhile survive", async () => {
  // 96 枚を超えるように、R2 に中身の無い行を古い時刻で足す(格子の画像は読めないが、一覧・ページ・数の確かめには要らない)。この後の test は数に頼らない
  const base = Date.now() - 86_400_000;
  const owner = `(SELECT created_by FROM assets WHERE id = '${seeded[0]!.id}')`;
  d1Local(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
     INSERT INTO assets (id, site_id, name, name_key, r2_key, public_url, mime, size, thumb_state, created_by, created_at, updated_at)
     SELECT 'bulk_' || printf('%03d', i), '${SITE.id}', 'bulk-' || printf('%03d', i) || '.png', 'bulk-' || printf('%03d', i) || '.png',
            'sites/${SITE.id}/images/bulk_' || printf('%03d', i) || '.png', 'http://localhost:8799/dev-assets/sites/${SITE.id}/images/bulk_' || printf('%03d', i) || '.png',
            'image/png', 100, 'skipped', ${owner},${base} - i * 1000, ${base}
     FROM n`,
  );
  // 読み終わる前に名前を変える・削除する画像(いちばん新しいので、描画で渡す最初のページに入る)
  const renameMe = await uploadImage(page, SITE.id, { name: "window-rename.png" });
  const deleteMe = await uploadImage(page, SITE.id, { name: "window-delete.png" });

  // 古い本文はここで読む: 名前の変更の前・削除の前・アップロードの前の一覧(BFF の GET がこれらより前に読んだ場合)
  const hold = await holdListGetWithStaleBody(page);
  const total = hold.stale.assets.length;
  expect(total).toBeGreaterThan(96);
  expect(hold.stale.assets.map((a) => a.id)).toEqual(expect.arrayContaining([renameMe.id, deleteMe.id]));
  // 数えるのは古い本文を読んだ後から(page.request の GET は画面の要求ではないが、念のため)
  const gets = countAssetGets(page);
  const nameField = () => detail(page).getByLabel("名前(管理用。公開される URL には入りません)");
  try {
    // 描画で渡した最初のページ(新しい順の 24 枚)と全体の数は、全件を読む前から出る
    await open(page, imagesPath("?per=24"));
    await expect(page.getByRole("status").filter({ hasText: "画像の一覧の残りを読み込んでいます" })).toBeVisible();
    await expect(page.locator("main button[title]").filter({ has: page.locator("img") })).toHaveCount(24);
    await expect(page.getByText(`${total} 枚`, { exact: true })).toBeVisible();
    await expect(tile(page, "bulk-001.png")).toHaveCount(0);
    // 読み終わる前の書き込み 3 つ(古い本文にはどれも入っていない): アップロード・名前の変更・削除
    const posted = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === assetsApi);
    await page.locator('input[type="file"]').setInputFiles([pngFile("before-full-list.png")]);
    expect((await posted).status()).toBe(201);
    await tile(page, renameMe.name).click();
    await nameField().fill("window-renamed.png");
    const patched = page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `${assetsApi}/${renameMe.id}`);
    await detail(page).getByRole("button", { name: "名前を保存" }).click();
    expect((await patched).status()).toBe(200);
    await expect(tile(page, "window-renamed.png")).toBeVisible();
    await tile(page, deleteMe.name).click();
    await detail(page).getByRole("button", { name: "削除する" }).click();
    const deleted = page.waitForResponse((r) => r.request().method() === "DELETE" && new URL(r.url()).pathname === `${assetsApi}/${deleteMe.id}`);
    await page.getByRole("alertdialog", { name: `「${deleteMe.name}」を削除しますか` }).getByRole("button", { name: "削除する" }).press("Enter");
    expect((await deleted).status()).toBe(200);
    await expect(tile(page, deleteMe.name)).toHaveCount(0);
    // 最後のページへ送ると、読み終わるまでは「読み込んでいます」だけ
    const last = Math.ceil(total / 24);
    await page.getByRole("navigation", { name: "ページ" }).getByRole("button", { name: String(last), exact: true }).click();
    await expect(page.locator("main button[title]").filter({ has: page.locator("img") })).toHaveCount(0);
    hold.release();
    // 全件(古い本文)が届くと、最後のページ(いちばん古い bulk-100)が出て、読み込み中の表示が消える
    await expect(tile(page, "bulk-100.png")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "画像の一覧の残りを読み込んでいます" })).toHaveCount(0);
    await page.getByRole("navigation", { name: "ページ" }).getByRole("button", { name: "1", exact: true }).click();
    // 古い本文に負けない: 上げた画像は足され、名前の変更は新しい名前のまま、削除した画像は戻らない(数 = 古い本文 + 1 - 1)
    await expect(tile(page, "before-full-list.png")).toBeVisible();
    await expect(tile(page, "window-renamed.png")).toBeVisible();
    await expect(tile(page, renameMe.name)).toHaveCount(0);
    await expect(tile(page, deleteMe.name)).toHaveCount(0);
    await expect(page.getByText(`${total} 枚`, { exact: true })).toBeVisible();
    await settle(page);
    expect(gets.count(), "96 枚を超えるサイトの一覧の画面: マウントの後の 1 回だけ").toBe(1);
  } finally {
    hold.release();
    await hold.undo();
    gets.stop();
  }
});

test("viewer: no upload, drop area, name field or delete on the library", async ({ browser }) => {
  await openMembers(page);
  const url = await issueInvite(page, VIEWER_EMAIL, /^閲覧者/);
  const viewer = await acceptInvite(browser, url, "Images Viewer");
  try {
    await open(viewer.page, imagesPath("?per=all"));
    await expect(h1(viewer.page, "画像")).toBeVisible();
    await expect(viewer.page.getByRole("button", { name: "画像をアップロード" })).toHaveCount(0);
    await expect(viewer.page.getByText(/ドラッグ&ドロップしてアップロードできます/)).toHaveCount(0);
    await expect(viewer.page.locator('input[type="file"]')).toHaveCount(0);
    await tile(viewer.page, used1.name).click();
    await expect(detail(viewer.page).getByRole("heading", { name: used1.name })).toBeVisible();
    await expect(detail(viewer.page).getByLabel("名前(管理用。公開される URL には入りません)")).toHaveCount(0);
    await expect(detail(viewer.page).getByRole("button", { name: "削除する" })).toHaveCount(0);
    // 落としても覆いが出ず、上げない
    let posts = 0;
    viewer.page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === assetsApi) posts += 1;
    });
    await dropImages(viewer.page, null, ["viewer-drop.png"]);
    await settle(viewer.page);
    expect(posts, "閲覧者のドロップでアップロードの POST が出ない").toBe(0);
    await expect(viewer.page.getByRole("status", { name: "アップロードの結果" })).toHaveCount(0);
  } finally {
    await viewer.ctx.close();
  }
});

test("menu: without R2 and without the uploader, 画像 is not in the menu", async () => {
  // E2E の control は R2 のある 1 つの構成で起動する(playwright.config.ts の AB_ASSET_PUBLIC_BASE)。左メニューは外枠がサーバーで読んだ
  // /capabilities で描くので、ブラウザの差し替え(page.route)では出し分けを変えられない。出し分けは test/nav.test.ts と test/images.test.ts の
  // imagesPageMode が確かめる。R2 なしの control を別に起動する構成を足すまで飛ばす
  test.skip(true, "E2E の control は R2 のある構成だけで起動する(左メニューの出し分けはサーバーの描画で決まり、ブラウザから差し替えられない)。unit の nav.test.ts が確かめる");
});

test("menu: without R2 and with the uploader, 画像 opens the uploader screen", async () => {
  test.skip(true, "R2 なしの画像アップローダーが main に入るまで飛ばす(画面と /capabilities の imageUploader はアップローダーの作業が足す)");
});
