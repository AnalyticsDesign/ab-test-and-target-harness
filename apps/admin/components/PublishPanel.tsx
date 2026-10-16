"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, describeError } from "@/lib/client";
import { STATUS_JA, STATUS_TONE } from "@/lib/experiment-filter";
import { describePageMatch } from "@/lib/page-match";
import type { PublishPreview, PublishResult, Site, Status } from "@/lib/types";
import { LocalTime } from "./LocalTime";
import { PageHeader } from "./ui/PageHeader";
import { StatusPill } from "./ui/StatusPill";
import { Icon } from "./ui/Icon";

const pill = (s: Status | null) => (s ? <StatusPill tone={STATUS_TONE[s]}>{STATUS_JA[s]}</StatusPill> : <StatusPill tone="gray">未反映</StatusPill>);

export function PublishPanel({ wid, site, preview, canPublish }: { wid: string; site: Pick<Site, "id" | "name" | "activeVersion">; preview: PublishPreview; canPublish: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nothing = preview.experiments.length === 0 && !preview.siteLevelChanged;
  const hasCode = preview.experiments.some((e) => e.hasCodeChange);
  const base = `/w/${wid}/sites/${site.id}`;
  const next = (site.activeVersion ?? 0) + 1;
  return (
    <div>
      <PageHeader title="公開" meta={<>前回の公開({preview.lastActivatedAt ? <LocalTime at={preview.lastActivatedAt} /> : "未実行"})以降の変更</>} />
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 16, alignItems: "start" }}>
        <div>
          <h2>変更のあるエクスペリエンス</h2>
          {preview.experiments.length === 0 ? <p className="muted">エクスペリエンスの変更はありません</p> : null}
          {preview.experiments.map((e) => (
            <section key={e.id} className="card" data-testid={`publish-exp-${e.id}`}>
              <div className="row" style={{ marginBottom: 8 }}>
                <strong style={{ marginRight: "auto" }}>
                  {e.name} <span className="muted mono">{e.id}</span>
                </strong>
                {e.hasCodeChange ? (
                  <span className="badge badge-warn" title="HTML / CSS / CUSTOM_JS を含みます。訪問者のブラウザで任意のコードが実行されます。内容を確認してから公開してください">
                    コードを含む
                  </span>
                ) : null}
              </div>
              <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                {pill(e.publishedStatus)}
                <Icon name="arrow" size={14} />
                {pill(e.status)}
                <span className="muted">
                  {e.updatedBy.name} · <LocalTime at={e.updatedAt} />
                </span>
              </div>
              {e.changedChanges.map((c) => (
                <div key={`${c.variantId}/${c.id}`} className="muted">
                  <code>
                    {c.variantId}/{c.id}
                  </code>{" "}
                  {c.type} · {c.updatedBy.name} · <LocalTime at={c.updatedAt} />
                </div>
              ))}
            </section>
          ))}
          <h2>サイト全体の変更</h2>
          {preview.siteLevelChanged ? <p><span className="badge badge-warn">サイトの設定・目標・オーディエンスの変更あり</span></p> : <p className="muted">ありません</p>}
          <h2>オーディエンスの変更</h2>
          {preview.audienceChanges.length === 0 ? <p className="muted">ありません</p> : null}
          {preview.audienceChanges.map((a) => (
            <section key={a.id} className="card" data-testid={`publish-aud-${a.id}`}>
              <div className="row" style={{ marginBottom: 8 }}>
                <strong style={{ marginRight: "auto" }}>
                  {a.name} <span className="muted mono">{a.id}</span>
                </strong>
                <span className="muted"><LocalTime at={a.updatedAt} /></span>
              </div>
              {a.experiments.length > 0 ? (
                <div className="row" style={{ gap: 6 }}>
                  <span className="muted">次の公開で配信対象が変わる実行中のエクスペリエンス:</span>
                  {a.experiments.map((e) => (
                    <span key={e.id} className="badge badge-warn">
                      {e.name} · 変更あり
                    </span>
                  ))}
                </div>
              ) : (
                <p className="muted">実行中のエクスペリエンスからは使われていません</p>
              )}
            </section>
          ))}
          {preview.droppedPageConditions.length > 0 ? (
            <div className="banner-warn" style={{ display: "block" }} data-testid="publish-dropped">
              次の公開で数えるのをやめるページの条件: {preview.droppedPageConditions.length} 件(これまでの閲覧回数は消えます)
              <ul style={{ margin: "6px 0 0" }}>
                {preview.droppedPageConditions.map((p) => (
                  <li key={`${p.part}/${p.op}/${p.value}`}>{describePageMatch(p)}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <aside className="card" style={{ position: "sticky", top: 0 }}>
          <h2>配信する内容</h2>
          <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 12px", margin: "0 0 16px" }}>
            <dt className="muted">サイト</dt>
            <dd style={{ margin: 0 }}>{site.name}</dd>
            <dt className="muted">版</dt>
            <dd style={{ margin: 0 }} className="mono">
              {site.activeVersion ? `v${site.activeVersion}` : "未公開"} → v{next}
            </dd>
            <dt className="muted">エクスペリエンス</dt>
            <dd style={{ margin: 0 }}>{preview.experiments.length} 件</dd>
          </dl>
          {preview.compileError ? (
            <p className="error-box" role="alert" data-testid="publish-compile-error">
              いまの下書きは公開で止まります: {preview.compileError.message}
              {preview.compileError.hint ? `(${preview.compileError.hint})` : ""}
            </p>
          ) : null}
          {preview.viewportExperiments.length > 0 ? (
            <p className="banner-warn" style={{ display: "block" }} data-testid="publish-viewport">
              画面の幅の条件を使うエクスペリエンス({preview.viewportExperiments.map((e) => e.name).join("、")})は、タグが viewport の meta より前にあるページや、meta が無いページでは配信されません
            </p>
          ) : null}
          {preview.overlaps.length > 0 ? (
            <div className="banner-warn" style={{ display: "block" }} data-testid="publish-overlaps">
              同じ要素を変えるエクスペリエンスがあります(公開は止めません)
              <ul>
                {preview.overlaps.map((o) => (
                  <li key={o.experimentIds.join("|")}>{o.message}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {hasCode ? (
            <p className="banner-warn" style={{ display: "block" }}>
              HTML / CSS / CUSTOM_JS を含む変更があります。配信前に下書きプレビューで表示を確認してください
            </p>
          ) : null}
          {nothing ? <p className="muted">前回の公開以降の変更はありません(同じ内容で再試行はできます)</p> : null}
          {canPublish ? (
            <div className="row">
              <button
                type="button"
                className={nothing ? "btn" : "btn btn-primary"}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  setResult(null);
                  try {
                    setResult(await api<PublishResult>("POST", `/sites/${site.id}/publish`));
                    router.refresh();
                  } catch (e) {
                    setError(describeError(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "公開中…" : nothing ? "公開する(変更なしでも再試行できます)" : "公開する"}
              </button>
              <Link className="btn" href={base}>
                キャンセル
              </Link>
            </div>
          ) : (
            <p className="muted">公開は管理者以上が行います</p>
          )}
        </aside>
      </div>
      {result ? (
        <p data-testid="publish-result" className={result.ok ? "banner-warn" : "error-box"} role="alert">
          {result.ok
            ? `v${result.version} を配信に載せました${result.superseded ? "(直後に新しい版が配信中になったため、この版は履歴のみ)" : ""}。${
                // superseded を先に判定する(配信ファイルは新しい版の公開が更新する。skipped を「設定されていない」と読ませない)
                result.superseded
                  ? ""
                  : result.staticDeploy === "deployed"
                    ? "設置タグの配信ファイルを更新しました。訪問者のブラウザには 1 分以内に届きます。"
                    : result.staticDeploy === "pending"
                      ? "設置タグの配信ファイルの更新を再試行しています(サイトの上部に状況が出ます)。"
                      : "設置タグの配信ファイルを更新する仕組みが設定されていません(導入手順を確認してください)。"
              }needsProfile=${result.needsProfile}`
            : `公開に失敗しました(v${result.version ?? "-"}: ${result.error}): ${result.message}。前の版が配信されたままです。原因を直して再試行してください`}
        </p>
      ) : null}
      {result?.ok && result.warnings.length > 0 ? <p className="banner-warn">警告: {result.warnings.map((w) => `${w.path}: ${w.message}`).join(" / ")}</p> : null}
      {result?.ok ? (
        <p>
          <Link href={`${base}/history`}>公開履歴を見る</Link>
        </p>
      ) : null}
      {error ? <p className="error-box">{error}</p> : null}
    </div>
  );
}
