"use client";
import { useState } from "react";
import { normalizeRegexInput } from "@wtt/core";
import type { Audience, Goal } from "@/lib/types";
import { BROWSER_LABELS, DAY_LABELS, DEVICE_LABELS, HOST_OPS, OS_LABELS, PATH_OPS, QUERY_OPS, REF_OPS, URL_OPS, audienceItems, makeNames } from "@/lib/conditions";
import { hh, type Cond, type Weekday } from "@/lib/targeting-tree";
import { PageMatchField } from "../PageMatchField";
import { Combo } from "../ui/Combo";
import { Picker } from "../ui/Picker";
import { RegexAssist } from "./RegexAssist";
import styles from "./Targeting.module.css";

export type RowCtx = { goals: Goal[]; audiences: Audience[]; retentionDays: number; timezone: string; allowAudience: boolean; disabled: boolean };

const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
/** 数値の欄の値。空欄は NaN のまま持ち、小数も丸めない(整数かどうかは保存の前の確認が見る。不正な入力を別の値に変えない) */
const int = (s: string) => (s.trim() === "" ? NaN : Number(s));

function Pills({ label, items, selected, onToggle, disabled }: { label: string; items: Array<[string, string]>; selected: string[]; onToggle: (v: string) => void; disabled: boolean }) {
  return (
    <span className={styles.pills} role="group" aria-label={label}>
      {items.map(([v, text]) => (
        <button key={v} type="button" className={styles.pill} aria-pressed={selected.includes(v)} disabled={disabled} onClick={() => onToggle(v)}>
          {text}
        </button>
      ))}
    </span>
  );
}

/**
 * 期間(閲覧・目標で同じ。設計書 §3・§11)。上限は Site の訪問者データの保存期間。期間の指定なしは within = null で明示的に表し、
 * 期間ありのあいだ(within !== null)は、日数の欄が空・0・負数でも欄を出し続ける(期間ありの状態のまま保存の前の確認で止める)
 */
function PeriodField({ within, lead, unit, retentionDays, onChange, disabled }: { within: number | null; lead: string; unit: string; retentionDays: number; onChange: (n: number | null) => void; disabled: boolean }) {
  const over = within !== null && within > retentionDays;
  return (
    <>
      <Picker
        label="期間"
        value={within !== null ? "on" : "0"}
        disabled={disabled}
        options={[{ value: "0", label: "期間の指定なし" }, { value: "on", label: lead }]}
        onChange={(v) => onChange(v === "on" ? Math.min(30, retentionDays) : null)}
      />
      {within !== null ? (
        <>
          <input className={styles.number} type="number" aria-label="日数" min={1} max={retentionDays} value={Number.isNaN(within) ? "" : within} disabled={disabled} onChange={(e) => onChange(int(e.target.value))} />
          <span className={styles.unit}>{unit}</span>
          <span className={styles.pills}>
            {[7, 30, 90].filter((d) => d <= retentionDays).map((d) => (
              <button key={d} type="button" className={styles.pill} aria-pressed={within === d} disabled={disabled} onClick={() => onChange(d)}>
                {d}
              </button>
            ))}
          </span>
          <span className={over ? styles.noteError : styles.note}>
            {over ? `⚠ 訪問者データの保存期間(${retentionDays} 日)を超えています。${retentionDays} 日以下にしてください(長い期間を使うには、サイトの設定で保存期間を延ばします)` : `訪問者データの保存期間(${retentionDays} 日)まで指定できます`}
          </span>
        </>
      ) : null}
    </>
  );
}

/** ページの URL / パス / ホストの条件の値と一致の仕方。正規表現なら ¥ を置き換えて案内を出す */
function PageCondFields({ cond, onChange, disabled }: { cond: Extract<Cond, { type: "url" | "path" | "host" }>; onChange: (c: Cond) => void; disabled: boolean }) {
  const [replaced, setReplaced] = useState(false);
  const regex = cond.op === "regex" || cond.op === "notRegex";
  const set = (next: typeof cond) => {
    const isRx = next.op === "regex" || next.op === "notRegex";
    const value = isRx ? normalizeRegexInput(next.value) : next.value;
    setReplaced(isRx && value !== next.value);
    onChange({ ...next, value });
  };
  const ops = cond.type === "url" ? URL_OPS : cond.type === "path" ? PATH_OPS : HOST_OPS;
  return (
    <>
      <input className={styles.text} aria-label="値" value={cond.value} disabled={disabled} onChange={(e) => set({ ...cond, value: e.target.value })} />
      <Picker label="一致の仕方" value={cond.op} disabled={disabled} options={ops} onChange={(op) => set({ ...cond, op })} />
      {regex && cond.type !== "url" ? <RegexAssist value={cond.value} part={cond.type} replaced={replaced} onApply={(v) => set({ ...cond, value: v })} /> : null}
    </>
  );
}

/** 条件の種類ごとの欄(種類 → 値 → 演算子の順。設計書 §12) */
export function ConditionFields({ cond, onChange, ctx }: { cond: Cond; onChange: (c: Cond) => void; ctx: RowCtx }) {
  const d = ctx.disabled;
  switch (cond.type) {
    case "url":
    case "path":
    case "host":
      return <PageCondFields cond={cond} onChange={onChange} disabled={d} />;
    case "query":
      return (
        <>
          <input className={styles.text} aria-label="パラメータ名" placeholder="utm_source" value={cond.name} disabled={d} onChange={(e) => onChange({ ...cond, name: e.target.value })} />
          {cond.op === "exists" || cond.op === "notExists" ? null : <input className={styles.text} aria-label="値" value={cond.value} disabled={d} onChange={(e) => onChange({ ...cond, value: e.target.value })} />}
          <Picker label="一致の仕方" value={cond.op} disabled={d} options={QUERY_OPS} onChange={(op) => onChange({ ...cond, op: op as typeof cond.op })} />
        </>
      );
    case "device":
    case "browser":
    case "os": {
      const labels = cond.type === "device" ? DEVICE_LABELS : cond.type === "browser" ? BROWSER_LABELS : OS_LABELS;
      return (
        <>
          <Pills label="値" items={Object.entries(labels)} selected={cond.values} disabled={d} onToggle={(v) => onChange({ ...cond, values: toggle(cond.values, v) })} />
          <Picker label="一致の仕方" value={cond.neg ? "notIn" : "in"} disabled={d} options={[{ value: "in", label: "のいずれか" }, { value: "notIn", label: "のいずれでもない" }]} onChange={(v) => onChange({ ...cond, neg: v === "notIn" })} />
        </>
      );
    }
    case "viewport":
      return (
        <>
          <Picker label="一致の仕方" value={cond.op} disabled={d} options={[{ value: "gte", label: "が次の幅以上" }, { value: "lt", label: "が次の幅未満" }, { value: "between", label: "が次の範囲" }]} onChange={(op) => onChange({ ...cond, op: op as typeof cond.op })} />
          {cond.op !== "lt" ? <input className={styles.number} type="number" aria-label="最小の幅" min={1} max={10000} value={Number.isNaN(cond.min) ? "" : cond.min} disabled={d} onChange={(e) => onChange({ ...cond, min: int(e.target.value) })} /> : null}
          {cond.op === "between" ? <span className={styles.unit}>px 〜</span> : null}
          {cond.op !== "gte" ? <input className={styles.number} type="number" aria-label="最大の幅" min={1} max={10000} value={Number.isNaN(cond.max) ? "" : cond.max} disabled={d} onChange={(e) => onChange({ ...cond, max: int(e.target.value) })} /> : null}
          <span className={styles.unit}>px</span>
        </>
      );
    case "referrer":
      return (
        <>
          {cond.op === "isEmpty" || cond.op === "notEmpty" ? null : <input className={styles.text} aria-label="値" value={cond.value} disabled={d} onChange={(e) => onChange({ ...cond, value: e.target.value })} />}
          <Picker label="一致の仕方" value={cond.op} disabled={d} options={REF_OPS} onChange={(op) => onChange({ ...cond, op: op as typeof cond.op })} />
        </>
      );
    case "time": {
      const hours = Array.from({ length: 24 }, (_, i) => ({ value: String(i), label: hh(i) }));
      const ends = Array.from({ length: 24 }, (_, i) => i + 1).map((h) => ({ value: String(h), label: `${h <= cond.from ? "翌 " : ""}${hh(h)}` }));
      return (
        <>
          <Pills label="曜日" items={DAY_LABELS} selected={cond.days} disabled={d} onToggle={(v) => onChange({ ...cond, days: toggle(cond.days, v as Weekday) })} />
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={cond.allDay} disabled={d} onChange={(e) => onChange({ ...cond, allDay: e.target.checked })} />
            終日
          </label>
          {cond.allDay ? null : (
            <>
              <Picker label="開始時刻" value={String(cond.from)} disabled={d} options={hours} onChange={(v) => onChange({ ...cond, from: Number(v) })} />
              <span className={styles.unit}>〜</span>
              <Picker label="終了時刻" value={String(cond.to)} disabled={d} options={ends} onChange={(v) => onChange({ ...cond, to: Number(v) })} />
            </>
          )}
          <span className={styles.unit}>サイトの時刻({ctx.timezone})</span>
          {!cond.allDay && cond.to <= cond.from ? (
            <span className={styles.note}>日をまたぐ範囲です。曜日は開始時刻の曜日で数えます(例: 金を選ぶと、金曜 {hh(cond.from)} から土曜 {hh(cond.to)} まで)</span>
          ) : null}
        </>
      );
    }
    case "visited":
      return (
        <>
          <Picker label="閲覧" value={cond.neg ? "didnt" : "did"} disabled={d} options={[{ value: "did", label: "閲覧した" }, { value: "didnt", label: "閲覧していない" }]} onChange={(v) => onChange({ ...cond, neg: v === "didnt" })} />
          <PageMatchField name={null} value={cond.page} disabled={d} onChange={(page) => onChange({ ...cond, page })} />
          {cond.neg ? null : (
            <>
              <input className={styles.number} type="number" aria-label="回数" min={1} value={Number.isNaN(cond.min) ? "" : cond.min} disabled={d} onChange={(e) => onChange({ ...cond, min: int(e.target.value) })} />
              <span className={styles.unit}>回以上</span>
            </>
          )}
          <PeriodField within={cond.within} lead={cond.neg ? "過去" : "最後の閲覧が"} unit={cond.neg ? "日に" : "日以内"} retentionDays={ctx.retentionDays} disabled={d} onChange={(within) => onChange({ ...cond, within })} />
        </>
      );
    case "goal":
      return (
        <>
          <Picker label="目標" value={cond.goal || null} disabled={d} placeholder="目標を選ぶ" options={ctx.goals.map((g) => ({ value: g.id, label: g.name, hint: g.id }))} onChange={(goal) => onChange({ ...cond, goal })} />
          <Picker label="達成" value={cond.neg ? "didnt" : "did"} disabled={d} options={[{ value: "did", label: "を達成済み" }, { value: "didnt", label: "が未達成" }]} onChange={(v) => onChange({ ...cond, neg: v === "didnt" })} />
          <PeriodField within={cond.within} lead={cond.neg ? "過去" : "最後の達成が"} unit={cond.neg ? "日に" : "日以内"} retentionDays={ctx.retentionDays} disabled={d} onChange={(within) => onChange({ ...cond, within })} />
        </>
      );
    case "elapsed":
      return (
        <>
          <span className={styles.unit}>が</span>
          <input className={styles.number} type="number" aria-label="数値" min={1} value={Number.isNaN(cond.n) ? "" : cond.n} disabled={d} onChange={(e) => onChange({ ...cond, n: int(e.target.value) })} />
          <Picker label="単位" value={cond.unit} disabled={d} options={[{ value: "hours", label: "時間" }, { value: "days", label: "日" }]} onChange={(unit) => onChange({ ...cond, unit: unit as typeof cond.unit })} />
          <Picker label="一致の仕方" value={cond.op} disabled={d} options={[{ value: "gte", label: "以上(リピーター)" }, { value: "lt", label: "未満(新規)" }]} onChange={(op) => onChange({ ...cond, op: op as typeof cond.op })} />
        </>
      );
    case "audience":
      return (
        <>
          <Combo label="オーディエンス" value={cond.audience || null} disabled={d} placeholder="オーディエンスを検索" items={audienceItems(ctx.audiences, makeNames(ctx.goals, ctx.audiences))} onChange={(audience) => onChange({ ...cond, audience })} />
          <Picker label="一致の仕方" value={cond.neg ? "out" : "in"} disabled={d} options={[{ value: "in", label: "に含まれる" }, { value: "out", label: "に含まれない" }]} onChange={(v) => onChange({ ...cond, neg: v === "out" })} />
        </>
      );
  }
}
