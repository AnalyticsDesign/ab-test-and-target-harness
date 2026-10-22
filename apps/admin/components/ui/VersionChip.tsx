"use client";
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api, ApiClientError } from "@/lib/client";
import { publishRowStatus, recentPublishes } from "@/lib/publish-status";
import { dropdownPosition } from "@/lib/switcher";
import type { PublishRow } from "@/lib/types";
import { LocalTime } from "../LocalTime";
import { Icon } from "./Icon";
import { StatusPill } from "./StatusPill";
import styles from "./VersionChip.module.css";

/** 開いた一覧の幅(モックの値)。狭い画面では dropdownPosition が縮める */
const POP_WIDTH = 340;

type Load = { kind: "loading" } | { kind: "ok"; rows: PublishRow[] } | { kind: "error"; text: string };

/** 取得の失敗の文。HTTP の失敗は状態コードを添え、fetch 自体の失敗(通信できない)とは分ける */
function loadErrorText(e: unknown): string {
  return e instanceof ApiClientError ? `公開履歴を取得できませんでした(HTTP ${e.status})` : "公開履歴を取得できませんでした(通信できませんでした)";
}

/**
 * 上部バーの版の札(B60 D2。公開履歴の入口)。緑の点 +「配信中 vN」(一度も公開していなければ「未公開」)+ 開く印。
 * 押すと札の下に直近 5 回の公開(版・状態の札・日時 · 実行者)が開き、下端に公開履歴の画面へのリンク。
 * 一覧は開くたびに BFF 経由で GET /sites/:sid/publishes を読み直し、クライアントで 5 件に切る(control に件数の指定は足さない)。
 * 失敗の後に開き直したときも読み直す。開くとフォーカスを一覧の箱へ移す(読み上げが見出しから始まり、Tab で中のリンクへ進める)。
 * 一覧は ContextSwitcher と同じく position: fixed(dropdownPosition で画面の内側に置く)。本文列(AppShell の .col)の overflow: hidden で切れないため。
 * 閉じ方も ContextSwitcher と同じ(Esc は札へフォーカスを戻す・外側のクリック・リンクのクリック・画面の移動・画面の大きさの変化。fixed の座標が札とずれるため)
 */
export function VersionChip({ siteId, activeVersion, historyHref }: { siteId: string; activeVersion: number | null; historyHref: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [pos, setPos] = useState<CSSProperties>({});
  const headingId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  // 開くたびに増やす。閉じて開き直した後に前の要求の応答が届いても、古い結果で上書きしない
  const request = useRef(0);

  const close = useCallback((focusButton: boolean) => {
    request.current += 1;
    setOpen(false);
    if (focusButton) button.current?.focus();
  }, []);
  // 画面を移ったら閉じる(上部バーはサイトの layout にあり、サイトの中の遷移をまたいで残る)
  useEffect(() => close(false), [pathname, close]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !button.current?.contains(t)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    };
    const onResize = () => close(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);
  // 開いたらフォーカスを一覧の箱へ(tabIndex = -1。箱そのものは Tab の順に入れない)
  useEffect(() => {
    if (open) pop.current?.focus();
  }, [open]);

  async function toggle() {
    if (open) return close(false);
    const id = ++request.current;
    setPos(dropdownPosition(button.current!.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, POP_WIDTH));
    setLoad({ kind: "loading" });
    setOpen(true);
    try {
      const rows = await api<PublishRow[]>("GET", `/sites/${siteId}/publishes`);
      // 2xx でも本文が配列でない(壊れた応答)なら、一覧を描かずに失敗として出す。HTTP の状態は成功なので状態コードは添えず、
      // 応答を受け取れなかったときと同じ「通信できませんでした」の文にする(利用者にできることは同じ = 開き直す)
      if (!Array.isArray(rows)) throw new Error("publishes is not an array");
      if (request.current === id) setLoad({ kind: "ok", rows: recentPublishes(rows) });
    } catch (e) {
      if (request.current === id) setLoad({ kind: "error", text: loadErrorText(e) });
    }
  }

  // publishRowStatus と同じく null かどうかで決める(版は 1 から始まるが、判定の書き方をそろえる)
  const text = activeVersion !== null ? `配信中 v${activeVersion}` : "未公開";
  return (
    <span className={styles.anchor}>
      <button
        ref={button}
        type="button"
        className={styles.chip}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${text}。公開履歴を開く`}
        data-testid="version-chip"
        onClick={toggle}
      >
        {activeVersion !== null ? <span className={styles.live} aria-hidden="true" /> : null}
        {text}
        <span className={styles.caret} aria-hidden="true">
          <Icon name="chevrons" size={12} />
        </span>
      </button>
      {open ? (
        <div
          ref={pop}
          className={styles.pop}
          style={pos}
          role="dialog"
          aria-labelledby={headingId}
          tabIndex={-1}
          data-testid="version-popover"
          // 今の画面と同じ先(公開履歴の画面にいて「すべての公開履歴」)を押すと pathname が変わらず開いたままになるので、リンクを押したら閉じる
          onClick={(e) => {
            if ((e.target as Element).closest("a")) close(false);
          }}
        >
          <h3 id={headingId} className={styles.head}>
            直近の公開
          </h3>
          {load.kind === "loading" ? <p className={styles.note}>読み込み中…</p> : null}
          {load.kind === "error" ? <p className={styles.note}>{load.text}</p> : null}
          {load.kind === "ok" && load.rows.length === 0 ? <p className={styles.note}>まだ公開していません</p> : null}
          {load.kind === "ok" && load.rows.length > 0 ? (
            <ul className={styles.list}>
              {load.rows.map((r) => {
                const st = publishRowStatus(r, activeVersion);
                // エラーの文は出さない(長い文で一覧が崩れる。中身は公開履歴の画面で読む)
                return (
                  <li key={r.version} className={styles.row} data-testid={`recent-publish-${r.version}`}>
                    <span className="mono">v{r.version}</span>
                    <StatusPill tone={st.tone}>{st.label}</StatusPill>
                    <small className={styles.meta}>
                      <LocalTime at={r.activatedAt ?? r.createdAt} /> · {r.publishedBy.name}
                    </small>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <div className={styles.foot}>
            <Link href={historyHref}>すべての公開履歴 →</Link>
          </div>
        </div>
      ) : null}
    </span>
  );
}
