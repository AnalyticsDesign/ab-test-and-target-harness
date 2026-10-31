import { cache } from "react";
import { controlFetch } from "@/lib/control";
import { resolveCapabilities } from "@/lib/capabilities";
import type { Capabilities, Site, Workspace, WorkspaceSummary } from "@/lib/types";

/** 同じ描画(1 リクエスト)の中で layout とページが同じ結果を使う。control への要求は引数ごとに 1 回 */

/** 所属するワークスペースの概要(ロール・メンバー数・サイトごとの配信中の数)。ワークスペース以下の全ページの layout が使う(K1) */
export const loadSummary = cache(async () => controlFetch<WorkspaceSummary[]>("/workspaces/summary"));
/**
 * loadSummary の中身。取れなかったら例外(画面全体のエラー = app/error.tsx)。
 * サイドバーやワークスペースの一覧を空のまま出すと、どこにいるのか・何が起きたのか分からないため(Review Focus 4)
 */
export const requireSummary = cache(async (): Promise<WorkspaceSummary[]> => {
  const r = await loadSummary();
  if (r.status !== 200) throw new Error(`ワークスペースの一覧を取得できませんでした(HTTP ${r.status})`);
  return r.data;
});
/** 所属するワークスペース(ロール付き)。summary から作る(control への要求を増やさない。K1)。取れなかったら例外(画面全体のエラー) */
export const loadWorkspaces = cache(async (): Promise<Workspace[]> => (await requireSummary()).map(({ id, name, role }) => ({ id, name, role })));
export const loadSites = cache(async (wid: string) => controlFetch<Site[]>(`/workspaces/${wid}/sites`));
export const loadSite = cache(async (sid: string) => controlFetch<Site>(`/sites/${sid}`));
export const loadCapabilities = cache(async () => resolveCapabilities(await controlFetch<Capabilities>("/capabilities")));

/**
 * 互いに依らない取得を並べて始め、結果は**並べた順に**判定する(admin speed B)。
 * Promise.all は時間で最初に reject したものを投げるので、どれが先に失敗するかで出る画面が変わる
 * (例: 未ログインで requireUser の redirect("/login") と requireSummary の例外が同時に起きると、ログインではなくエラーの画面が出うる)。
 * allSettled で全部を待ってから左から見て、最初の reject の理由をそのまま投げる(redirect・notFound の印を保つ)。
 * 直列に await していたときと同じものが投げられ、後ろの reject が未処理のまま残ることも無い
 */
export async function allInOrder<T extends readonly unknown[] | []>(promises: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const settled = await Promise.allSettled(promises);
  for (const s of settled) if (s.status === "rejected") throw s.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<unknown>).value) as { -readonly [K in keyof T]: Awaited<T[K]> };
}
