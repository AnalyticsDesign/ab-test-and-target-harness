"use client";
import { useId, useState } from "react";
import { analyticsValueErrors } from "@/lib/analytics-values";
import { api, describeError } from "@/lib/client";
import {
  duplicateAnalyticsPatch, duplicateAnalyticsSameAsSource, duplicateBody, duplicateIdEdited, duplicateNotes, duplicateVariantModeIssue, duplicateVariantOptions, initialDuplicateState, withAnalyticsName, withId, withMode, withName, withVariant,
  type DuplicateState,
} from "@/lib/duplicate";
import type { ResultsResponse } from "@/lib/results-view";
import { experimentIdProblem } from "@/lib/slug-id";
import type { Experiment } from "@/lib/types";
import { useNow } from "../LocalTime";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Picker } from "../ui/Picker";
import { ErrorBox } from "../ErrorBox";
import { ExperimentIdField } from "./ExperimentIdField";
import { navigateDocument } from "@/lib/navigate";
import { BusyScope, useBusyAction } from "../ui/BusyScope";

/** 作成の応答が 30 秒で分からなかったとき */
const CREATE_UNKNOWN = "作成できたか分かりません。再読み込みして確かめてください";

type Props = {
  wid: string;
  siteId: string;
  experiment: Experiment;
  open: boolean;
  onClose: () => void;
  initial?: DuplicateState;
  report?: ResultsResponse | null;
};

/**
 * 決定 51(設計書 §4.2、モックの複製の画面): 見出しの「複製」から開く。元は変わらず、下書きを作って新しいエクスペリエンスの概要へ移る。
 * 入力欄を持つので外のクリックでは閉じない(Esc と「戻る」で閉じる)。
 * initial = 最初の状態(結果のタブの「<採用> だけを表示する下書きを作成」は、採用したパターンを選んだ状態で開く。D9 ③ Task 15)。
 * report = テストの結果(あれば初期値・プルダウンの判定と上回る確率・選んだパターンへの注意に使う。D9 ③ Task 16)。
 * 作成(POST と外部計測の名前の PATCH)から移った先の画面が開くまで、ダイアログの中を覆って押し直せなくする(B173 第 2 段。二重の作成を止める)。
 * 範囲(BusyScope)はダイアログを包むが、モーダルの <dialog> は外側の inert から外れるので、見える覆いは ConfirmDialog の busyLabel
 */
export function DuplicateDialog(props: Props) {
  return (
    <BusyScope id="duplicate-dialog">
      <DuplicateDialogBody {...props} />
    </BusyScope>
  );
}

function DuplicateDialogBody({ wid, siteId, experiment, open, onClose, initial, report }: Props) {
  const [s, setS] = useState(() => initial ?? initialDuplicateState(experiment, report));
  // 評価時点の前かは今の時刻で決める(評価時点の後でも前の速報が返ることがあるため)
  const now = useNow();
  const { busy, run } = useBusyAction();
  const [error, setError] = useState<string | null>(null);
  const single = experiment.kind === "single";
  const notes = duplicateNotes(experiment, s, report, now);
  // B77: 変更のあるパターンが無い(オリジナルだけの)テストは「選んだパターンだけを表示」を選べない。理由を選択肢の下に出す
  const variantModeIssue = duplicateVariantModeIssue(experiment);
  // B103: ID は初期値から変えたときだけ検査して送る(変えなければ control が空いている -copy・-copy-2 … を使う)
  const idProblem = duplicateIdEdited(s) ? experimentIdProblem(s.id) : null;
  // 変えていない元の値は検査しない(古い値で複製を止めない。保存済みの値を prev に渡す = 編集画面と同じ規則)
  const nameProblem =
    s.analyticsName === null ? null : (analyticsValueErrors({ overrides: { experimentName: s.analyticsName } }, experiment.analytics ?? null, [])[0]?.message ?? null);
  const sameAnalyticsName = duplicateAnalyticsSameAsSource(experiment, s);
  const nameInput = useId();
  const nameHint = useId();
  const nameError = useId();
  const nameSame = useId();
  return (
    <ConfirmDialog
      open={open}
      title="複製して新しいエクスペリエンスを作ります"
      confirmLabel="下書きを作成"
      cancelLabel="戻る"
      tone="primary"
      dismissOnBackdrop={false}
      busyLabel={busy ? "作成中…" : null}
      confirmDisabled={busy || s.name.trim() === "" || idProblem !== null || nameProblem !== null}
      onCancel={() => {
        if (!busy) onClose();
      }}
      onConfirm={async () => {
        setError(null);
        const outcome = await run({
          label: "作成中…",
          write: async (signal) => {
            const created = await api<Pick<Experiment, "id" | "analytics">>("POST", `/sites/${siteId}/experiments/${experiment.id}/duplicate`, duplicateBody(s), { signal });
            // B103: 外部計測の名前を変えたときだけ 2 回目の要求で直す(複製は元の外部計測を丸ごと写すため)。
            // 失敗しても複製はできている(下書きなので配信されない)ので、移った先で知らせて直してもらう
            let analyticsFailed = false;
            // 土台は複製の応答の外部計測(画面を開いた後に元の extra が直されていても、複製が写した新しい値を保つ。PATCH は丸ごと置き換えのため)
            const patch = duplicateAnalyticsPatch({ ...experiment, analytics: created.analytics }, s);
            if (patch) {
              try {
                await api("PATCH", `/sites/${siteId}/experiments/${created.id}`, patch, { signal });
              } catch {
                analyticsFailed = true;
              }
            }
            return { id: created.id, analyticsFailed };
          },
          // 上部バーの「未公開の編集あり」を描き直すため全画面の遷移(作成の画面と同じ理由)。移った先が開くまで覆いと実行権を保つ。
          // B108: 移った先の見た目が元とほぼ同じで反応が無いように見えるので、作成したことを知らせる印を付ける(移った先で URL から消す)
          after: "navigate",
          navigate: ({ id, analyticsFailed }) => navigateDocument(`/w/${wid}/sites/${siteId}/experiments/${id}${analyticsFailed ? "?duplicated=1&analyticsFailed=1" : "?duplicated=1"}`),
        });
        if (outcome.kind === "failed") setError(describeError(outcome.error));
        else if (outcome.kind === "unknown") setError(CREATE_UNKNOWN);
      }}
    >
      <p className="muted">元のエクスペリエンスは変わりません。新しいエクスペリエンスは下書きで作られ、開始するまでサイトには表示されません。</p>
      {single ? null : (
        <div role="radiogroup" aria-label="複製の方式">
          <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
            <input type="radio" name="dup-mode" checked={s.mode === "same"} onChange={() => setS(withMode(experiment, s, "same"))} />
            <span>
              同じ内容でエクスペリエンスを作成
              <span className="muted" style={{ display: "block" }}>
                {(experiment.variants ?? []).map((v) => v.name).join(" / ")} のすべてのパターンと設定を引き継ぎ、訪問者を振り分けて比べるテストの下書きを作ります。一部だけで試すときは、作成した後にパターンのタブで消します
              </span>
            </span>
          </label>
          <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
            <input type="radio" name="dup-mode" checked={s.mode === "variant"} disabled={variantModeIssue !== null} onChange={() => setS(withMode(experiment, s, "variant"))} />
            <span>
              選んだパターンだけを表示するエクスペリエンスを作成
              <span className="muted" style={{ display: "block" }}>選んだパターンの変更を引き継ぎます。開始すると、条件に合う訪問者全員に表示します。振り分けや比較はしません</span>
              {variantModeIssue ? (
                <span className="field-hint" style={{ display: "block" }}>
                  {variantModeIssue}
                </span>
              ) : null}
            </span>
          </label>
          <div style={{ marginLeft: 24 }}>
            {/* Picker は自分でラベルを描かない(aria-label だけ)ので見出しを前に置く。listbox を持つので label で包まない */}
            <div className="field">
              <span className="field-label">表示するパターン</span>
              <Picker label="表示するパターン" value={s.variantId} options={duplicateVariantOptions(experiment, report)} disabled={s.mode !== "variant" || variantModeIssue !== null} onChange={(v) => setS(withVariant(experiment, s, v))} />
            </div>
            {notes.map((n) => (
              <p key={n} className="banner-warn" style={{ display: "block" }}>
                {n}
              </p>
            ))}
          </div>
        </div>
      )}
      <ExperimentIdField
        value={s.id}
        onChange={(v) => setS(withId(s, v))}
        error={idProblem}
        disabled={busy}
        extraHint="変えなければ、既に使われているときは -copy-2・-copy-3 … の空いているものになります(作った ID は移った先の見出しの下に出ます)"
      />
      <label className="field">
        <span className="field-label">名前(100 字以内)</span>
        <input value={s.name} maxLength={100} onChange={(e) => setS(withName(s, e.target.value))} />
      </label>
      {/* B103: 元に外部計測のエクスペリエンス名の上書きがあるときだけ。複製はそれをそのまま写すので、元と同じ名前で dataLayer に出る */}
      {s.analyticsName !== null ? (
        <div className="field">
          <label className="field-label" htmlFor={nameInput}>
            外部計測のエクスペリエンス名
          </label>
          <input
            id={nameInput}
            value={s.analyticsName}
            maxLength={100}
            disabled={busy}
            aria-invalid={nameProblem ? true : undefined}
            aria-describedby={[nameHint, nameProblem ? nameError : null, sameAnalyticsName ? nameSame : null].filter(Boolean).join(" ")}
            placeholder="空なら新しいエクスペリエンス ID を出力"
            onChange={(e) => setS(withAnalyticsName(s, e.target.value))}
          />
          <span className="field-hint" id={nameHint}>
            dataLayer に出すエクスペリエンス名(元の上書きを写しています)。空にすると新しいエクスペリエンス ID を出力します
          </span>
          {nameProblem ? (
            <span className="field-error" role="alert" id={nameError}>
              {nameProblem}
            </span>
          ) : null}
          {sameAnalyticsName ? (
            <span className="banner-warn" style={{ display: "block" }} data-testid="dup-same-analytics-name" id={nameSame}>
              元と同じ名前で dataLayer に出ます。外部計測で元と見分けたいときは、名前を変えてください
            </span>
          ) : null}
        </div>
      ) : null}
      <ErrorBox message={error} />
    </ConfirmDialog>
  );
}
