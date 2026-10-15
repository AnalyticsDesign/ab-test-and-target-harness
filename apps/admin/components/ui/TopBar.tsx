import { Fragment } from "react";
import Link from "next/link";
import { Icon } from "./Icon";
import { Crumb } from "./Crumb";
import styles from "./TopBar.module.css";

export type PublishState = { href: string; activeVersion: number | null; hasUnpublished: boolean; canPublish: boolean; siteId: string };

/**
 * 上部バー(決定 54 (2)(8))。パンくずの先頭は必ず「ホーム」(ホームの画面ではリンクにしない)。crumbs には「ホーム」を含めずに渡す。
 * サイトの中では「サイト ID」の印・画面名・配信中の版・未公開の編集・公開のボタン。公開は確認画面へのリンクで、管理者未満は無効 + title
 */
export function TopBar({ crumbs, publish }: { crumbs: Array<{ label: string; href?: string }>; publish?: PublishState }) {
  const all = [{ label: "ホーム", href: crumbs.length > 0 ? "/w" : undefined }, ...crumbs];
  return (
    <header className={styles.bar}>
      <div className={styles.crumbs}>
        {all.map((c, i) => (
          <Fragment key={`${i}-${c.label}`}>
            {i > 0 ? <span className={styles.sep}>/</span> : null}
            {c.href ? <Link href={c.href}>{c.label}</Link> : <span>{c.label}</span>}
          </Fragment>
        ))}
        {publish ? (
          <>
            <span className="badge mono">サイト ID: {publish.siteId}</span>
            <span className={styles.sep}>/</span>
            <Crumb />
          </>
        ) : null}
      </div>
      {publish ? (
        <div className={styles.state}>
          <span>{publish.activeVersion ? `配信中 v${publish.activeVersion}` : "未公開"}</span>
          {publish.hasUnpublished ? <span className={styles.unpublished}>· 未公開の編集あり</span> : null}
          {publish.canPublish ? (
            <Link href={publish.href} className={publish.hasUnpublished ? "btn btn-primary" : "btn"} data-testid="topbar-publish" data-variant={publish.hasUnpublished ? "primary" : "secondary"}>
              <Icon name="upload" />
              公開
            </Link>
          ) : (
            <button type="button" className="btn" disabled title="公開は管理者以上が行います" data-testid="topbar-publish" data-variant="disabled">
              <Icon name="upload" />
              公開
            </button>
          )}
        </div>
      ) : null}
    </header>
  );
}
