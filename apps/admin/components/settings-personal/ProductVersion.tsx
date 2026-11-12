import { productVersionView } from "@/lib/product-version";
import { StatusPill } from "@/components/ui/StatusPill";
import styles from "./ProductVersion.module.css";

/** 版はサーバーで描く。クライアントの静的 JS には埋め込まない。 */
export function ProductVersion({ admin, control, apiVersion }: { admin: string; control: string | null; apiVersion: number | null }) {
  const view = productVersionView(admin, control);
  return (
    <div className={styles.about}>
      <p className={styles.lead}>この管理画面と API(control)の製品の版です。公開リポジトリの Release の版名と同じです。版を確かめたいときや、問い合わせのときに使います。</p>
      {view.kind === "diff" ? (
        <div className="banner-warn" role="note" style={{ display: "block" }} data-testid="version-mismatch">管理画面と control の版が違います。更新の途中か、どちらかの更新が漏れています。更新の手順の「確認」の節を見てください。</div>
      ) : null}
      <section className={styles.card}>
        <h2>AB Test and Target Harness</h2>
        <dl className={styles.kv}>
          <dt>製品の版</dt>
          <dd>
            <span className={`mono ${styles.version} ${view.kind === "diff" ? styles.warn : ""}`} data-testid="product-version">{view.kind === "diff" ? `管理画面 ${view.admin} · control ${view.control}` : view.kind === "same" ? view.version : view.admin}</span>
            {view.kind === "diff" ? <StatusPill tone="warn">版が違う</StatusPill> : null}
          </dd>
          <dt>管理画面</dt><dd><span className="mono" data-testid="admin-version">{admin}</span></dd>
          <dt>control(API)</dt>
          <dd>
            {/* 不明の札は版の文字(mono)の外に出す。API 契約の版の行と同じ出し方 */}
            {control !== null ? <span className="mono" data-testid="control-version">{control}</span> : <span data-testid="control-version"><StatusPill tone="gray">不明</StatusPill></span>}
            {control === null ? <span className="muted">control がこの項目を返さない(更新の前の版)か、読み込めませんでした</span> : null}
          </dd>
          <dt>API 契約の版</dt>
          <dd>{apiVersion !== null ? <span className="mono" data-testid="api-version">{apiVersion}</span> : <span data-testid="api-version"><StatusPill tone="gray">不明</StatusPill></span>}<span className="muted">(エージェントが要求の形を合わせるための数。製品の版とは別)</span></dd>
        </dl>
      </section>
    </div>
  );
}
