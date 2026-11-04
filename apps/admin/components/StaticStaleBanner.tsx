"use client";
import { useState } from "react";
import { api } from "@/lib/client";
import { REFRESH_TIMEOUT, noticeOf } from "@/lib/busy-notice";
import { staticRedeployMessage } from "@/lib/static-deploy";
import { staticStaleText } from "@/lib/static-health";
import { BusyScope, useBusyAction } from "./ui/BusyScope";

/**
 * 設置タグの配信ファイルの更新が済んでいないときの警告。管理者以上は作り直しを押せる。
 * removing = サイトの削除が途中で止まっている(配信ファイルは削除の墓標で消えている)。作り直しで配信を戻せる。
 * mismatch = デプロイ専用の Worker の記録が D1 と食い違っている(7o K6・K14。作り直しで直る = K7)。文言の優先は staticStaleText
 *
 * B173 第 2 段: 作り直しの間は帯を覆う(BusyScope)。BusyScope は div を 2 段足すので、帯の flex の並びが崩れないよう、
 * 包むのは帯の外側(帯の要素ごと)にし、帯のクラスは中の要素に残す。帯は SiteChromeGuard の中にあり遷移中に消えうるが、
 * 消えた後の読み直しは BusyScope の決まり(消えた範囲の結果は捨てる)に乗る
 */
export function StaticStaleBanner(props: { siteId: string; canRetry: boolean; removing: boolean; mismatch: boolean }) {
  return (
    <BusyScope id="static-stale">
      <StaticStaleBody {...props} />
    </BusyScope>
  );
}

function StaticStaleBody({ siteId, canRetry, removing, mismatch }: { siteId: string; canRetry: boolean; removing: boolean; mismatch: boolean }) {
  const { run, busy } = useBusyAction();
  /** 成功の文(deployed・pending)。帯の文と一緒に role="status" で読む */
  const [message, setMessage] = useState<string | null>(null);
  /** 失敗・30 秒の文。成功の文と分けて role="alert" にする(最終レビュー M1) */
  const [error, setError] = useState<string | null>(null);
  /** 読み直しが上限を超えた(作り直しは受け付けた)ときの再読み込みの案内。結果の文の横に足す */
  const [note, setNote] = useState<string | null>(null);
  async function retry() {
    setMessage(null);
    setError(null);
    setNote(null);
    const outcome = await run({
      label: "作り直し中…",
      write: (signal) => api<{ staticDeploy: "deployed" | "pending" | "skipped" }>("POST", `/sites/${siteId}/static/redeploy`, undefined, { signal }),
      onWritten: (r) => setMessage(staticRedeployMessage(r.staticDeploy)),
      after: "refresh",
    });
    // 成功は今の文(deployed・pending)のまま。読み直しが上限を超えたときは文を保って案内を足す。失敗・30 秒はその文言(discarded などは今のまま)
    if (outcome.kind === "saved") {
      if (outcome.refresh === "timeout") setNote(REFRESH_TIMEOUT);
      return;
    }
    const n = noticeOf(outcome, null);
    if (n?.error) setError(n.error);
  }
  // 読み上げの領域は入れ子にしない: 帯の文・成功の文・案内は role="status" の span、失敗の文はその横の role="alert" の span
  return (
    <div className="banner-warn banner-full" data-testid="static-stale">
      <span>
        <span role="status">
          {staticStaleText({ staticRemoving: removing, staticMismatch: mismatch })}
          {message ? <span style={{ marginLeft: 12 }}>{message}</span> : null}
          {note ? <span style={{ marginLeft: 12 }}>{note}</span> : null}
        </span>
        {error ? (
          <span role="alert" style={{ marginLeft: 12 }}>
            {error}
          </span>
        ) : null}
      </span>
      {canRetry ? (
        <button type="button" className="btn" onClick={retry} disabled={busy}>
          配信ファイルを作り直す
        </button>
      ) : null}
    </div>
  );
}
