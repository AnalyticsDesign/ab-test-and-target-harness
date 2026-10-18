"use client";
import { useId, type ReactNode } from "react";
import { Icon } from "../ui/Icon";
import styles from "./AnalyticsCard.module.css";

/** dataLayer に出る欄の ⓘ に付ける共通の注意(B77 Q25。名前の欄には付けない) */
export const EXPOSED_NOTE = "dataLayer に出力され、サイトの訪問者もブラウザで見られます。社内向けの言葉や個人情報は入れないでください";

/**
 * 外部計測のカード(B77 Q30・Q30b)。見出しのボタンで開閉する。開閉の状態は呼び出し側が持つ
 * (ExperimentEditor の外枠。保存の後の作り直し・タブやパターンの往復をまたいで残すため)
 */
export function AnalyticsCard({ title, badge, open, onOpenChange, bare, children }: { title: string; badge?: ReactNode; open: boolean; onOpenChange: (open: boolean) => void; bare?: boolean; children: ReactNode }) {
  return (
    // bare = 外枠の card を付けない(追加フォームなど、すでにカードの中に置くとき)
    <section className={bare ? styles.bare : `card ${styles.card}`} aria-label={title}>
      <h2 className={styles.head}>
        <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => onOpenChange(!open)}>
          <span className={styles.chev}>
            <Icon name="right" size={14} />
          </span>
          <span>{title}</span>
          {badge}
        </button>
      </h2>
      {open ? <div className={styles.body}>{children}</div> : null}
    </section>
  );
}

/** 見出しの印: 設定した項目の数と、本来の値を置き換えているときの「上書き」(B77 Q19 / Q20) */
export function AnalyticsBadges({ count, overridden, countTitle }: { count: number; overridden?: boolean; countTitle: string }) {
  return (
    <span className={styles.badges}>
      {count > 0 ? (
        <span className={`badge ${styles.count}`} title={countTitle}>
          {count}
        </span>
      ) : null}
      {overridden ? <span className="badge badge-warn">上書き</span> : null}
    </span>
  );
}

/** 開いた中の 1 節(B77 E2)。入力の節は灰色の面、出力の節(`output`)は枠線だけ。補足は見出しの ⓘ */
export function AnalyticsSection({ title, tip, tipLabel, mark, output, children }: { title: string; tip: ReactNode; tipLabel: string; mark?: ReactNode; output?: boolean; children: ReactNode }) {
  return (
    <div className={output ? `${styles.sec} ${styles.out}` : styles.sec}>
      <h3 className={styles.secTitle}>
        {title}
        <InfoTip label={tipLabel}>{tip}</InfoTip>
        {mark}
      </h3>
      <div className={styles.secBody}>{children}</div>
    </div>
  );
}

/** ⓘ のツールチップ。hover とキーボードのフォーカスで出す。読み上げは aria-describedby で中身を読む */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <button type="button" className={styles.tip} aria-label={label} aria-describedby={id}>
      <Icon name="info" size={15} />
      <span id={id} className={styles.bubble} role="tooltip">
        {children}
      </span>
    </button>
  );
}

/**
 * エクスペリエンスの追加の値の行の「上書き n 件」(B77 Q21)。印は件数だけにし、どのパターンかはツールチップで出す
 * (パターン名が長くても欄を押しつぶさない)。吹き出しは行の右端にそろえる
 */
export function OverrideTip({ variants }: { variants: string[] }) {
  const id = useId();
  return (
    <button type="button" className={`${styles.tip} ${styles.warnTip}`} aria-label="上書きしているパターン" aria-describedby={id}>
      <span className="badge badge-warn">上書き {variants.length} 件</span>
      <span id={id} className={styles.bubble} role="tooltip">
        次のパターンでは、パターン側の値を出力します: {variants.join("、")}
      </span>
    </button>
  );
}

/** 「出力するキー n / 20」(B77 Q22)。20 を超えたら赤。ボタンは止めない */
export function KeyCount({ children, over }: { children: ReactNode; over: boolean }) {
  return <span className={over ? `${styles.keyCount} ${styles.over}` : styles.keyCount}>{children}</span>;
}
