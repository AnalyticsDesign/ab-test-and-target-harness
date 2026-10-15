"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, describeError } from "@/lib/client";
import { staticRedeployMessage } from "@/lib/static-deploy";

/**
 * 設置タグの配信ファイルの更新が済んでいないときの警告。管理者以上は作り直しを押せる。
 * removing = サイトの削除が途中で止まっている(配信ファイルは削除の墓標で消えている)。作り直しで配信を戻せる
 */
export function StaticStaleBanner({ siteId, canRetry, removing }: { siteId: string; canRetry: boolean; removing: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function retry() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ staticDeploy: "deployed" | "pending" | "skipped" }>("POST", `/sites/${siteId}/static/redeploy`);
      setMessage(staticRedeployMessage(r.staticDeploy));
      router.refresh();
    } catch (e) {
      setMessage(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="banner-warn banner-full" role="status" data-testid="static-stale">
      <span>
        {removing
          ? "このサイトの削除が途中で止まっています。もう一度削除するか、「配信ファイルを作り直す」で配信を戻してください。"
          : /* 未設定・初回・再試行中のどれでも誤解が無いように書く(この帯からは区別できない) */
            "設置タグの配信ファイルが最新の公開内容になっていません。前に作った配信ファイルがあれば訪問者にはそれが届き、初めての公開でまだ無ければタグは読み込まれません。配信ファイルを更新する仕組みが設定されていれば、自動で再試行します。"}
        {message ? <span style={{ marginLeft: 12 }}>{message}</span> : null}
      </span>
      {canRetry ? (
        <button type="button" className="btn" onClick={retry} disabled={busy}>
          {busy ? "作り直し中…" : "配信ファイルを作り直す"}
        </button>
      ) : null}
    </div>
  );
}
