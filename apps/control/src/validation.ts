import {
  analyticsValueIssue,
  attributeChangeIssue,
  audienceDefinitionIssue,
  ChangeSchema,
  experimentTargetingIssue,
  exposurePayloadIssue,
  findLegacyTargeting,
  findRemovedPageCondition,
  isOldUrlMatch,
  LEGACY_TARGETING_HINT,
  LEGACY_TARGETING_MESSAGE,
  LIMITS,
  maxWithinDays,
  normalizePageMatch,
  normalizeTargeting,
  normalizeUrlMatch,
  pageMatchIssue,
  PAGE_CONDITION_MOVED_AUDIENCE_HINT,
  PAGE_CONDITION_MOVED_AUDIENCE_MESSAGE,
  PAGE_CONDITION_MOVED_HINT,
  PAGE_CONDITION_MOVED_MESSAGE,
  urlMatchIssue,
  regexIssueIn,
  resolveExposurePayload,
  targetingReferences,
  type Change,
  type PageMatchInput,
  type Path,
  type RegexIssue,
  type Targeting,
  type UrlMatchInput,
  type ExperimentAnalytics,
  type VariantAnalytics,
} from "@wtt/core";
import { sql } from "kysely";
import { canonical, findEncodedAssetUrls } from "./asset-refs";
import { imageStore, IMAGE_DISABLED_HINT, uploaderPublicBase } from "./capabilities";
import type { Db, SiteRow } from "./db";
import type { Env } from "./env";
import { ApiError, validationFailed } from "./errors";

/**
 * spec §13.5: Experiment / Variant / Goal の name は 100 字以内。素の文字列長(全角も 1 文字)。
 * B77(K11): 名前は compiled config に出さず(dataLayer の名前は外部計測の指定 ?? ID)、上限は管理画面の表示のために保つ。
 * `path` は封筒の契約(`ErrorEnvelopeSchema` の `array<string|number>`)に合わせて配列で渡す(決定 34)
 */
export const NAME_MAX = 100;
export function assertName(name: string, path: (string | number)[]): void {
  if (name.length > NAME_MAX)
    throw new ApiError(422, "name_too_long", { path, max: NAME_MAX, message: "名前が長すぎます(100 字以内)", hint: "名前は管理画面の中だけで使います。100 字以内にしてください" });
}

/** 受け口のスキーマの `analytics` に付ける説明(/openapi.json)。値の規則は assertAnalyticsValues が見る */
export const ANALYTICS_REQUEST_DESCRIPTION =
  "外部計測(dataLayer に出す名前の指定と追加の値)。値は 1〜100 字で、改行・タブなどの制御文字は使えない(保存済みと同じ値は検査しない)。null は指定なし(更新では消す)";

/** 目標の受け口の `analytics` の説明(/openapi.json)。目標には追加の値(extra)が無く、名前の指定だけ */
export const GOAL_ANALYTICS_REQUEST_DESCRIPTION =
  "外部計測(dataLayer に出す目標名の指定)。値は 1〜100 字で、改行・タブなどの制御文字は使えない(保存済みと同じ値は検査しない)。null は指定なし(更新では消す)";

/** 外部計測(エクスペリエンス・パターン・目標の analytics)の、値の検査に使う部分 */
type AnalyticsValues = { overrides?: Record<string, string | undefined>; extra?: Record<string, string> };

/**
 * B77(K12): dataLayer に出す値(名前の指定と追加の値)の保存時の検査。`next` のすべての値を core の analyticsValueIssue に通し、
 * 最初の問題で 422 invalid_analytics_value(`path` = `[...path, "overrides" | "extra", キー]`、`code`・`message` は core のもの)。
 * `prev`(保存済みの analytics。新規は null)の同じ場所と同じ値は見ない — 制御文字を含む古い値(マイグレーションで写した名前)が
 * あっても、他の欄の保存を止めないため。キーの規則と strict は受け口のスキーマ(core の …AnalyticsRequestSchema)が見る
 */
export function assertAnalyticsValues(next: AnalyticsValues | null | undefined, prev: AnalyticsValues | null, path: (string | number)[]): void {
  if (!next) return;
  for (const group of ["overrides", "extra"] as const) {
    for (const [key, value] of Object.entries(next[group] ?? {})) {
      if (value === undefined || prev?.[group]?.[key] === value) continue;
      const issue = analyticsValueIssue(value);
      if (issue) throw new ApiError(422, "invalid_analytics_value", { path: [...path, group, key], code: issue.code, message: issue.message });
    }
  }
}

/**
 * B77(K9): エクスペリエンスとパターンのメモ(社内用。config には出さない)は 1,000 字まで。素の文字列長で数える。
 * `path` は封筒の契約に合わせて配列で渡す
 */
export const DESCRIPTION_MAX = 1000;
export function assertDescription(value: string, path: (string | number)[]): void {
  if (value.length > DESCRIPTION_MAX)
    throw new ApiError(422, "description_too_long", { path, max: DESCRIPTION_MAX, message: "メモが長すぎます(1,000 字以内)", hint: "1,000 字以内にしてください" });
}

/** spec §13.9: Goal / オーディエンス / タイムゾーンの変更は Site レベルで「未公開の変更」として拾う */
export async function touchSite(db: Db, siteId: string, nowMs: number): Promise<void> {
  await db.updateTable("sites").set({ content_updated_at: nowMs, updated_at: nowMs }).where("id", "=", siteId).execute();
}

/**
 * B68 spec §4.5 の 1: IMAGE の `src` が、このサイトのアップローダーの URL(`<AB_UPLOADER_PUBLIC_BASE>/u/<sid>/` で始まる。正規化した形で比べる)か。
 * 当たれば D1 の `assets` を見ずに受ける(アップローダーの画像は `assets` に入らないため)。R2 の有無によらない
 */
export function isUploaderImageSrc(env: Env, siteId: string, src: unknown): boolean {
  const up = uploaderPublicBase(env);
  if (up === null || typeof src !== "string") return false;
  const href = canonical(src);
  const prefix = canonical(`${up}/u/${siteId}/`);
  return href !== null && prefix !== null && href.startsWith(prefix);
}

/** B68 spec §22.4: payload のすべての文字列の値(深さを問わない)。符号化した参照の検査が使う */
function stringValues(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringValues(x, out);
  else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) stringValues(x, out);
  return out;
}

/**
 * spec §11: Change の保存時検証。core の ChangeSchema(64KB / ATTRIBUTE allowlist / URL scheme)を通し、
 * 失敗理由を機械可読コードに変換する。IMAGE はこのサイトのアップローダーの URL か、Site の R2 公開ドメイン配下のみ(§11 / §6.4 / B68 §4.5)。
 * 一覧(D1)との照らしは非同期なので、ここではせず assertImageAssetsExist が 1 回でまとめて行う。
 * `index` は変更の位置(422 の `path` = `["changes", index]`)
 */
export function parseChange(env: Env, siteId: string, raw: unknown, index = 0): Change {
  // allowlist は schema より先に自前で判定してコード付きの 422 にする(schema の message 依存を避ける)
  if (typeof raw === "object" && raw !== null && (raw as { type?: string }).type === "ATTRIBUTE") {
    const p = (raw as { payload?: { name?: unknown; value?: unknown } }).payload;
    if (p && typeof p.name === "string" && typeof p.value === "string") {
      const issue = attributeChangeIssue({ name: p.name, value: p.value });
      if (issue) {
        // issue.message は core(packages/core/src/schema.ts)の英語診断文。封筒の message は必須の日本語(決定 34)なので
        // ここで日本語に差し替え、英語の詳細は `detail` に残す(UI には出さないが原因調査には残る)
        throw new ApiError(422, issue.code, {
          attribute: p.name,
          hint: issue.code === "attribute_not_allowed" ? "HTML タイプを使ってください" : "http(s) か相対 URL だけを指定できます",
          message: issue.code === "attribute_not_allowed" ? `属性 ${p.name} は ATTRIBUTE では設定できません` : `属性 ${p.name} には http(s) か相対 URL だけを指定できます`,
          detail: issue.message,
        });
      }
    }
  }
  const store = imageStore(env);
  // IMAGE は schema(絶対 URL)より先に、確かめる順(B68 spec §4.5。アップローダーの spec §10 の表)で見る。
  // 相対 URL も「配下でない」として同じ 422 に落とす(§6.4 / §11)
  if (typeof raw === "object" && raw !== null && (raw as { type?: string }).type === "IMAGE") {
    const src = (raw as { payload?: { src?: unknown } }).payload?.src;
    // 1. このサイトのアップローダーの URL なら受け、以降を見ない(Q243)
    if (!isUploaderImageSrc(env, siteId, src)) {
      const up = uploaderPublicBase(env);
      // 2. R2 もアップローダーの公開ベースも無ければ 422 image_upload_disabled(決定 43 (5))
      if (!store && up === null) throw new ApiError(422, "image_upload_disabled", { hint: IMAGE_DISABLED_HINT });
      // 3. R2 の配下か。素の startsWith だと `…/sites/<sid>/../other/x.png` が通ってしまう。URL として正規化してから比べ、
      // ドットセグメントを取り除いた姿で判定する(公開ドメインなのでテナント漏洩ではないが、
      // fail-closed の検査は名前どおりの意味であるべき)。WHATWG URL のパーサは `%2e` / `.%2e` / `%2e%2e`(大文字小文字を問わず)
      // もドットセグメントとして解決するので、`%2e` を別途拒否する必要はない(判定は正規化後の配下判定の 1 本。rulings §4 CX-Low-1)。
      // R2 が無くアップローダーだけの導入で 1 に当たらなかったときも同じ 422(P = [アップローダー])
      const r2Prefix = store ? `${store.publicBase}/sites/${siteId}/` : null;
      const href = typeof src === "string" ? canonical(src) : null;
      if (r2Prefix === null || href === null || !href.startsWith(canonical(r2Prefix) ?? r2Prefix)) {
        const allowedPrefixes = [...(r2Prefix ? [r2Prefix] : []), ...(up !== null ? [`${up}/u/${siteId}/`] : [])];
        throw new ApiError(422, "image_outside_r2_domain", {
          allowedPrefix: allowedPrefixes[0],
          allowedPrefixes,
          message: "画像 URL がこのサイトにアップロードした画像の URL ではありません",
          hint: "IMAGE には、このサイトにアップロードした画像の URL だけを指定できます(左メニューの「画像」からコピーできます)。サイト内の既存画像は ATTRIBUTE(src)で差し替えてください",
        });
      }
      // 4. 一覧との照らしは assertImageAssetsExist(保存 1 回で D1 を 1 回)
    }
  }
  const parsed = ChangeSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    if (first?.message.startsWith("payload over"))
      throw new ApiError(422, "change_too_large", { max: LIMITS.changeValueMaxBytes, message: `変更の内容が大きすぎます(最大 ${LIMITS.changeValueMaxBytes} バイト)` });
    // first?.message は zod の英語メッセージ。UI に日本語の message を渡し、詳細は `detail` に残す
    throw new ApiError(422, "invalid_change", { path: first?.path.map(String), message: "変更の内容が不正です", detail: first?.message });
  }
  // B68 spec §22.4: 画像の URL を符号化した参照は種類を問わず断る(公開の確かめは URL がそのまま現れる形だけを拾うため)。
  // D1 は読まない。R2 が無い導入では何もしない。`&`・`\`・`%` を含む文字列だけ戻す(findEncodedAssetUrls の中)
  if (store) {
    for (const value of stringValues(parsed.data.payload)) {
      if (findEncodedAssetUrls(value, store.publicBase).length > 0)
        throw new ApiError(422, "asset_ref_encoded", { path: ["changes", index], hint: "画像の URL は、文字参照・エスケープ・% の形にせず、そのまま書いてください" });
    }
  }
  return parsed.data;
}

/**
 * B68 spec §4.5: 一覧(このサイト・削除待ちでない)に無い公開 URL の集合。`srcs` が空なら D1 を読まない。
 * あれば 1 回(バインド 2 個。100 件でも D1 の 1 文のバインドの上限 100 に当たらない)。比べるのは送られた文字列そのもの(public_url と同じ形)
 */
export async function findMissingImageAssets(db: Db, siteId: string, srcs: string[]): Promise<Set<string>> {
  const want = [...new Set(srcs)];
  if (want.length === 0) return new Set();
  const rows = await db
    .selectFrom("assets")
    .select("public_url")
    .where("site_id", "=", siteId)
    .where("deleted_at", "is", null)
    .where("public_url", "in", sql<string>`(select value from json_each(${JSON.stringify(want)}))`)
    .execute();
  const found = new Set(rows.map((r) => r.public_url));
  return new Set(want.filter((s) => !found.has(s)));
}

/**
 * B68 spec §4.5 の 4: IMAGE の `src`(アップローダーの URL として受けたものを除く)が一覧にあり、削除待ち・消す途中でないか。
 * 無い最初の 1 つで 422 asset_not_found(`path` = `["changes", i, "src"]`)。保存の batch より前に呼び、断るときは何も書かない。
 * IMAGE が無い保存は D1 を読まない
 */
export async function assertImageAssetsExist(db: Db, env: Env, siteId: string, changes: Change[]): Promise<void> {
  const targets: Array<{ i: number; src: string }> = [];
  changes.forEach((ch, i) => {
    if (ch.type === "IMAGE" && !isUploaderImageSrc(env, siteId, ch.payload.src)) targets.push({ i, src: ch.payload.src });
  });
  const missing = await findMissingImageAssets(
    db,
    siteId,
    targets.map((t) => t.src),
  );
  const first = targets.find((t) => missing.has(t.src));
  if (first)
    throw new ApiError(422, "asset_not_found", {
      path: ["changes", first.i, "src"],
      hint: "この画像はサイトの画像の一覧にありません。削除された可能性があります。画像を選び直してください",
    });
}

/** spec §10.9: Experiment × Variant を解決した姿に対して検証する(compile と同じ関数) */
export function assertExperimentAnalytics(
  exp: { id: string; name: string; analytics?: ExperimentAnalytics | undefined },
  variants: Array<{ id: string; name: string; analytics?: VariantAnalytics | undefined }>,
): void {
  for (const v of variants) {
    const issue = exposurePayloadIssue(resolveExposurePayload(exp, v));
    // issue は core(packages/core/src/analytics.ts)の英語診断文。`hint` は describeError が message と
    // 連結して UI に出す(review 指摘: ここに英語を置くと日本語化の意味がない)ので、UI に出ない `detail` に置く。
    // message は現状 exposurePayloadIssue の失敗理由が 1 種類(extra キー数超過)だが決め打ちにせず中立文にする
    // (理由が増えたときに message が事実と違う文言を語らないため)
    if (issue) throw new ApiError(422, "invalid_analytics", { path: ["variants", v.id], message: "外部計測の設定が不正です", detail: issue });
  }
}

/**
 * 決定 49(設計書 §10.4): 正規表現の検査の 422。理由のコード・日本語の説明・式の中の位置(index / length)・書き換えの例を、
 * 画面・API・エージェントで同じものとして返す。`path` は値の欄(管理画面が欄の下に出す)
 */
export function regexIssueError(issue: RegexIssue, path: Array<string | number>): ApiError {
  return new ApiError(422, issue.code, {
    path,
    message: issue.message,
    ...(issue.example !== undefined ? { hint: `書き換えの例: ${issue.example}` } : {}),
    index: issue.index,
    length: issue.length,
  });
}

/** 対象 URL・目標の PAGEVIEW のページの一致を正規化して検査する(保存する値は正規化した後のもの。設計書 §4.1.2) */
export function normalizedPageMatch(m: PageMatchInput, path: Array<string | number>): PageMatchInput {
  const n = normalizePageMatch(m);
  const issue = pageMatchIssue(n);
  if (issue) throw regexIssueError(issue, [...path, "value"]);
  return n;
}

/**
 * B69(spec §2.1): 対象 URL の正規化と検査。各行の page は対象 URL・目標と同じ normalizedPageMatch(正規表現の 422 は index / length 付き。
 * `path` = [...path, "include" | "exclude", 行, "page", "value"])、その後に全行の命令数の合計の上限(url_match_too_large)。
 * 保存する値は正規化した後のもの(行とパラメータの順は入力のまま)
 */
export function normalizedUrlMatch(m: UrlMatchInput, path: Path): UrlMatchInput {
  const n = normalizeUrlMatch(m);
  for (const key of ["include", "exclude"] as const) for (const [i, r] of (n[key] ?? []).entries()) normalizedPageMatch(r.page, [...path, key, i, "page"]);
  const issue = urlMatchIssue(n);
  if (issue) throw new ApiError(422, issue.code, { path: [...path, ...issue.path], message: issue.message, ...(issue.hint ? { hint: issue.hint } : {}) });
  return n;
}

/** B69(spec §9.2): 古い形の urlMatch(一番外側に op / value / part)を送った呼び出し元への案内 */
export const OLD_URL_MATCH_MESSAGE = "対象 URL(urlMatch)の形が変わりました。含める行(include)の配列で書きます";
export const OLD_URL_MATCH_HINT =
  '1 つのページの一致は、含める 1 行の page に入れてください(例: { "include": [{ "page": { "part": "path", "op": "startsWith", "value": "/lp/" } }] })';

const field = (data: unknown, key: string): unknown => (typeof data === "object" && data !== null ? (data as Record<string, unknown>)[key] : undefined);

/**
 * 理由の分かる失敗を、zod の形の検査より先に見つけて 422 にする。validator の hook から呼ぶ(失敗時の data は生の入力)。順に:
 * - 古い形の urlMatch(エクスペリエンスだけ。B69)→ invalid_input
 * - 配信条件・オーディエンスから外したページの条件(B69、spec §4)→ invalid_experiment_targeting / invalid_audience_definition
 * - 古い書式(URL パターンの ID を参照する閲覧の条件)→ legacy_targeting
 * どれでもなければ今までどおり validation_failed
 */
export function targetingValidationFailed(data: unknown, err: Parameters<typeof validationFailed>[0], key: string, kind: "experiment" | "audience" = "experiment"): ApiError {
  if (kind === "experiment" && isOldUrlMatch(field(data, "urlMatch")))
    return new ApiError(422, "invalid_input", { path: ["urlMatch"], message: OLD_URL_MATCH_MESSAGE, hint: OLD_URL_MATCH_HINT });
  const moved = findRemovedPageCondition(field(data, key));
  if (moved) return pageConditionMovedError(kind, [key, ...moved]);
  const at = findLegacyTargeting(field(data, key));
  if (at) return new ApiError(422, "legacy_targeting", { path: [key, ...at], message: LEGACY_TARGETING_MESSAGE, hint: LEGACY_TARGETING_HINT });
  return validationFailed(err);
}

/**
 * B69(spec §4): 外したページの条件の 422。kind = experiment はエクスペリエンスの配信条件(`invalid_experiment_targeting`)、
 * audience はオーディエンスの定義(`invalid_audience_definition`)。`code` を替えたいとき(開始・再開・下書きでオーディエンス経由に
 * 見つけたとき)は extra.code で渡す
 */
export function pageConditionMovedError(kind: "experiment" | "audience", path: Path, extra: { code?: string; audience?: string; experiment?: string } = {}): ApiError {
  const code = extra.code ?? (kind === "experiment" ? "invalid_experiment_targeting" : "invalid_audience_definition");
  return new ApiError(422, code, {
    path,
    ...(extra.experiment !== undefined ? { experiment: extra.experiment } : {}),
    ...(extra.audience !== undefined ? { audience: extra.audience } : {}),
    message: kind === "experiment" ? PAGE_CONDITION_MOVED_MESSAGE : PAGE_CONDITION_MOVED_AUDIENCE_MESSAGE,
    hint: kind === "experiment" ? PAGE_CONDITION_MOVED_HINT : PAGE_CONDITION_MOVED_AUDIENCE_HINT,
  });
}

/**
 * B69(spec §6.2.1): 開始・再開・下書きの確かめの前に、配信条件と、参照するオーディエンスの定義(`audiences` = ID → 定義。同じサイトのもの)に
 * 外したページの条件が残っていないか。見つけたら 422 invalid_experiment_targeting(オーディエンス経由ならオーディエンスの文言と `audience`)。
 * D1 は読まない(呼び出し元が読んだ値を渡す)。`experiment` を渡すと封筒に入れる(サイトの下書きをまとめて確かめるときに、どれかを示す)
 */
export function assertNoRemovedPageCondition(targeting: unknown, audiences: Readonly<Record<string, unknown>>, experiment?: string): void {
  const ids = experiment !== undefined ? { experiment } : {};
  const direct = findRemovedPageCondition(targeting);
  if (direct) throw pageConditionMovedError("experiment", ["targeting", ...direct], ids);
  for (const a of targetingReferences(targeting).audiences) {
    if (!Object.prototype.hasOwnProperty.call(audiences, a)) continue;
    const at = findRemovedPageCondition(audiences[a]);
    if (at) throw pageConditionMovedError("audience", ["targeting"], { ...ids, code: "invalid_experiment_targeting", audience: a });
  }
}

/**
 * 保存する配信条件(kind = experiment)・オーディエンスの定義(kind = audience)の正規化と検査(決定 49): 正規化 → 正規表現 →
 * 形の制限(エクスペリエンス)/ 入れ子・参照の禁止(オーディエンス)。保存する値は正規化した後のもの。field は 422 の path の先頭
 */
export function normalizedTargeting(node: Targeting | null, kind: "experiment" | "audience", field: string): Targeting | null {
  if (!node) return null;
  const n = normalizeTargeting(node);
  const rx = regexIssueIn(n);
  if (rx) throw regexIssueError(rx.issue, [field, ...rx.path]);
  const issue = kind === "experiment" ? experimentTargetingIssue(n) : audienceDefinitionIssue(n);
  if (issue) throw new ApiError(422, issue.code, { path: [field, ...issue.path], message: issue.message, ...(issue.hint ? { hint: issue.hint } : {}) });
  return n;
}

/** 期間の N が Site の訪問者データの保存期間を超える(設計書 §11) */
export function withinDaysError(n: number, max: number, path: Array<string | number>): ApiError {
  return new ApiError(422, "within_days_exceeds_retention", {
    path,
    max,
    message: `期間(${n} 日)が訪問者データの保存期間(${max} 日)を超えています`,
    hint: `${max} 日以下にしてください。長い期間を使うには、サイト設定で保存期間を延ばします`,
  });
}

/** spec §13.6 手順 1 を保存時に前倒しする: 参照する Goal・オーディエンスの存在と、期間の上限(Publish でも compile が同じ検査をする) */
export async function assertTargetingRefs(db: Db, site: Pick<SiteRow, "id" | "retention_days">, targeting: Targeting | null, field: string): Promise<void> {
  if (!targeting) return;
  const refs = targetingReferences(targeting);
  for (const g of refs.goals) {
    const hit = await db.selectFrom("goals").select("id").where("site_id", "=", site.id).where("id", "=", g).executeTakeFirst();
    if (!hit) throw new ApiError(422, "unknown_goal", { goal: g, path: [field], message: "参照している目標が見つかりません", hint: "先に目標を作成してください" });
  }
  for (const a of refs.audiences) {
    const hit = await db.selectFrom("audiences").select("id").where("site_id", "=", site.id).where("id", "=", a).executeTakeFirst();
    if (!hit) throw new ApiError(422, "unknown_audience", { audience: a, path: [field], message: "参照しているオーディエンスが見つかりません", hint: "先にオーディエンスを作成してください" });
  }
  const n = maxWithinDays(targeting);
  if (n > site.retention_days) throw withinDaysError(n, site.retention_days, [field]);
}
