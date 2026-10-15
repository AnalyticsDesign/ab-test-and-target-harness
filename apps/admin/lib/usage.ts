// apps/admin/lib/usage.ts
import type { UsageReport, UsageResource, UsageSettings, UsageStatus } from "./types";

/** backlog D10: 使用状況の表示の判断(純関数)。判定そのものは control が行い、ここは見せ方だけ */
/** Paid の 1 日分 = 月額 $5 に含まれる量 ÷ 30(control の usage/limits.ts と同じ値) */
const PAID_REFERENCE_DAYS = 30;

export const RESOURCE_LABELS: Record<string, string> = {
  workers_requests: "Workers のリクエスト",
  do_requests: "Durable Objects のリクエスト",
  do_rows_read: "Durable Objects の行の読み取り",
  do_rows_written: "Durable Objects の行の書き込み",
  d1_rows_read: "D1 の行の読み取り",
  d1_rows_written: "D1 の行の書き込み",
  kv_reads: "KV の読み取り",
  kv_writes: "KV の書き込み",
  kv_deletes: "KV の削除",
  kv_lists: "KV の一覧",
  d1_storage: "D1 の保存量(合計)",
  d1_largest_db: "D1 の保存量(本製品の最大のデータベース)",
  do_storage: "Durable Objects の保存量",
  kv_storage: "KV の保存量",
};

export function settingsLine(s: UsageSettings): string {
  const who = s.usageVisibility === "members" ? "すべてのメンバー" : "システム管理者のみ";
  const plan = s.cloudflarePlan === "free" ? "Free" : `Paid(月額 $5 に含まれる量: ${s.showPaidReference ? "表示" : "非表示"})`;
  return `見られる人: ${who} · プラン: ${plan}`;
}

const LABELS: Record<UsageStatus, string> = {
  ok: "余裕あり",
  warning: "注意",
  critical: "危険",
  exhausted: "上限に到達",
  within_reference: "範囲内",
  over_reference: "超過",
  not_judged: "判定していません",
};
export const statusLabel = (s: UsageStatus): string => LABELS[s];
export type UsageTone = "ok" | "warn" | "danger" | "note";
/** 止まる危険(warning 以上)と、止まらない目安の超過(note)を色で分ける。判定しない資源(not_judged)は ok と同じ */
export function statusTone(s: UsageStatus): UsageTone {
  if (s === "warning") return "warn";
  if (s === "critical" || s === "exhausted") return "danger";
  if (s === "over_reference") return "note";
  return "ok";
}

export function formatAmount(n: number, unit: "count" | "bytes"): string {
  if (unit === "count") return n.toLocaleString("en-US");
  const steps: Array<[number, string]> = [[1e9, "GB"], [1e6, "MB"], [1e3, "KB"]];
  for (const [size, label] of steps) if (n >= size) return `${Number((n / size).toFixed(n / size >= 10 ? 0 : 1))} ${label}`;
  return `${n} B`;
}

export function formatPercent(ratio: number): string {
  const p = ratio * 100;
  // 1% 以上は切り捨て(69.999% を「70%」と出して「余裕あり」と並べない)。0.29 * 100 = 28.999… のような浮動小数の誤差で 1 下がらないよう、わずかに足してから切り捨てる
  return `${p < 1 ? Number(p.toFixed(1)) : Math.floor(p + 1e-9)}%`;
}

/** 表示で比べる割合: 上限があればそれ、無ければ目安 */
const shownRatio = (r: UsageResource): number => r.ratio ?? r.reference?.ratio ?? 0;
export const topResources = (report: UsageReport, n: number): UsageResource[] => [...report.resources].sort((a, b) => shownRatio(b) - shownRatio(a)).slice(0, n);

/** Paid の 1 日の目安を画面に出すか(API は常に返す) */
export const showsReference = (report: UsageReport): boolean => report.plan === "paid" && report.settings.showPaidReference;

/**
 * Paid の表の上の説明(Free は null)。月額 $5 に含まれる量の例は、応答の Workers のリクエストの目安(1 日分)から逆算する
 * (画面に単価表を持たないので、control の表と数字がずれない)。例が取れなければ例の文だけ省く
 */
export function paidNote(report: UsageReport): string | null {
  if (report.plan !== "paid") return null;
  const parts = ["Workers Paid には日次の上限が無く、止まりません。月額 $5 に含まれる量を超えた分が、製品ごとに課金されます。"];
  if (showsReference(report)) {
    const daily = report.resources.find((r) => r.id === "workers_requests")?.reference?.value;
    const example = daily ? `(例: Workers のリクエストは月 ${formatAmount(Math.round(daily * PAID_REFERENCE_DAYS), "count")} 件、1 日分は ${formatAmount(Math.round(daily), "count")} 件)` : "";
    parts.push(`含まれる量は製品ごとに決まっていて、日次の行はそれを ${PAID_REFERENCE_DAYS} 日で割った 1 日分と比べています${example}。1 日分を超えても、月の合計が含まれる量に収まれば追加料金はかかりません。`);
  }
  parts.push("止まる危険を判定するのは、本製品の D1 のデータベースの容量だけです(Durable Objects の 1 オブジェクトの上限などは判定しません)。");
  return parts.join("");
}

/**
 * 割合の棒グラフ。ratio は 0〜1 に丸めない生の値(描く側で 100% に切り詰める)。
 * ticks = 注意・危険の境目(70% / 90%)の目盛りを出すか(上限のある資源だけ。目安は止まらないので境目が無い)
 */
export type UsageMeter = { ratio: number; tone: UsageTone; ticks: boolean };
export type UsageRow = { id: string; label: string; used: string; cap: string; ratioText: string; meter: UsageMeter | null; status: { text: string; tone: UsageTone } | null; projectedAt: number | null; breakdown: string };

/**
 * 使用量の列の見出し。分母の意味は見出しに一度だけ書き、セルには数字だけを置く。表は 1 日の量と保存量に分ける(usageSections)。
 * 1 日の量: Free = 1 日の上限、Paid で目安を出す設定 = 1 日の目安(月額 $5 に含まれる量 ÷ 30)、Paid で出さない設定 = 分母なし(Paid には日次の上限が無い)。
 * 保存量: Paid で目安を出す設定なら、ほとんどの行の分母は目安なので見出しを目安にし、上限のある行(D1 の 1 データベース)にだけ「(上限)」を付ける
 */
export function amountHeader(report: UsageReport, kind: UsageResource["kind"]): string {
  const ref = showsReference(report);
  if (kind === "daily") return report.plan === "free" ? "使用量 / 1 日の上限" : ref ? "使用量 / 1 日の目安" : "使用量";
  return ref ? "使用量 / 月額 $5 に含まれる量" : "使用量 / 上限";
}

/** 割合の列と、使用量の隣に出す分母: 上限があれば上限、Paid で目安を出す設定なら目安、どちらも無ければ空 */
function ratioCell(r: UsageResource, ref: boolean): { ratioText: string; cap: string } {
  if (r.ratio !== null && r.limit !== null) {
    const limit = formatAmount(r.limit, r.unit);
    return { ratioText: formatPercent(r.ratio), cap: ref ? `${limit}(上限)` : limit };
  }
  if (ref && r.reference) return { ratioText: formatPercent(r.reference.ratio), cap: formatAmount(Math.round(r.reference.value), r.unit) };
  return { ratioText: "", cap: "" };
}

/** 棒グラフ: 割合の列と同じ基準(上限があればそれ、Paid で目安を出す設定なら目安、どちらも無ければ出さない) */
function meterOf(r: UsageResource, ref: boolean): UsageMeter | null {
  if (r.ratio !== null && r.limit !== null) return { ratio: r.ratio, tone: statusTone(r.status), ticks: true };
  if (ref && r.reference) return { ratio: r.reference.ratio, tone: statusTone(r.status), ticks: false };
  return null;
}

/** 表の各行に何を出すか(UsageTable はこれを描くだけ)。Paid で目安を出さない設定でも、上限のある資源(D1 の 1 データベース)の割合と状態は残す */
export function usageRows(report: UsageReport, rows: UsageResource[] = report.resources): UsageRow[] {
  const ref = showsReference(report);
  return rows.map((r) => ({
    id: r.id,
    label: RESOURCE_LABELS[r.id] ?? r.id,
    used: formatAmount(r.used, r.unit),
    ...ratioCell(r, ref),
    meter: meterOf(r, ref),
    // 状態は、上限がある・目安を出す設定・判定しない資源のときだけ出す
    status: r.limit !== null || ref || r.status === "not_judged" ? { text: statusLabel(r.status), tone: statusTone(r.status) } : null,
    projectedAt: r.projectedExhaustAt,
    breakdown: r.breakdown.map((b) => `${b.name} ${formatAmount(b.used, r.unit)}`).join(" · "),
  }));
}

/**
 * 表の分け方(画面メモ #5、2026-10-09): 1 日の量(UTC 0 時に戻る)と保存量(戻らない)を別の表にし、分母の意味を見出しで言い分ける。
 * 空の表は出さない(ホームの要約は上位の数行だけを渡す)。列は中身のあるものだけ出す:
 * 上限に達する見込みは Free の 1 日の量だけ(Paid には日次の上限が無く、保存量は見込みを出さない)、
 * 割合と状態は、どれかの行に値があるときだけ(Paid で目安を出さない設定の 1 日の量は使用量だけになる)
 */
export type UsageSection = { kind: UsageResource["kind"]; title: string; header: string; rows: UsageRow[]; ratio: boolean; status: boolean; projection: boolean };
const SECTION_TITLES: Record<UsageResource["kind"], string> = { daily: "1 日の量", capacity: "保存量" };
export function usageSections(report: UsageReport, rows: UsageResource[] = report.resources): UsageSection[] {
  return (["daily", "capacity"] as const).flatMap((kind) => {
    const sectionRows = usageRows(report, rows.filter((r) => r.kind === kind));
    if (sectionRows.length === 0) return [];
    return [{
      kind,
      title: SECTION_TITLES[kind],
      header: amountHeader(report, kind),
      rows: sectionRows,
      ratio: sectionRows.some((row) => row.ratioText !== ""),
      status: sectionRows.some((row) => row.status !== null),
      projection: kind === "daily" && report.plan === "free",
    }];
  });
}

/**
 * `GET /usage` の失敗を、案内の見出しと説明にする。エラー封筒(`{ error: string }` を持つ object)でない応答
 * (HTML の 503 など。controlFetch の data が null)も例外にせず、既定の文に倒す
 */
export function usageFailure(status: number, data: unknown): { title: string; hint: string } {
  const env =
    typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string"
      ? (data as { error: string; message?: unknown; hint?: unknown })
      : null;
  const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return {
    title: env?.error === "usage_not_configured" ? "使用状況の取得が設定されていません" : "使用状況を取得できませんでした",
    hint: text(env?.hint) ?? text(env?.message) ?? `時間をおいて開き直してください(HTTP ${status})`,
  };
}

/** ホームの要約の出し分け(plan K25)の入力。settings が null = まだ読んでいない・読めない(403) */
export type SummaryInput = { instanceAdmin: boolean; settings: (UsageSettings & { configured: boolean }) | null; usage: { ok: true; report: UsageReport } | { ok: false; status: number; data: unknown } | null };
/** adminLine = 設定の 1 行と「変更」「詳細」のリンクを出すか(システム管理者だけ) */
export type SummaryView =
  | { kind: "hidden" }
  | { kind: "loading"; adminLine: boolean }
  | { kind: "unavailable"; title: string; hint: string; adminLine: boolean }
  | { kind: "ok"; report: UsageReport; adminLine: boolean };

/**
 * ホームの要約に何を出すか。見られない人(403)には節ごと出さない。未設定・取得の失敗はシステム管理者にだけ案内し、
 * ほかの人には節ごと出さない。設定の 1 行とリンクを出すか(adminLine)もここで決める
 */
export function summaryView(i: SummaryInput): SummaryView {
  const adminLine = i.instanceAdmin;
  const adminOnly = (v: SummaryView): SummaryView => (i.instanceAdmin ? v : { kind: "hidden" });
  if (i.settings === null) return adminOnly({ kind: "loading", adminLine });
  if (!i.settings.configured) {
    return adminOnly({ kind: "unavailable", title: "使用状況の取得が設定されていません", hint: "設定 > システム > Cloudflare 使用状況の案内を見てください", adminLine });
  }
  if (i.usage === null) return { kind: "loading", adminLine };
  if (!i.usage.ok) {
    if (i.usage.status === 403) return { kind: "hidden" };
    return adminOnly({ kind: "unavailable", ...usageFailure(i.usage.status, i.usage.data), adminLine });
  }
  return { kind: "ok", report: i.usage.report, adminLine };
}
