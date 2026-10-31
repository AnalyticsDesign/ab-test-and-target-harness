import { notFound } from "next/navigation";
import { controlFetch, requireUser } from "@/lib/control";
import { allInOrder, loadCapabilities, loadSite, loadWorkspaces } from "@/lib/loaders";
import { tabsFor } from "@/lib/experiment-draft";
import type { PlanView } from "@/lib/evaluation-plan";
import { STATUS_JA, STATUS_TONE } from "@/lib/experiment-filter";
import { KIND_JA } from "@/lib/experiment-kind";
import { pickParam } from "@/lib/url-state";
import type { Audience, Experiment, Goal } from "@/lib/types";
import { ExperimentEditor } from "@/components/ExperimentEditor";
import { StatusButtons } from "@/components/StatusButtons";
import { DuplicateButton } from "@/components/experiment/DuplicateButton";
import { DuplicatedNotice } from "@/components/experiment/DuplicatedNotice";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";

export default async function ExperimentPage({ params, searchParams }: { params: Promise<{ wid: string; sid: string; eid: string }>; searchParams: Promise<{ tab?: string | string[]; variant?: string | string[]; duplicated?: string | string[]; analyticsFailed?: string | string[] }> }) {
  const { wid, sid, eid } = await params;
  // 互いに依らない取得は並べて読む(allInOrder。失敗は並べた順に判定するので、未ログインは今までどおりログインへ)
  // 対象が無いときも site・目標・オーディエンスを取りに行くが、使うのは下の notFound の判定の後だけ。
  // 決定 43 (6): capabilities は実験編集画面で 1 回読む。失敗は「有効」側(control が 409 / 422 で最終判定する)
  const [, workspaces, exp, siteRes, goalsRes, audiencesRes, caps] = await allInOrder([
    requireUser(),
    loadWorkspaces(),
    controlFetch<Experiment>(`/sites/${sid}/experiments/${eid}`),
    loadSite(sid),
    controlFetch<Goal[]>(`/sites/${sid}/goals`),
    controlFetch<Audience[]>(`/sites/${sid}/audiences`),
    loadCapabilities(),
  ]);
  const ws = workspaces.find((w) => w.id === wid);
  if (!ws || exp.status !== 200) notFound();
  const site = siteRes.data;
  const goals = goalsRes.data;
  const audiences = audiencesRes.data;
  const canPublish = ws.role === "owner" || ws.role === "admin";
  // D9 ③ Task 14: 評価計画はテストだけ(パーソナライズは 404)。読めなければ null(タブで「読めませんでした」を出す)
  const planRes = exp.data.kind === "test" ? await controlFetch<PlanView>(`/sites/${sid}/experiments/${eid}/evaluation-plan`) : null;
  const initialPlan = planRes && planRes.status === 200 ? planRes.data : null;
  // 結果を記録するか = Site の設定が有効で、導入に計測用のデータベースがある(control が開始で run_id を振る条件と同じ)
  const recording = site.resultsEnabled && caps.resultsStore;
  // フォームを最新の値で作り直す key(updatedAt と破棄の世代)は ExperimentEditor の中(本体)にある
  // (components/ExperimentEditor.tsx)。見出し・StatusButtons・状態行はその外(このページ)に置く ——
  // 中に入れると status 変更が updated_at を進めて本体ごと作り直し、Publish の結果メッセージ
  // (とりわけ失敗時のアラート)が読まれる前に消えるため
  const sp = await searchParams;
  const initialTab = pickParam(sp.tab, tabsFor(exp.data.kind), "overview");
  const variantParam = Array.isArray(sp.variant) ? sp.variant[0] : sp.variant;
  const initialVariant = exp.data.variants?.some((v) => v.id === variantParam) ? variantParam! : null;
  // B108: 複製の画面から移ってきた印(DuplicatedNotice が URL から消す)
  const duplicated = pickParam(sp.duplicated, ["1"], "") === "1";
  const analyticsFailed = pickParam(sp.analyticsFailed, ["1"], "") === "1";
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
            <StatusButtons wid={wid} timeZone={site.timezone} siteId={site.id} experiment={exp.data} canPublish={canPublish} recording={recording} goals={goals} />
          </span>
        }
      />
      {/* B108: 画面は PageHeader から始める(決まり 1.2)。作ったエクスペリエンスの ID は見出しの下に出ている */}
      {duplicated ? <DuplicatedNotice analyticsFailed={analyticsFailed} /> : null}
      <p data-testid="status-banner" className="muted" data-status={exp.data.status} data-published-status={exp.data.publishedStatus ?? "none"}>
        状態: {STATUS_JA[exp.data.status]} / 本番: {exp.data.publishedStatus ? STATUS_JA[exp.data.publishedStatus] : "未反映"}。編集内容は「保存」で下書きに入ります。本番に出すには、画面の上部の「公開」を押します(管理者以上)。開始・一時停止・終了でも公開されますが、そのときはこのサイトのほかのエクスペリエンスの保存済みの下書きも一緒に本番に出ます
      </p>
      <ExperimentEditor site={site} experiment={exp.data} goals={goals} audiences={audiences} role={ws.role} imageUpload={caps.imageUpload} initialTab={initialTab} initialVariant={initialVariant} wid={wid} initialPlan={initialPlan} recording={recording} resultsStore={caps.resultsStore} />
    </div>
  );
}
