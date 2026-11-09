import type { Experiment, Status } from "@/lib/types";

/** 取得済みの一覧をクライアント側で絞るだけ。終了したものは既定で除く */
export const STATUS_FILTERS = ["not_archived", "all", "running", "draft", "paused", "archived"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];
export const DEFAULT_STATUS_FILTER: StatusFilter = "not_archived";

export const STATUS_JA: Record<Status, string> = { draft: "下書き", running: "配信中", paused: "一時停止", archived: "終了" };
export const FILTER_JA: Record<StatusFilter, string> = { not_archived: "終了以外", all: "すべて", ...STATUS_JA };
export const STATUS_TONE: Record<Status, "ok" | "warn" | "gray"> = { running: "ok", paused: "warn", draft: "gray", archived: "gray" };

export function countByFilter(experiments: Experiment[]): Record<StatusFilter, number> {
  const out: Record<StatusFilter, number> = { not_archived: 0, all: experiments.length, running: 0, draft: 0, paused: 0, archived: 0 };
  for (const e of experiments) out[e.status] += 1;
  out.not_archived = out.all - out.archived;
  return out;
}

export function filterExperiments(experiments: Experiment[], filter: StatusFilter): Experiment[] {
  if (filter === "not_archived") return experiments.filter((e) => e.status !== "archived");
  return filter === "all" ? experiments : experiments.filter((e) => e.status === filter);
}
