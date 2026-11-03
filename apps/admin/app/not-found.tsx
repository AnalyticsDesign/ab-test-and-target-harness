import { AppLink } from "@/components/ui/AppLink";
import { PageMark } from "@/components/ui/PageMark";

/**
 * 存在しない画面・対象(notFound())の受け皿。入れ子の notFound() でも、一番近いこの境界が拾う。
 * PageMark(kind="notFound")は、移動先がこの画面になったことを知らせて、遷移の待ち表示を終える
 */
export default function NotFound() {
  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <PageMark kind="notFound" />
      <h1>ページが見つかりません</h1>
      <p className="muted">開こうとした画面は、存在しないか、見る権限がありません。</p>
      <AppLink className="btn" href="/w">
        ホームへ戻る
      </AppLink>
    </div>
  );
}
