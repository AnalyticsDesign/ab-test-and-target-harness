"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiClientError } from "@/lib/client";
import type { UsageReport, UsageSettingsView } from "@/lib/types";
import { formatPercent, RESOURCE_LABELS, settingsLine, statusLabel, summaryView, topResources, type SummaryInput } from "@/lib/usage";
import { LocalTime } from "../LocalTime";
import { UsageTable } from "./UsageTable";

/**
 * ホームの使用状況の要約(backlog D10、決定 54 (8)、plan K25)。ホームの本文を待たせないよう、表示の後に読む。
 * まず GET /usage/settings を読み(全員)、見られない人(403)には節ごと出さない。未設定なら GET /usage は呼ばない。
 * 何を出すかは lib/usage.ts の summaryView が決める(未設定・取得の失敗はシステム管理者にだけ案内する)。
 * システム管理者には、今の設定の 1 行と変更へのリンク(どちらの設定でも)。出すかは view.adminLine で決め、JSX の中で instanceAdmin を直接見ない。
 * 使用状況の画面へのリンクは prefetch={false}(その画面が GET /usage を呼ぶので、先読みが使用量を増やし、未設定でも 503 を起こす)
 */
export function UsageSummary({ instanceAdmin }: { instanceAdmin: boolean }) {
  const [settings, setSettings] = useState<UsageSettingsView | null>(null);
  const [usage, setUsage] = useState<SummaryInput["usage"]>(null);
  // 設定を読めない(403 = 見られない)。ほかの失敗も要約は出さない(詳細は設定 > システム > Cloudflare 使用状況で確かめる)
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let alive = true;
    api<UsageSettingsView>("GET", "/usage/settings")
      .then((s) => {
        if (!alive) return;
        setSettings(s);
        if (!s.configured) return; // 未設定なら /usage は呼ばない(503 になるだけ)
        return api<UsageReport>("GET", "/usage")
          .then((report) => alive && setUsage({ ok: true, report }))
          .catch((e: unknown) => {
            if (!alive) return;
            setUsage(e instanceof ApiClientError ? { ok: false, status: e.status, data: e.extra } : { ok: false, status: 0, data: null });
          });
      })
      .catch(() => alive && setDenied(true));
    return () => {
      alive = false;
    };
  }, []);

  const view = denied ? ({ kind: "hidden" } as const) : summaryView({ instanceAdmin, settings, usage });
  if (view.kind === "hidden") return null;
  const worst = view.kind === "ok" ? view.report.worst : null;
  // worst の行の予測(K25)。上限に達する見込みが当日中にあるときだけ出る
  const worstAt = view.kind === "ok" && worst ? (view.report.resources.find((r) => r.id === worst.id)?.projectedExhaustAt ?? null) : null;
  return (
    <section aria-labelledby="home-usage" data-testid="usage-summary" style={{ marginTop: 24 }}>
      <div className="row" style={{ alignItems: "baseline", marginBottom: 12 }}>
        <h2 id="home-usage" style={{ margin: 0 }}>使用状況</h2>
        {view.adminLine ? (
          <span className="muted" style={{ marginLeft: "auto" }}>
            {settings ? settingsLine(settings) : ""} (<Link href="/w/me/usage" prefetch={false}>変更</Link>)
          </span>
        ) : null}
      </div>
      {view.kind === "loading" ? <p className="muted">読み込み中…</p> : null}
      {view.kind === "unavailable" ? (
        <div className="card">
          <p><strong>{view.title}</strong></p>
          <p className="muted">{view.hint}</p>
        </div>
      ) : null}
      {view.kind === "ok" ? (
        <>
          {worst ? (
            <p>
              いちばん逼迫している資源: {RESOURCE_LABELS[worst.id] ?? worst.id} {formatPercent(worst.ratio)}({statusLabel(worst.status)})
              {worstAt ? <> · <LocalTime at={worstAt} kind="time" /> ごろに上限</> : null}
            </p>
          ) : null}
          <UsageTable report={view.report} limit={topResources(view.report, 3)} />
          {view.adminLine ? <Link href="/w/me/usage" prefetch={false}>詳細</Link> : null}
        </>
      ) : null}
    </section>
  );
}
