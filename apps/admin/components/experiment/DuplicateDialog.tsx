"use client";
import { useState } from "react";
import { api, describeError } from "@/lib/client";
import { duplicateBody, duplicateNotes, duplicateVariantOptions, initialDuplicateState, withMode, withName, withVariant } from "@/lib/duplicate";
import type { Experiment } from "@/lib/types";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Picker } from "../ui/Picker";
import { ErrorBox } from "../ErrorBox";

/**
 * 決定 51(設計書 §4.2、モックの複製の画面): 見出しの「複製」から開く。元は変わらず、下書きを作って新しいエクスペリエンスの概要へ移る。
 * 入力欄を持つので外のクリックでは閉じない(Esc と「戻る」で閉じる)
 */
export function DuplicateDialog({ wid, siteId, experiment, open, onClose }: { wid: string; siteId: string; experiment: Experiment; open: boolean; onClose: () => void }) {
  const [s, setS] = useState(() => initialDuplicateState(experiment));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const single = experiment.kind === "single";
  const notes = duplicateNotes(experiment, s);
  return (
    <ConfirmDialog
      open={open}
      title="複製して新しいエクスペリエンスを作ります"
      confirmLabel={busy ? "作成中…" : "下書きを作成"}
      cancelLabel="戻る"
      tone="primary"
      dismissOnBackdrop={false}
      confirmDisabled={busy || s.name.trim() === ""}
      onCancel={() => {
        if (!busy) onClose();
      }}
      onConfirm={async () => {
        setBusy(true);
        setError(null);
        try {
          const created = await api<{ id: string }>("POST", `/sites/${siteId}/experiments/${experiment.id}/duplicate`, duplicateBody(s));
          // 上部バーの「未公開の編集あり」を描き直すため全画面の遷移(作成の画面と同じ理由)
          window.location.assign(`/w/${wid}/sites/${siteId}/experiments/${created.id}`);
        } catch (e) {
          setError(describeError(e));
          setBusy(false);
        }
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
            <input type="radio" name="dup-mode" checked={s.mode === "variant"} onChange={() => setS(withMode(experiment, s, "variant"))} />
            <span>
              選んだパターンだけを表示するエクスペリエンスを作成
              <span className="muted" style={{ display: "block" }}>選んだパターンの変更を引き継ぎます。開始すると、条件に合う訪問者全員に表示します。振り分けや比較はしません</span>
            </span>
          </label>
          <div style={{ marginLeft: 24 }}>
            {/* Picker は自分でラベルを描かない(aria-label だけ)ので見出しを前に置く。listbox を持つので label で包まない */}
            <div className="field">
              <span className="field-label">表示するパターン</span>
              <Picker label="表示するパターン" value={s.variantId} options={duplicateVariantOptions(experiment)} disabled={s.mode !== "variant"} onChange={(v) => setS(withVariant(experiment, s, v))} />
            </div>
            {notes.map((n) => (
              <p key={n} className="banner-warn" style={{ display: "block" }}>
                {n}
              </p>
            ))}
          </div>
        </div>
      )}
      <label className="field">
        <span className="field-label">名前(100 字以内)</span>
        <input value={s.name} maxLength={100} onChange={(e) => setS(withName(s, e.target.value))} />
      </label>
      <ErrorBox message={error} />
    </ConfirmDialog>
  );
}
