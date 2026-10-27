"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, describeError } from "@/lib/client";
import { staticRedeployMessage } from "@/lib/static-deploy";
import { staticStaleText } from "@/lib/static-health";

/**
 * 設置タグの配信ファイルの更新が済んでいないときの警告。管理者以上は作り直しを押せる。
 * removing = サイトの削除が途中で止まっている(配信ファイルは削除の墓標で消えている)。作り直しで配信を戻せる。
 * mismatch = デプロイ専用の Worker の記録が D1 と食い違っている(7o K6・K14。作り直しで直る = K7)。文言の優先は staticStaleText
 */
export function StaticStaleBanner({ siteId, canRetry, removing, mismatch }: { siteId: string; canRetry: boolean; removing: boolean; mismatch: boolean }) {
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
        {staticStaleText({ staticRemoving: removing, staticMismatch: mismatch })}
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
