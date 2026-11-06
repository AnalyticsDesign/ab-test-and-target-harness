import type { AuditAction, AuditVia } from "@wtt/core";
import { STATUS_JA } from "./experiment-filter";
import { KIND_JA } from "./experiment-kind";
import { roleLabel } from "./roles";

/**
 * B129(spec §7.1・§7.3): 操作の記録の 1 行の日本語(操作・ログイン方法・操作した人・内容)。
 * エクスペリエンスの「変更履歴」のタブと、設定の「操作の記録」(ワークスペース・導入全体)が同じ部品を使う。
 * 行の形は control の `GET /sites/:sid/experiments/:eid/history` などの応答(apps/control/src/audit-read.ts の toAuditEventJson)。
 * detail の形は control が書く所(routes/*.ts の auditStatement)と実装の記録の Ruling(R20・R30・R31・R33・R35〜R38・R64)に合わせる。
 * 更新の記録(site.update・experiment.update・goal.update・audience.update・usage.settings_change)は、値が変わった欄だけを持つ(R64)。
 * この形の前に書かれた記録(送った欄をすべて持ち、変わらない欄は from = to)も読めるように、from = to の欄は出さない
 *
 * - 新しい control と古い管理画面の組み合わせでは、知らない action が届く。表に無い action は「操作(<action>)」、内容は空にする
 * - detail は control の版によって形が変わりうるので、型を確かめてから読む(違えば、その部分を出さない。例外を投げない)
 * - 画面には「操作の記録」「変更履歴」と出し、英語の名前の言い方は使わない(test/audit-labels.test.ts が見る)
 */

/** 応答の 1 行(spec §6.4)。action・via は control の版が新しければ知らない値もありうるので string で受ける */
export type AuditEventView = {
  id: string;
  at: number;
  category: string;
  action: string;
  workspaceId: string | null;
  siteId: string | null;
  experimentId: string | null;
  via: string;
  actor: { userId: string; email: string | null; name: string | null } | null;
  apiKey: { id: string; name: string | null } | null;
  target: { type: string; id: string | null; label: string | null } | null;
  detail: Record<string, unknown>;
  /** 導入全体の記録だけ */
  workspaceName?: string | null;
};
/** 作った人・最後に変えた人(変更履歴の応答。消えた人は name も email も null) */
export type AuditPerson = { userId: string; name: string | null; email: string | null };
/** `GET /sites/:sid/experiments/:eid/history` の応答 */
export type ExperimentHistoryResponse = { events: AuditEventView[]; nextCursor: string | null; createdBy: AuditPerson; updatedBy: AuditPerson };

/** 操作の日本語(spec §7.3)。`packages/core/src/audit-actions.ts` の AUDIT_ACTIONS をすべて持つ(型が漏れを落とす) */
export const AUDIT_ACTION_JA: Readonly<Record<AuditAction, string>> = {
  "invitation.create": "招待を発行",
  "invitation.cancel": "招待を取り消し",
  "invitation.accept": "招待を受けて参加",
  "member.role_change": "ロールを変更",
  "member.remove": "メンバーから外す",
  // 操作の前に書く行(成功の行は付かず、失敗したときだけ後に失敗の行が付く)。api_key.create の前の行と同じく「受け付け」で言う
  "member.reset_link": "パスワードの再設定リンクの発行を受け付け",
  "instance_admin.grant": "システム管理者にする",
  "instance_admin.revoke": "システム管理者から外す",
  "api_key.create": "API キーを発行",
  "api_key.revoke": "API キーを失効",
  "api_key.revoke_member": "メンバーの API キーを失効",
  "workspace.create": "ワークスペースを作成",
  "workspace.delete": "ワークスペースを削除",
  "setup.complete": "初期設定を完了",
  "usage.settings_change": "使用状況の設定を変更",
  // 始める前に書く行(成功・失敗の行は付かない)。再設定リンクと同じく「受け付け」で言う
  "static.rebuild": "すべてのサイトの配信ファイルの作り直しを受け付け",
  "break_glass.reset_link": "非常口からの再設定リンクの発行を受け付け",
  "auth.password_login": "パスワードでログイン",
  "break_glass.sweep": "パスワードのログインを閉じた後の掃除",
  "site.create": "サイトを作成",
  "site.update": "サイト設定を保存",
  "site.delete": "サイトを削除",
  "experiment.create": "エクスペリエンスを作成",
  "experiment.update": "基本設定を保存",
  "experiment.memo": "メモを保存",
  "experiment.variants": "パターンを保存",
  "experiment.variant_memo": "パターンのメモを保存",
  "experiment.changes": "パターンの変更を保存",
  "experiment.status": "状態を変更",
  "experiment.adoption": "採用を記録",
  "experiment.duplicate": "複製して作成",
  "experiment.delete": "エクスペリエンスを削除",
  "experiment.evaluation_plan": "評価計画を保存",
  "goal.create": "目標を作成",
  "goal.update": "目標を変更",
  "goal.delete": "目標を削除",
  "audience.create": "オーディエンスを作成",
  "audience.update": "オーディエンスを変更",
  "audience.delete": "オーディエンスを削除",
  "asset.upload": "画像をアップロード",
  "asset.rename": "画像の名前を変更",
  "asset.delete": "画像を削除待ちにする",
  "publish.publish": "公開",
  "publish.static_redeploy": "配信ファイルを作り直し",
};

/** 操作の前に書く記録(Q11)の、失敗の行の言い方(「…を試みたが失敗」)に使う名詞の形 */
const FAILED_NOUN: Partial<Record<AuditAction, string>> = {
  "api_key.create": "API キーの発行",
  "member.reset_link": "パスワードの再設定リンクの発行",
  "break_glass.reset_link": "非常口からの再設定リンクの発行",
};

/** ログイン方法の日本語(`AUDIT_VIAS` をすべて持つ) */
export const AUDIT_VIA_JA: Readonly<Record<AuditVia, string>> = {
  google: "Google",
  password: "パスワード",
  unknown: "不明",
  api_key: "API キー",
  break_glass: "非常口",
  setup: "初期設定",
  system: "定期処理",
};

const isAction = (a: string): a is AuditAction => Object.hasOwn(AUDIT_ACTION_JA, a);
const isVia = (v: string): v is AuditVia => Object.hasOwn(AUDIT_VIA_JA, v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 操作の欄(spec §7.3)。戻し・作成の取り消し・失敗は、通常の操作と同じ表示にしない */
export function auditActionLabel(e: Pick<AuditEventView, "action" | "detail">): string {
  const { action, detail } = e;
  if (!isAction(action)) return `操作(${action})`;
  if (detail.outcome === "failed") return `${FAILED_NOUN[action] ?? `「${AUDIT_ACTION_JA[action]}」`}を試みたが失敗`;
  if (action === "api_key.create") return detail.outcome === "succeeded" ? AUDIT_ACTION_JA[action] : "API キーの発行を受け付け";
  if (action === "publish.publish" && detail.reason === "reverted") return "公開を戻した";
  if (action === "site.update" && detail.reason === "reverted") return "保存を戻した";
  if (action === "site.delete" && detail.reason === "create_failed") return "作成の取り消し";
  const variant = str(detail.variant);
  if (variant && action === "experiment.changes") return `パターン「${variant}」の変更を保存`;
  if (variant && action === "experiment.variant_memo") return `パターン「${variant}」のメモを保存`;
  return AUDIT_ACTION_JA[action];
}

/** ログイン方法の欄。パスワード・非常口は黄の印(warn)で出す。API キーは鍵の名前を添える */
export function auditViaLabel(e: Pick<AuditEventView, "via" | "apiKey">): { text: string; warn: boolean } {
  if (!isVia(e.via)) return { text: AUDIT_VIA_JA.unknown, warn: false };
  if (e.via === "api_key") return { text: e.apiKey?.name ? `API キー「${e.apiKey.name}」` : AUDIT_VIA_JA.api_key, warn: false };
  return { text: AUDIT_VIA_JA[e.via], warn: e.via === "password" || e.via === "break_glass" };
}

/**
 * 操作した人の欄。メールアドレスは応答にあるときだけ(control が、管理者未満の見え方・消えた人では null にする)。
 * 操作した人の無い行(非常用トークン・定期処理・初期設定のトークン)は経路の言い方で出す
 */
export function auditActorLabel(e: Pick<AuditEventView, "actor" | "via">): { name: string; email: string | null } {
  if (e.actor) return { name: e.actor.name ?? "(名前なし)", email: e.actor.email };
  if (e.via === "break_glass") return { name: "非常用トークン", email: null };
  if (e.via === "system") return { name: "定期処理", email: null };
  if (e.via === "setup") return { name: "初期設定", email: null };
  return { name: "(不明)", email: null };
}

/** 対象の種類の日本語(人と招待はメールアドレス・名前をそのまま出すので持たない。導入全体の操作は対象を出さない) */
const TARGET_KIND_JA: Readonly<Record<string, string>> = {
  site: "サイト",
  experiment: "エクスペリエンス",
  variant: "パターン",
  workspace: "ワークスペース",
  api_key: "API キー",
  goal: "目標",
  audience: "オーディエンス",
  asset: "画像",
};

/**
 * 設定の「操作の記録」の「操作と対象」の対象の 1 行(spec §7.2)。人(user)と招待(invitation)はメールアドレス(管理者未満には control が
 * @ より前だけを返す)をそのまま、ほかは「サイト「名前」」の形。名前が無ければ ID。導入全体(instance)と対象の無い行は空。
 * 招待の受諾(invitation.accept)の対象は招待で、入った人は操作した人の欄に出る(受諾はメールの一致を要するので同じ人)
 */
export function auditTargetLabel(e: Pick<AuditEventView, "target">): string {
  const t = e.target;
  if (!t || t.type === "instance") return "";
  const name = t.label ?? t.id;
  const kind = Object.hasOwn(TARGET_KIND_JA, t.type) ? TARGET_KIND_JA[t.type] : undefined;
  if (!kind) return name ?? "";
  return name ? `${kind}「${name}」` : kind;
}

// ---- 内容の欄 ----

type Fmt = (v: unknown) => string | null;
const plain: Fmt = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null);
const quoted: Fmt = (v) => (typeof v === "string" ? `「${v}」` : null);
const onOff: Fmt = (v) => (typeof v === "boolean" ? (v ? "オン" : "オフ") : null);
const suffix = (unit: string): Fmt => (v) => (num(v) === null ? null : `${num(v)}${unit}`);
const choice = (labels: Record<string, string>): Fmt => (v) => (typeof v === "string" ? (labels[v] ?? v) : null);

/**
 * 欄の名前に続ける前後の値(`{from, to}`)。読めなければ null。名前(「旧」→「新」)は括弧で区切れるので空白を挟まない。
 * 記録は変わった欄だけに前後を持つ(R64)ので、from = to はここに来ない(古い形の記録の from = to は unchangedEntry で先に外す)
 */
function fromTo(v: unknown, fmt: Fmt): string | null {
  const o = obj(v);
  if (!o) return null;
  const from = fmt(o.from);
  const to = fmt(o.to);
  if (from === null || to === null) return null;
  const [sep, arrow] = fmt === quoted ? ["", "→"] : [" ", " → "];
  return `${sep}${from}${arrow}${to}`;
}

/**
 * 古い形の記録(R64 の前。送った欄をすべて持ち、同じ値の送り直しは from = to)の、値が変わっていない欄。
 * 今の記録は変わった欄だけを持つので、同じ見え方にするため一覧から外す
 */
const unchangedEntry = (v: unknown): boolean => {
  const o = obj(v);
  return o !== null && Object.hasOwn(o, "from") && Object.hasOwn(o, "to") && same(o.from, o.to);
};

/**
 * 欄の名前と、前後を出す欄の書式。前後を出すのは、記録が前後を持つ短い値の欄だけ(spec §3.2)。
 * 選択肢の値が英語の識別子の欄(導入の形など)は前後を出さず、名前だけにする(画面に英語の値を出さない)
 */
type FieldSpec = { label: string; fmt?: Fmt };
const EXPERIMENT_FIELDS: Record<string, FieldSpec> = {
  name: { label: "名前", fmt: quoted },
  urlMatch: { label: "対象 URL" },
  targeting: { label: "配信条件" },
  trafficPercentage: { label: "配信率", fmt: suffix("%") },
  persistAssignment: { label: "割当の固定", fmt: onOff },
  analytics: { label: "外部計測" },
  description: { label: "メモ" },
};
const PLAN_FIELDS: Record<string, FieldSpec> = {
  primaryGoalId: { label: "判定に使う目標" },
  baselineVariantId: { label: "基準" },
  minDays: { label: "最低期間" },
  maxWeeks: { label: "最大期間" },
  targetPerVariant: { label: "目標参加者数" },
  delta: { label: "最小改善幅" },
  rope: { label: "同等とみなす幅" },
  threshold: { label: "確率のしきい値" },
};
const SITE_FIELDS: Record<string, FieldSpec> = {
  name: { label: "名前", fmt: quoted },
  domains: { label: "タグを置くドメイン" },
  mode: { label: "導入の形" },
  idSource: { label: "訪問者 ID の取得元" },
  retentionDays: { label: "訪問者プロフィールの保持日数", fmt: suffix(" 日") },
  forgetOnRevoke: { label: "撤回時に訪問者プロフィールを削除", fmt: onOff },
  timezone: { label: "タイムゾーン", fmt: plain },
  resultsEnabled: { label: "結果を記録する", fmt: onOff },
  resultsRetentionDays: { label: "参加者ごとの記録を残す日数", fmt: suffix(" 日") },
  newProfileBudgetPerDay: { label: "新しい訪問者の 1 日の上限", fmt: plain },
  consentMode: { label: "同意の扱い" },
  decisionTimeoutMs: { label: "判定の待ち時間", fmt: suffix(" ms") },
  visitorCookieName: { label: "正本 Cookie 名", fmt: plain },
  uuidCookieEnabled: { label: "UUID Cookie", fmt: onOff },
  uuidCookieName: { label: "UUID Cookie 名", fmt: plain },
  shareSubdomains: { label: "サブドメインをまたいだ共有", fmt: onOff },
  analytics: { label: "外部計測" },
  ga4PropertyId: { label: "GA4 のプロパティ ID", fmt: plain },
  bigqueryDataset: { label: "BigQuery のデータセット" },
};
const GOAL_FIELDS: Record<string, FieldSpec> = { name: { label: "名前" }, config: { label: "達成の条件" }, analytics: { label: "外部計測" } };
const AUDIENCE_FIELDS: Record<string, FieldSpec> = { name: { label: "名前" }, description: { label: "メモ" }, definition: { label: "条件" } };
const USAGE_FIELDS: Record<string, FieldSpec> = {
  usageVisibility: { label: "使用状況を見られる人", fmt: choice({ members: "すべてのメンバー", instance_admins: "システム管理者のみ" }) },
  cloudflarePlan: { label: "Cloudflare のプラン", fmt: choice({ free: "Free", paid: "Paid" }) },
  showPaidReference: { label: "月額 $5 に含まれる量と比べる", fmt: onOff },
};

const NO_FIELD_CHANGE = "項目の変更なしの保存";

/**
 * 欄の一覧(値が変わった欄の名前。R30・R31・R35・R38・R64)。前後を持つ欄は前後を添える。
 * 空(変わった欄が無い保存)なら「項目の変更なしの保存」。古い形の記録の from = to の欄は外す(すべて外れたら同じく「項目の変更なしの保存」)
 */
function fieldsLine(detail: Record<string, unknown>, names: unknown, specs: Record<string, FieldSpec>): string {
  const list = arr(names);
  if (!list) return "";
  const changed = list.filter((k): k is string => typeof k === "string" && !unchangedEntry(detail[k]));
  if (changed.length === 0) return NO_FIELD_CHANGE;
  return changed.map((k) => fieldLabel(k, detail[k], specs)).join("、");
}

/** 1 つの欄の名前(前後を持つ欄は前後を添える。知らない欄は識別子を括弧で併記する) */
function fieldLabel(k: string, value: unknown, specs: Record<string, FieldSpec>): string {
  const spec = Object.hasOwn(specs, k) ? specs[k] : undefined;
  if (!spec) return `項目(${k})`;
  const values = spec.fmt ? fromTo(value, spec.fmt) : null;
  return values === null ? spec.label : `${spec.label}${values}`;
}

/** 名前の一覧(パターンの集合)を「2 件(A・B)」にする */
const namesOf = (v: unknown): string | null => {
  const list = arr(v);
  return list ? `${list.length} 件(${list.map((x) => (typeof x === "string" ? x : "?")).join("・")})` : null;
};
const numbersOf = (v: unknown): string | null => {
  const list = arr(v);
  return list && list.every((x) => num(x) !== null) ? list.join("・") : null;
};
/** 前後の 2 つの値(パターンの集合・重み・変更の件数)。この 2 つの記録は今も同じ値の保存で from = to を持つ(R64 の外)ので、同じなら「変わらず」 */
function pair(from: unknown, to: unknown, fmt: (v: unknown) => string | null): string | null {
  const a = fmt(from);
  const b = fmt(to);
  if (a === null || b === null) return null;
  return same(from, to) ? `${b}(変わらず)` : `${a} → ${b}`;
}
const bytesLabel = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const revokedKeys = (n: unknown) => (num(n) ? `API キー ${num(n)} 件を失効` : null);
const joinParts = (parts: Array<string | null>) => parts.filter((p): p is string => p !== null && p !== "").join("・");

/**
 * 内容の欄(前 → 後)。ctx.variantNames = パターンの ID → 名前(変更履歴のタブが知っている今のパターン。採用の記録は ID だけを持つ)。
 * 出すことが無い操作は空の文字列
 */
export function auditDetailLine(e: Pick<AuditEventView, "action" | "detail">, ctx: { variantNames?: Readonly<Record<string, string>> } = {}): string {
  const d = e.detail;
  if (d.truncated === true) return "(内容が長いため省略)";
  switch (e.action) {
    // ---- エクスペリエンス ----
    case "experiment.create":
      return typeof d.kind === "string" && Object.hasOwn(KIND_JA, d.kind) ? KIND_JA[d.kind as keyof typeof KIND_JA] : "";
    case "experiment.update":
      return fieldsLine(d, d.fields, EXPERIMENT_FIELDS);
    case "experiment.variants": {
      const w = obj(d.weights);
      const names = pair(d.from, d.to, namesOf);
      const weights = w ? pair(w.from, w.to, numbersOf) : null;
      return [names ? `パターン ${names}` : null, weights ? `重み ${weights}` : null].filter(Boolean).join("、");
    }
    case "experiment.changes": {
      const counts = pair(d.from, d.to, (v) => (num(v) === null ? null : `${num(v)} 件`));
      const types = obj(d.types);
      const typeLine = types
        ? Object.entries(types)
            .filter(([, n]) => num(n) !== null)
            .map(([t, n]) => `${t} ${n as number}`)
            .join("・")
        : "";
      return counts ? `変更 ${counts}${typeLine ? `(${typeLine})` : ""}` : "";
    }
    case "experiment.status": {
      const label = (v: unknown) => (typeof v === "string" ? (Object.hasOwn(STATUS_JA, v) ? STATUS_JA[v as keyof typeof STATUS_JA] : v) : null);
      const from = label(d.from);
      const to = label(d.to);
      return from && to ? `${from} → ${to}` : "";
    }
    case "experiment.adoption": {
      if (d.variant === null) return "採用なし";
      const id = str(d.variant);
      if (!id) return "";
      const name = ctx.variantNames && Object.hasOwn(ctx.variantNames, id) ? ctx.variantNames[id] : undefined;
      // 設定の「操作の記録」はパターンの名前を読まない(要求を増やさない)ので、名前が分からなければ ID と分かる言い方にする
      return name !== undefined ? `採用 ${name}` : `採用 パターン(ID: ${id})`;
    }
    case "experiment.duplicate":
      // 複製元は ID だけを持つ(元が消えていることもある)
      return str(d.source) ? `複製元 エクスペリエンス(ID: ${str(d.source)})` : "";
    case "experiment.evaluation_plan":
      return fieldsLine(d, d.fields, PLAN_FIELDS);
    // ---- サイト・目標・オーディエンス・画像・公開 ----
    case "site.create":
    case "site.delete":
      return d.reason === "create_failed" ? "" : (str(d.domain) ?? "");
    case "site.update":
      return d.reason === "reverted" ? "" : fieldsLine(d, d.fields, SITE_FIELDS);
    case "goal.update":
      return fieldsLine(d, d.fields, GOAL_FIELDS);
    case "audience.update":
      return fieldsLine(d, d.fields, AUDIENCE_FIELDS);
    case "asset.upload":
      return joinParts([str(d.type), num(d.bytes) === null ? null : bytesLabel(num(d.bytes)!)]);
    case "asset.rename":
      return str(d.from) && str(d.to) ? `「${str(d.from)}」→「${str(d.to)}」` : "";
    case "publish.publish": {
      const v = num(d.version);
      if (v === null) return "";
      return d.superseded === true ? `版 ${v}(後の公開に追い越されたため、配信中にしていません)` : `版 ${v}`;
    }
    // ---- 人とアクセス権・導入の設定 ----
    case "invitation.create":
      return str(d.role) ? `${roleLabel(str(d.role)!)}${d.extended === true ? "(既存のリンクの期限を延長)" : ""}` : "";
    case "invitation.cancel":
      return str(d.role) ? roleLabel(str(d.role)!) : "";
    case "invitation.accept":
      return str(d.role) ? `${roleLabel(str(d.role)!)}${d.signUp === true ? "(アカウントを作成)" : ""}` : "";
    case "member.role_change": {
      const from = str(d.from);
      const to = str(d.to);
      return from && to ? `${roleLabel(from)} → ${roleLabel(to)}` : "";
    }
    case "member.remove":
      return joinParts([str(d.role) ? roleLabel(str(d.role)!) : null, revokedKeys(d.revokedKeys)]);
    case "instance_admin.revoke":
      return joinParts([d.restore === false ? "すべてのワークスペースから外す" : d.restore === true ? "元のロールに戻す" : null, revokedKeys(d.revokedKeys)]);
    case "api_key.create":
      return joinParts([d.scope === "full" ? "すべてのワークスペース" : d.scope === "workspace" ? "1 つのワークスペース" : null, str(d.roleCap) ? `${roleLabel(str(d.roleCap)!)}まで` : null]);
    case "api_key.revoke_member":
      return str(d.owner) ? `持ち主 ${str(d.owner)}` : "";
    case "workspace.delete":
      return num(d.sites) === null ? "" : `サイト ${num(d.sites)} 件`;
    case "usage.settings_change": {
      // 鍵 = 値が変わった項目(R64)。変わった項目が無い保存は {}。古い形の記録の from = to の項目は外す
      const keys = Object.keys(d).filter((k) => k !== "outcome" && !unchangedEntry(d[k]));
      if (keys.length === 0) return NO_FIELD_CHANGE;
      return keys.map((k) => fieldLabel(k, d[k], USAGE_FIELDS)).join("、");
    }
    case "static.rebuild":
      return str(d.after) ? `サイト(ID: ${str(d.after)})の次から` : "";
    case "break_glass.sweep":
      return num(d.passwords) === null || num(d.sessions) === null ? "" : `パスワード ${num(d.passwords)} 件・ログイン状態 ${num(d.sessions)} 件を削除`;
    default:
      return "";
  }
}
