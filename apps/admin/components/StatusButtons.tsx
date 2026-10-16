"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/ConfirmProvider";
import { api, describeError } from "@/lib/client";
import { STATUS_JA } from "@/lib/experiment-filter";
import { loadStartOverlaps, startConfirmFor } from "@/lib/start-confirm";
import type { Experiment, PublishPreview, PublishResult, Status } from "@/lib/types";

const NEXT: Record<Status, Array<{ to: Status; label: string; danger?: boolean }>> = {
  draft: [{ to: "running", label: "開始(公開して配信を始める)" }],
  running: [
    { to: "paused", label: "一時停止" },
    { to: "archived", label: "終了(元に戻せません)", danger: true },
  ],
  paused: [
    { to: "running", label: "再開" },
    { to: "archived", label: "終了(元に戻せません)", danger: true },
  ],
  archived: [],
};

/** spec §13.8。失敗時のアラート = 決定 17 */
export function StatusButtons({ siteId, experiment, canPublish }: { siteId: string; experiment: Experiment; canPublish: boolean }) {
  const router = useRouter();
  const ask = useConfirm();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!canPublish) return <p className="muted">開始・一時停止・終了(本番化)は管理者以上が行います</p>;
  return (
    <div className="row" style={{ justifyContent: "flex-end", maxWidth: 560 }}>
      {NEXT[experiment.status].map((n) => (
        <button
          key={n.to}
          type="button"
          className={n.danger ? "btn btn-danger" : "btn btn-primary"}
          disabled={busy}
          onClick={async () => {
            // 最初に busy を立てる(確認や重なりの取得を待つ間も押せないように。2 回目の状態変更が 409 になり、成功の知らせをエラーで上書きしないため)。
            // 途中で戻るとき(確認のキャンセル)も finally で戻す
            setBusy(true);
            try {
              if (
                n.danger &&
                !(await ask({ title: "エクスペリエンスを終了しますか?", body: "終了したエクスペリエンスは再開できません。もう一度行うときは複製して作ります", confirmLabel: "終了する" }))
              )
                return;
              // 決定 51(設計書 §3.3): 下書きの開始・一時停止中の再開で、同じ要素を変える配信中のエクスペリエンスがあれば、どちらが優先されるかを確認に出す。
              // 取得に失敗したら確認なしで進める(警告は開始・再開を止めない)
              if ((experiment.status === "draft" || experiment.status === "paused") && n.to === "running") {
                const confirm = startConfirmFor(
                  await loadStartOverlaps(() => api<PublishPreview>("GET", `/sites/${siteId}/publish-preview?starting=${encodeURIComponent(experiment.id)}`)),
                  experiment.status === "paused" ? "再開" : "開始",
                );
                if (
                  confirm &&
                  !(await ask({
                    title: confirm.title,
                    body: (
                      <>
                        <p>{confirm.lead}</p>
                        <ul>
                          {confirm.items.map((it) => (
                            <li key={it.key}>{it.message}</li>
                          ))}
                        </ul>
                      </>
                    ),
                    confirmLabel: confirm.confirmLabel,
                    tone: "primary",
                  }))
                )
                  return;
              }
              setMsg(null);
              try {
                const r = await api<{ publish: PublishResult }>("POST", `/sites/${siteId}/experiments/${experiment.id}/status`, { status: n.to });
                setMsg(
                  r.publish.ok
                    ? `公開 v${r.publish.version} を反映しました(訪問者のブラウザには 1 分ほどで届きます)`
                    : `状態は ${STATUS_JA[n.to]} に変わりましたが、公開に失敗しました(${r.publish.error}: ${r.publish.message})。上部の「公開」から再試行してください`,
                );
                router.refresh();
              } catch (e) {
                setMsg(describeError(e));
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          {n.label}
        </button>
      ))}
      {msg ? (
        <span className={msg.includes("失敗") ? "error-box" : "muted"} role="alert">
          {msg}
        </span>
      ) : null}
    </div>
  );
}
