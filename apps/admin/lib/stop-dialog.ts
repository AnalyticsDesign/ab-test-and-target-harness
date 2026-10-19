import { duplicateName } from "@wtt/core";
import { defaultBaseline } from "@wtt/stats";
import { monthDay, probPct, sgn, STATE_LABEL } from "./result-format";
import type { ResultsResponse } from "./results-view";
import type { Experiment, StatusResult } from "./types";

/**
 * D9 ③ Task 16: 終了のモーダル(設計書 §8.2)と、終了した後の採用の記録(PUT …/adoption)の画面の状態・送る手順・知らせ。
 * 一覧の採用の要約(§8.1)もここに置く。判定の要約(verdictHint)は複製の画面のプルダウンと共通
 */

// ---------------------------------------------------------------------------
// 結果の応答から読むこと(終了のモーダルと複製の画面で共通)
// ---------------------------------------------------------------------------

/**
 * 基準のパターン(評価計画の値。結果が無ければ評価計画の既定 = 重みが 0 より大きいパターンのうち、オリジナルの先頭、無ければ先頭。
 * control の結果の基準の決め方と同じ)
 */
export function baselineOf(report: ResultsResponse | null | undefined, exp: Pick<Experiment, "variants">): string | null {
  const planned = report?.plan?.baselineVariantId;
  if (planned) return planned;
  const variants = (exp.variants ?? []).map((v, position) => ({ id: v.id, position, original: v.original, weight: v.weight }));
  return defaultBaseline(variants.filter((v) => v.weight > 0));
}

/** 配信したパターンか(重み 0・注記 zero_weight のパターンは配信していない = 判定と採用候補の対象外。設計書 §7.3) */
export function isDelivered(report: ResultsResponse, variantId: string): boolean {
  const v = report.variants.find((x) => x.id === variantId);
  if (!v || v.weight <= 0) return false;
  return !report.notes.some((n) => n.key === "zero_weight" && n.params?.variantId === variantId);
}

/** 注記の params.variantId の一覧(同じ鍵の注記から) */
const noteVariants = (report: ResultsResponse | null | undefined, key: string): string[] =>
  (report?.notes ?? []).filter((n) => n.key === key).map((n) => n.params?.variantId).filter((x): x is string => typeof x === "string");

/** 未公開の編集(保存済みの変更と、配信していた定義の食い違い)があるパターン */
export const unpublishedVariants = (report: ResultsResponse | null | undefined): string[] => noteVariants(report, "unpublished_changes");
/** 評価時点の記録に写した定義の後に変更を編集したパターン */
export const editedAfterEvaluationVariants = (report: ResultsResponse | null | undefined): string[] => noteVariants(report, "edited_after_evaluation");

/**
 * パターンに変更があるか。配信していた定義(実行中は今、終了したテストは終了の直前)で判断し、
 * 配信を確かめた定義が無ければ保存済みの変更で判断する(plan ③ K16)
 */
export function deliveredHasChanges(report: ResultsResponse | null | undefined, exp: Pick<Experiment, "variants">, variantId: string): boolean {
  const delivered = report?.deliveredChanges;
  if (delivered && variantId in delivered) return delivered[variantId] === true;
  return ((exp.variants ?? []).find((v) => v.id === variantId)?.changes.length ?? 0) > 0;
}

/**
 * 評価時点の前か。phase では決めない(評価時点の後でも、読み取りの予約を断られて記録がまだ無ければ、前に計算した速報が
 * phase = interim で返るため)。今の時刻(マウント前は null)と評価時点で決め、時刻が無いときだけ phase に頼る
 */
export function beforeEvaluation(report: ResultsResponse | null | undefined, now: number | null): boolean {
  if (!report || report.phase !== "interim") return false;
  const at = report.evaluation?.evaluationAt ?? null;
  if (at === null || now === null) return true;
  return now < at;
}

/**
 * パターンの判定と上回る確率の 1 行(終了のモーダルの選択肢の補足・複製の画面のプルダウン)。
 * 結果が無い・そのパターンの数値が無いときは null。判定は結果の記録(評価時点・終了の記録)のときだけ出す
 */
export function verdictHint(report: ResultsResponse | null | undefined, variantId: string): string | null {
  if (!report) return null;
  const v = report.variants.find((x) => x.id === variantId);
  if (!v) return null;
  if (variantId === report.plan?.baselineVariantId) return "基準";
  if (!isDelivered(report, variantId)) return "配信していません";
  if (!v.diff) return null;
  const delta = report.plan?.delta ?? 0;
  const label = delta > 0 ? `+${delta} ポイントを超えて上回る確率` : "上回る確率";
  const prob = `${label} ${probPct(v.diff.pAboveDelta)}`;
  if (report.phase === "interim") return `速報・いまの${prob}`;
  if (report.quality === "blocked") return `判定不可(データ品質)・${prob}`;
  if (report.phase === "stopped") return `評価時点前に終了・${prob}`;
  return v.state ? `${STATE_LABEL[v.state]}・${prob}` : prob;
}

/**
 * 正の判定(評価時点の記録、または評価時点の前に終了したときの終了の記録)の採用候補のうち、最良である確率の高いもの
 * (無ければ上回る確率の高いもの)。速報・品質の問題・候補なしは null。重み 0 のパターンは候補にしない
 */
export function officialAdoptCandidate(report: ResultsResponse | null | undefined): string | null {
  if (!report || report.phase === "interim" || report.quality === "blocked") return null;
  const baseline = report.plan?.baselineVariantId ?? null;
  const wins = report.variants.filter((v) => v.id !== baseline && v.state === "adopt" && v.diff !== null && isDelivered(report, v.id));
  const rank = (v: (typeof wins)[number]) => v.probBest ?? v.diff?.pAboveDelta ?? 0;
  return [...wins].sort((a, b) => rank(b) - rank(a))[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// 終了のモーダル
// ---------------------------------------------------------------------------

/** stop = 終了して採用を記録する(状態の API)/ adopt = 終了したテストの採用を記録し直す(PUT …/adoption) */
export type StopMode = "stop" | "adopt";
/** 採用のメモの上限(control の AdoptionInputSchema と同じ) */
export const ADOPTION_NOTE_MAX = 1000;
export type StopOption = { variantId: string | null; label: string; note?: string };
export type StopDialogState = {
  /** モーダルの説明(何を記録するか) */
  lead: string;
  options: StopOption[];
  /** 最初に選ぶ採用(null = 採用なし) */
  initial: string | null;
  /** 評価時点の前の終了の知らせ(評価時点の後・結果を記録しないテスト・採用の記録し直しでは null) */
  earlyNotice: string | null;
  /** 評価時点の後に変更を編集したパターン(選んだ採用に当たれば 1 行出す) */
  editedAfterEvaluation: string[];
  /** 未公開の編集があるパターン(選んだ採用に当たれば 1 行出す) */
  unpublished: string[];
};

const NONE_OPTION: StopOption = { variantId: null, label: "採用なし", note: "今のままにする。分かったことはメモに残す" };

/**
 * 終了のモーダルの選択肢と初期値(設計書 §8.2)。
 * - 選択肢: 基準以外のパターンごとに「<名前> を採用」(補足に判定と上回る確率)と「採用なし」。基準は変更があるときだけ
 *   「<名前>(基準)を採用」(終了の直前に配信していた定義で判断する。変更の無い基準は「採用なし」と同じ意味のため出さない)
 * - 初期値: 開いた側が決めた採用(結果のタブの帯の操作)> 採用の記録(採用の記録し直し)> 正の判定の採用候補 > 採用なし
 */
export function stopDialogState(
  report: ResultsResponse | null,
  exp: Experiment,
  /** now = 今の時刻(評価時点の前かを決める。マウント前は null = phase で決める) */
  opts: { timeZone: string; now?: number | null; mode?: StopMode; initialVariantId?: string | null },
): StopDialogState {
  const mode = opts.mode ?? "stop";
  const variants = exp.variants ?? [];
  const baseline = baselineOf(report, exp);
  const options: StopOption[] = [];
  for (const v of variants) {
    if (v.id === baseline) {
      if (deliveredHasChanges(report, exp, v.id)) options.push({ variantId: v.id, label: `${v.name}(基準)を採用`, note: "基準の変更を残す" });
      continue;
    }
    const note = verdictHint(report, v.id);
    options.push({ variantId: v.id, label: `${v.name} を採用`, ...(note ? { note } : {}) });
  }
  options.push(NONE_OPTION);
  const valid = (id: string | null | undefined): id is string | null => id === null || (id !== undefined && options.some((o) => o.variantId === id));
  let initial: string | null;
  if (opts.initialVariantId !== undefined) initial = valid(opts.initialVariantId) ? opts.initialVariantId : null;
  else if (mode === "adopt" && report?.adoption) initial = valid(report.adoption.variantId) ? report.adoption.variantId : null;
  else initial = officialAdoptCandidate(report);

  const recording = exp.runId !== null;
  const evaluationAt = report?.evaluation?.evaluationAt ?? null;
  const before = beforeEvaluation(report, opts.now ?? null);
  const early = mode === "stop" && recording && before && evaluationAt !== null;
  let lead: string;
  if (mode === "adopt") lead = "終了したテストの採用とメモを記録します。前の記録は上書きします。";
  else if (!recording) lead = "このテストは結果を記録していないため、採用とメモだけを記録します。終了したテストは再開できません。";
  else if (report && !before) lead = "結果は評価時点の記録のまま変わりません。終了すると配信を止め、採用とメモを記録します。終了したテストは再開できません。";
  else lead = "終了の時点の数値と判定を固定して保存します。終了したテストは再開できません。";
  return {
    lead,
    options,
    initial,
    earlyNotice: early ? `評価時点(${monthDay(evaluationAt, opts.timeZone)})の前です。この記録には「評価時点前に終了」と付きます。` : null,
    editedAfterEvaluation: editedAfterEvaluationVariants(report),
    unpublished: unpublishedVariants(report),
  };
}

const nameOf = (exp: Pick<Experiment, "variants">, id: string): string => (exp.variants ?? []).find((v) => v.id === id)?.name ?? id;

/** 評価時点の後の編集の 1 行(複製の画面と共通) */
export const editedAfterEvaluationText = (name: string): string => `評価時点の後に ${name} の変更が編集されています`;
/** 未公開の編集の 1 行(複製の画面と共通) */
export const unpublishedText = (name: string): string => `${name} に未公開の編集があります。テストで配信したのは編集の前の中身です。「${name} だけを表示」の複製は配信した中身で作ります`;

/** 選んだ採用への注意(止めない): 評価時点の後の編集・未公開の編集 */
export function selectionNotes(s: Pick<StopDialogState, "editedAfterEvaluation" | "unpublished">, exp: Pick<Experiment, "variants">, selected: string | null): string[] {
  if (selected === null) return [];
  const out: string[] = [];
  if (s.editedAfterEvaluation.includes(selected)) out.push(editedAfterEvaluationText(nameOf(exp, selected)));
  if (s.unpublished.includes(selected)) out.push(unpublishedText(nameOf(exp, selected)));
  return out;
}

/** チェック「<採用> だけを表示する新しいエクスペリエンスも作成する(下書き)」。採用を選んだときだけ選べる(オリジナルは複製できない) */
export function stopDuplicateOption(exp: Pick<Experiment, "variants">, selected: string | null): { enabled: boolean; label: string; hint: string } {
  const v = selected === null ? undefined : (exp.variants ?? []).find((x) => x.id === selected);
  if (!v) return { enabled: false, label: "採用したパターンだけを表示する新しいエクスペリエンスも作成する", hint: "パターンを採用すると選べます。あとから見出しの「複製」でも作れます。" };
  const label = `${v.name} だけを表示する新しいエクスペリエンスも作成する(下書き)`;
  if (v.original) return { enabled: false, label, hint: "オリジナルは元のページのままなので、複製できません。" };
  return { enabled: true, label, hint: "終了と記録が先に確定します。作成に失敗しても終了は取り消さず、見出しの「複製」から作り直せます。" };
}

/** チェックで作る下書きの名前(複製の画面の名前の既定と同じ) */
export const stopDuplicateName = (exp: Pick<Experiment, "name" | "variants">, variantId: string): string => duplicateName("variant", exp.name, nameOf(exp, variantId));

// ---------------------------------------------------------------------------
// 送る手順と知らせ
// ---------------------------------------------------------------------------

export type ApiCall = (method: string, path: string, body?: unknown) => Promise<unknown>;
export type StopInput = {
  siteId: string;
  experimentId: string;
  adoption: { variantId: string | null; note: string };
  /** チェックを入れたとき: 採用したパターンだけを表示する下書き */
  duplicate: { variantId: string; name: string } | null;
};
export type StopOutcome = { result: StatusResult; duplicate: { kind: "none" } | { kind: "created"; id: string } | { kind: "failed"; message: string } };

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 終了 + 採用(状態の API)→ チェックがあれば複製の API(設計書 §8.2)。状態の API の失敗はそのまま投げる(何も複製しない)。
 * 複製の失敗は終了を取り消さずに結果へ入れる(終了と記録が先に確定する)。describe = エラーの文(画面は describeError を渡す)
 */
export async function submitStop(call: ApiCall, input: StopInput, describe: (e: unknown) => string = errorText): Promise<StopOutcome> {
  const base = `/sites/${input.siteId}/experiments/${input.experimentId}`;
  const note = input.adoption.note.trim();
  const result = (await call("POST", `${base}/status`, { status: "archived", adoption: { variantId: input.adoption.variantId, ...(note ? { note } : {}) } })) as StatusResult;
  if (!input.duplicate) return { result, duplicate: { kind: "none" } };
  try {
    const created = (await call("POST", `${base}/duplicate`, { mode: "variant", variantId: input.duplicate.variantId, name: input.duplicate.name })) as { id: string };
    return { result, duplicate: { kind: "created", id: created.id } };
  } catch (e) {
    return { result, duplicate: { kind: "failed", message: describe(e) } };
  }
}

export type StopMessage = { tone: "info" | "warn" | "error"; text: string };

/**
 * 終了の後に出す知らせと、作った下書きへの移り方。下書きへそのまま移るのは、公開も記録も済んだときだけ
 * (公開の失敗・記録の失敗を読まずに離れないように。そのときは下書きへのリンクを出す)。
 * experimentsPath = エクスペリエンスの一覧の画面のパス(/w/:wid/sites/:sid/experiments)
 */
export function stopView(o: StopOutcome, experimentsPath: string): { messages: StopMessage[]; created: string | null; navigate: boolean } {
  const r = o.result;
  const messages: StopMessage[] = [
    r.publish.ok
      ? { tone: "info", text: `終了しました。公開 v${r.publish.version} を反映しました(訪問者のブラウザには 1 分ほどで届きます)` }
      : { tone: "error", text: `状態は 終了 に変わりましたが、公開に失敗しました(${r.publish.error}: ${r.publish.message})。上部の「公開」から再試行してください` },
  ];
  const notRecorded = r.results?.recorded === false;
  if (notRecorded) messages.push({ tone: "warn", text: "結果を記録できませんでした。自動で記録し直します。採用は記録されていないので、結果のタブから記録し直してください" });
  for (const w of r.warnings ?? []) messages.push({ tone: "warn", text: w.message });
  if (o.duplicate.kind === "failed") {
    messages.push({ tone: "error", text: `終了しました。下書きの作成に失敗しました(${o.duplicate.message})。終了は取り消していません。見出しの「複製」から作り直せます` });
  }
  const created = o.duplicate.kind === "created" ? `${experimentsPath}/${o.duplicate.id}` : null;
  return { messages, created, navigate: created !== null && r.publish.ok && !notRecorded && (r.warnings ?? []).length === 0 };
}

// ---------------------------------------------------------------------------
// 一覧の採用の要約
// ---------------------------------------------------------------------------

/**
 * 一覧の「採用」の列(設計書 §8.1)。「採用: B(+0.60 ポイント・+12%、上回る確率 97.1%)」「採用: A(基準)」「採用なし」。
 * 未記録とパーソナライズは空。名前はパターンの名前(分からなければ ID)。基準かは control の baseline で見る
 * (要約の値がすべて null になるのは基準のほかに重み 0 のパターンもあるため、値からは推し量らない)。
 * 正の判定の記録が無ければ summary = null で要約を付けない
 */
export function adoptionListText(e: Pick<Experiment, "kind" | "adoption">): string {
  const a = e.adoption;
  if (e.kind !== "test" || !a) return "";
  if (a.variantId === null) return "採用なし";
  const name = a.variantName ?? a.variantId;
  if (a.baseline) return `採用: ${name}(基準)`;
  const s = a.summary;
  if (!s) return `採用: ${name}`;
  const diff = [s.diffPoints === null ? null : `${sgn(s.diffPoints, 2)} ポイント`, s.relative === null ? null : `${sgn(s.relative, 0)}%`].filter((x) => x !== null).join("・");
  const prob = s.probBeat === null ? null : `上回る確率 ${probPct(s.probBeat)}`;
  const inner = [diff || null, prob].filter((x) => x !== null).join("、");
  return inner ? `採用: ${name}(${inner})` : `採用: ${name}`;
}
