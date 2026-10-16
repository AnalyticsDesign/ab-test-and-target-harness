import { notFound } from "next/navigation";
import { controlFetch, requireUser } from "@/lib/control";
import { loadCapabilities, loadSite, loadWorkspaces } from "@/lib/loaders";
import { EDITOR_TABS } from "@/lib/experiment-draft";
import { STATUS_JA, STATUS_TONE } from "@/lib/experiment-filter";
import { KIND_JA } from "@/lib/experiment-kind";
import { readParam } from "@/lib/url-state";
import type { Audience, Experiment, Goal } from "@/lib/types";
import { ExperimentEditor } from "@/components/ExperimentEditor";
import { StatusButtons } from "@/components/StatusButtons";
import { DuplicateButton } from "@/components/experiment/DuplicateButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";

export default async function ExperimentPage({ params, searchParams }: { params: Promise<{ wid: string; sid: string; eid: string }>; searchParams: Promise<{ tab?: string; variant?: string }> }) {
  await requireUser();
  const { wid, sid, eid } = await params;
  const ws = (await loadWorkspaces()).find((w) => w.id === wid);
  const exp = await controlFetch<Experiment>(`/sites/${sid}/experiments/${eid}`);
  if (!ws || exp.status !== 200) notFound();
  const site = (await loadSite(sid)).data;
  const goals = (await controlFetch<Goal[]>(`/sites/${sid}/goals`)).data;
  const audiences = (await controlFetch<Audience[]>(`/sites/${sid}/audiences`)).data;
  // 決定 43 (6): 実験編集画面で 1 回読む。失敗は「有効」側(control が 409 / 422 で最終判定する)
  const caps = await loadCapabilities();
  const canPublish = ws.role === "owner" || ws.role === "admin";
  // フォームを最新の値で作り直す key(updatedAt と破棄の世代)は ExperimentEditor の中(本体)にある
  // (components/ExperimentEditor.tsx)。見出し・StatusButtons・状態行はその外(このページ)に置く ——
  // 中に入れると status 変更が updated_at を進めて本体ごと作り直し、Publish の結果メッセージ
  // (とりわけ失敗時のアラート)が読まれる前に消えるため
  const sp = await searchParams;
  const initialTab = readParam(`?tab=${sp.tab ?? ""}`, "tab", EDITOR_TABS, "overview");
  const initialVariant = exp.data.variants?.some((v) => v.id === sp.variant) ? sp.variant! : null;
  return (
    <div>
      <PageHeader
        title={exp.data.name}
        meta={
          <span className="row" style={{ gap: 8 }}>
            <span className="badge" data-testid="experiment-kind">{KIND_JA[exp.data.kind]}</span>
            <StatusPill tone={STATUS_TONE[exp.data.status]}>{STATUS_JA[exp.data.status]}</StatusPill>
            <span className="mono">{exp.data.id}</span>
            {exp.data.unpublished ? <span className="badge badge-warn">未公開の編集あり</span> : null}
          </span>
        }
        actions={
          <span className="row" style={{ gap: 8 }}>
            {ws.role !== "viewer" ? <DuplicateButton wid={wid} siteId={site.id} experiment={exp.data} /> : null}
            <StatusButtons siteId={site.id} experiment={exp.data} canPublish={canPublish} />
          </span>
        }
      />
      <p data-testid="status-banner" className="muted" data-status={exp.data.status} data-published-status={exp.data.publishedStatus ?? "none"}>
        状態: {STATUS_JA[exp.data.status]} / 本番: {exp.data.publishedStatus ? STATUS_JA[exp.data.publishedStatus] : "未反映"}。編集内容は「保存」で下書きに入ります。本番に出すには、画面の上部の「公開」を押します(管理者以上)。開始・一時停止・終了でも公開されますが、そのときはこのサイトのほかのエクスペリエンスの保存済みの下書きも一緒に本番に出ます
      </p>
      <ExperimentEditor site={site} experiment={exp.data} goals={goals} audiences={audiences} role={ws.role} imageUpload={caps.imageUpload} initialTab={initialTab} initialVariant={initialVariant} />
    </div>
  );
}
