"use client";
import { describeUrlMatch, type UrlMatchValue } from "@/lib/url-match";
import styles from "./Delivery.module.css";

/**
 * 配信条件のカードの最後の要約の 1 文(B69 spec §7.1):
 * 「<含める> または …(ただし <除く> を除く)のページを開いた、<訪問者の条件> の訪問者のうち N%(割当を固定)」。
 * targetingText が空なら条件なし(すべての訪問者)
 */
export function DeliverySummary({ urlMatch, targetingText, traffic, persist }: { urlMatch: UrlMatchValue; targetingText: string; traffic: number; persist: boolean }) {
  const d = describeUrlMatch(urlMatch);
  return (
    <p className={styles.summary} data-testid="delivery-summary">
      <span className="muted">配信する相手: </span>
      <b>{d.include.join(" または ")}</b>
      {d.exclude.length ? (
        <>
          (ただし <b>{d.exclude.join(" または ")}</b> を除く)
        </>
      ) : (
        " "
      )}
      のページを開いた、
      {targetingText ? (
        <>
          <b>{targetingText}</b> の訪問者
        </>
      ) : (
        "すべての訪問者"
      )}
      のうち <b>{traffic}%</b>
      {persist ? "(割当を固定)" : null}
    </p>
  );
}
