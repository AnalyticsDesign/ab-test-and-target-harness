import { Fragment } from "react";
import Link from "next/link";
import { Icon } from "./Icon";
import { Crumb } from "./Crumb";
import { VersionChip } from "./VersionChip";
import styles from "./TopBar.module.css";

/** historyHref = 版の札の「すべての公開履歴」の行き先(B60: 公開履歴は左メニューから外し、版の札から開く) */
export type PublishState = { href: string; activeVersion: number | null; hasUnpublished: boolean; canPublish: boolean; siteId: string; historyHref: string };

/**
 * 上部バー(決定 54 (2)(8))。パンくずの先頭は必ず「ホーム」(ホームの画面ではリンクにしない)。crumbs には「ホーム」を含めずに渡す。
 * サイトの中では「サイト ID」の印・画面名・版の札(直近の公開を開く)・未公開の編集・公開のボタン。公開は確認画面へのリンクで、管理者未満は無効 + 理由の文。
 * 幅が足りないときに縮むのはパンくずの側(各項目を省略表示にする)。右側の表示は縮めず、パンくずと重ならない(B60 D6)
 */
export function TopBar({ crumbs, publish }: { crumbs: Array<{ label: string; href?: string }>; publish?: PublishState }) {
  const all = [{ label: "ホーム", href: crumbs.length > 0 ? "/w" : undefined }, ...crumbs];
  return (
    <header className={styles.bar}>
      <div className={styles.crumbs} data-testid="topbar-crumbs">
        {all.map((c, i) => (
          <Fragment key={`${i}-${c.label}`}>
            {i > 0 ? <span className={styles.sep}>/</span> : null}
            {c.href ? <Link href={c.href}>{c.label}</Link> : <span>{c.label}</span>}
          </Fragment>
        ))}
        {publish ? (
          <>
            <span className="badge mono">サイト ID: {publish.siteId}</span>
            <Crumb sepClassName={styles.sep} />
          </>
        ) : null}
      </div>
      {publish ? (
        <div className={styles.state} data-testid="topbar-state">
          <VersionChip siteId={publish.siteId} activeVersion={publish.activeVersion} historyHref={publish.historyHref} />
          {publish.hasUnpublished ? <span className={styles.unpublished}>· 未公開の編集あり</span> : null}
          {publish.canPublish ? (
            <Link href={publish.href} className={publish.hasUnpublished ? "btn btn-primary" : "btn"} data-testid="topbar-publish" data-variant={publish.hasUnpublished ? "primary" : "secondary"}>
              <Icon name="upload" />
              公開
            </Link>
          ) : (
            <>
              {/* 押せない理由は見える文で添える(決まり 2.6。title だけではキーボード・タッチ・読み上げに届かない)。ボタンの左に置く(2.3) */}
              <span id="topbar-publish-reason">公開は管理者以上が行います</span>
              <button type="button" className="btn" disabled aria-describedby="topbar-publish-reason" data-testid="topbar-publish" data-variant="disabled">
                <Icon name="upload" />
                公開
              </button>
            </>
          )}
        </div>
      ) : null}
    </header>
  );
}
