// apps/admin/components/usage/UsagePanel.tsx
"use client";
import { useState } from "react";
import { api } from "@/lib/client";
import type { UsageReport, UsageSettings } from "@/lib/types";
import { ErrorBox } from "../ErrorBox";
import { SubmitButton } from "../SubmitButton";
import { PageHeader } from "../ui/PageHeader";
import { BusyScope, useBusyAction } from "../ui/BusyScope";
import { useBusyNotice } from "../ui/BusyNotice";
import { UsageTable } from "./UsageTable";
import styles from "./Usage.module.css";

type UsageResult = { ok: true; report: UsageReport } | { ok: false; title: string; hint: string };

/**
 * backlog D10: 使用状況の設定(見られる人・プラン・1 日の目安の表示)と詳細。設定の変更はシステム管理者のセッションだけ。
 * プランは自動では判定できない(請求の権限を求めないため)ので、契約に合わせて選んでもらう
 */
export function UsagePanel({ settings, usage }: { settings: UsageSettings; usage: UsageResult }) {
  return (
    <div>
      <PageHeader title="Cloudflare 使用状況" />
      <p className="muted">
        Cloudflare のアカウント全体の、今日(UTC 0 時から)の消費です。Free プランでは上限に達すると、管理画面・API・訪問者への配信の一部が次のリセット(表の下に現地時刻で表示)まで止まります。数値は Cloudflare 側の集計で、数分遅れます。
      </p>
      {/* 設定のフォームのカードを覆う(B173 第 2 段)。覆いの文言(role="status")はフォームの外に出る */}
      <BusyScope id="usage-settings">
        <UsageSettingsForm settings={settings} />
      </BusyScope>
      {usage.ok ? (
        <UsageTable report={usage.report} />
      ) : (
        <div className="card" data-testid="usage-unavailable">
          <h2>{usage.title}</h2>
          <p>{usage.hint}</p>
        </div>
      )}
    </div>
  );
}

/** 設定のフォーム。保存の結果はボタンの横(失敗はボタンのすぐ上)に出す。欄を変えたら成功の文を消す */
function UsageSettingsForm({ settings }: { settings: UsageSettings }) {
  const { run } = useBusyAction();
  const { notice, show, clear, clearStatus } = useBusyNotice();
  const [form, setForm] = useState<UsageSettings>(settings);
  const dirty = JSON.stringify(form) !== JSON.stringify(settings);
  const set = (next: UsageSettings) => {
    setForm(next);
    clearStatus();
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    clear();
    const body = form;
    const outcome = await run({
      label: "保存中…",
      write: (signal) => api("PATCH", "/usage/settings", body, { signal }),
      after: "refresh",
    });
    show(outcome, "保存しました");
  }

  return (
    <form className="card" onSubmit={save} data-testid="usage-settings">
      <h2>設定</h2>
      <fieldset className={styles.field}>
        <legend>見られる人</legend>
        <label><input type="radio" name="usageVisibility" checked={form.usageVisibility === "members"} onChange={() => set({ ...form, usageVisibility: "members" })} /> すべてのメンバー(ホームに要約が出ます)</label>
        <label><input type="radio" name="usageVisibility" checked={form.usageVisibility === "instance_admins"} onChange={() => set({ ...form, usageVisibility: "instance_admins" })} /> システム管理者のみ</label>
      </fieldset>
      <fieldset className={styles.field}>
        <legend>Cloudflare のプラン</legend>
        <label><input type="radio" name="cloudflarePlan" checked={form.cloudflarePlan === "free"} onChange={() => set({ ...form, cloudflarePlan: "free" })} /> Free(日次の上限で判定します)</label>
        <label><input type="radio" name="cloudflarePlan" checked={form.cloudflarePlan === "paid"} onChange={() => set({ ...form, cloudflarePlan: "paid" })} /> Paid(Workers Paid。日次の上限はありません)</label>
        <p className="muted">プランは自動では判定しません。契約に合わせて選んでください。実際は Free なのに Paid を選ぶと、止まる前の警告が出なくなります。</p>
      </fieldset>
      <fieldset className={styles.field} disabled={form.cloudflarePlan !== "paid"}>
        <legend>Paid の比較</legend>
        <label>
          <input type="checkbox" checked={form.showPaidReference} onChange={(e) => set({ ...form, showPaidReference: e.target.checked })} /> 月額 $5 に含まれる量と比べる(日次の行は 30 日で割った 1 日分)
        </label>
        {form.cloudflarePlan !== "paid" ? <p className="muted">Free は日次の上限を表示します</p> : null}
      </fieldset>
      <ErrorBox message={notice.error} />
      {notice.status ? <p role="status">{notice.status}</p> : null}
      <SubmitButton busy={false} disabled={!dirty}>保存</SubmitButton>
    </form>
  );
}
