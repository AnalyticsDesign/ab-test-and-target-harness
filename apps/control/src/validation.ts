import {
  attributeChangeIssue,
  audienceDefinitionIssue,
  ChangeSchema,
  experimentTargetingIssue,
  exposurePayloadIssue,
  findLegacyTargeting,
  LEGACY_TARGETING_HINT,
  LEGACY_TARGETING_MESSAGE,
  LIMITS,
  maxWithinDays,
  normalizePageMatch,
  normalizeTargeting,
  pageMatchIssue,
  regexIssueIn,
  resolveExposurePayload,
  targetingReferences,
  type Change,
  type PageMatchInput,
  type RegexIssue,
  type Targeting,
  type ExperimentAnalytics,
  type VariantAnalytics,
} from "@wtt/core";
import { imageStore, IMAGE_DISABLED_HINT } from "./capabilities";
import type { Db, SiteRow } from "./db";
import type { Env } from "./env";
import { ApiError, validationFailed } from "./errors";

/**
 * spec §10.9 / §13.5: 導出値(Experiment / Variant / Goal の name)は 100 字以内。素の文字列長(GA4 は全角も 1 文字)。
 * `path` は封筒の契約(`ErrorEnvelopeSchema` の `array<string|number>`)に合わせて配列で渡す(決定 34)
 */
export const NAME_MAX = 100;
export function assertName(name: string, path: (string | number)[]): void {
  if (name.length > NAME_MAX)
    throw new ApiError(422, "name_too_long", { path, max: NAME_MAX, message: "名前が長すぎます(100 字以内)", hint: "GA4 は 100 字超のパラメータ値を破棄します" });
}

/** spec §13.9: Goal / オーディエンス / タイムゾーンの変更は Site レベルで「未公開の変更」として拾う */
export async function touchSite(db: Db, siteId: string, nowMs: number): Promise<void> {
  await db.updateTable("sites").set({ content_updated_at: nowMs, updated_at: nowMs }).where("id", "=", siteId).execute();
}

/**
 * spec §11: Change の保存時検証。core の ChangeSchema(64KB / ATTRIBUTE allowlist / URL scheme)を通し、
 * 失敗理由を機械可読コードに変換する。IMAGE は Site の R2 公開ドメイン配下のみ(§11 / §6.4)
 */
export function parseChange(env: Env, siteId: string, raw: unknown): Change {
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
  // IMAGE は schema(絶対 URL)より先に R2 配下かを見る。相対 URL も「配下でない」として同じ 422 に落とす(§6.4 / §11)
  if (typeof raw === "object" && raw !== null && (raw as { type?: string }).type === "IMAGE") {
    const src = (raw as { payload?: { src?: unknown } }).payload?.src;
    // 決定 43 (5): R2 なしでは配下検査より先に 422 image_upload_disabled
    const store = imageStore(env);
    if (!store) throw new ApiError(422, "image_upload_disabled", { hint: IMAGE_DISABLED_HINT });
    const prefix = `${store.publicBase}/sites/${siteId}/`;
    // 素の startsWith だと `…/sites/<sid>/../other/x.png` が通ってしまう。URL として正規化してから比べ、
    // ドットセグメントを取り除いた姿で判定する(公開ドメインなのでテナント漏洩ではないが、
    // fail-closed の検査は名前どおりの意味であるべき)。WHATWG URL のパーサは `%2e` / `.%2e` / `%2e%2e`(大文字小文字を問わず)
    // もドットセグメントとして解決するので、`%2e` を別途拒否する必要はない(判定は正規化後の配下判定の 1 本。rulings §4 CX-Low-1)
    const canonical = (u: string): string | null => {
      try {
        return new URL(u).href;
      } catch {
        return null; // 相対 URL・URL でない文字列
      }
    };
    const href = typeof src === "string" ? canonical(src) : null;
    if (href === null || !href.startsWith(canonical(prefix) ?? prefix)) {
      throw new ApiError(422, "image_outside_r2_domain", {
        allowedPrefix: prefix,
        message: "画像 URL がこのサイトにアップロードした画像の URL ではありません",
        hint: "IMAGE はこのサイトにアップロードした画像の URL だけを指定できます。サイト内の既存画像は ATTRIBUTE(src)で差し替えてください",
      });
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
  return parsed.data;
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
 * 古い書式(URL パターンの ID を参照する閲覧の条件)を、zod の形の検査より先に見つけて 422 legacy_targeting にする。
 * validator の hook から呼ぶ(失敗時の data は生の入力)。古い書式でなければ今までどおり validation_failed
 */
export function targetingValidationFailed(data: unknown, err: Parameters<typeof validationFailed>[0], field: string): ApiError {
  const at = typeof data === "object" && data !== null ? findLegacyTargeting((data as Record<string, unknown>)[field]) : null;
  if (at) return new ApiError(422, "legacy_targeting", { path: [field, ...at], message: LEGACY_TARGETING_MESSAGE, hint: LEGACY_TARGETING_HINT });
  return validationFailed(err);
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
    hint: `${max} 日以下にしてください。長い期間を使うには、サイトの設定で保存期間を延ばします`,
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
