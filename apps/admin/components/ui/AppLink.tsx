"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, type ComponentProps, type FocusEvent, type MouseEvent, type TouchEvent } from "react";
import { isFocusVisible, isPlainLeftClick, prefetchQuietly } from "@/lib/prefetch-intent";
import { deferUntilRefreshed, isRefreshPending } from "@/lib/refresh-wait";

type LinkProps = ComponentProps<typeof Link>;

/**
 * 管理画面の Link はすべてこれを使う(next/link を直接 import しない。test/app-link.test.ts が検査する)。
 * 既定の先読みを「画面に見えたら」から「マウスが乗った・フォーカスした・触れたとき」に変える(管理画面の速さ D)。
 *
 * なぜ: vinext(1.0.0-beta.10)の Link は、画面の 250px 手前に入ったリンクを全部先読みする。先読みは 1 本ごとに
 * admin の Worker の描画(= control への問い合わせ 3〜6 回)になり、オーディエンスの一覧を開くだけで 35 回あった(request-count の E2E)。
 * その先読みの中身はクリックの後に使い回されない(実測): loading.tsx のある画面は loading.tsx までの枠だけを取り、クリックでは本描画を取り直す。
 * loading.tsx の無い画面(ホーム・ワークスペースのトップ・サイトのトップ・サイト設定)は画面全体を描いて取るが、取り終えた後(2〜3 秒後)の
 * クリックではやはり取り直す(取り終える前に押したときだけ、その応答を待って使う)。
 * 先読みが効くのは 1 点だけ: loading.tsx のある画面で、取った枠から「読み込み中」の表示を覚え、クリックの直後に出す
 * (先読みが無いと、クリックの後に応答が届くまで前の画面のまま止まって見える。RSC を 1.5 秒遅らせて約 90 ms と約 1840 ms の差を実測)。
 * そこで、押されそうなリンク(マウスが乗った・フォーカスした・触れた)だけを先読みする。vinext にこの指定は無く、prefetch={false} にすると
 * マウスが乗ったときの先読みも止まるので、Link の先読みは止め、router.prefetch() を自分で呼ぶ(同じ既定の方針で取り、取ったものは 30 秒の間は取り直さない)。
 *
 * prefetch={false} は、先読みそのものが害になる画面(control の先で外部 API を呼ぶ使用状況・配信ファイルの状態など)へのリンクに付け、マウスが乗っても取らない。
 * href は文字列だけにする(管理画面に URL オブジェクトの使い方は無く、router.prefetch() に渡す形をそろえるため)
 */
export function AppLink({
  href,
  prefetch,
  onMouseEnter,
  onFocus,
  onTouchStart,
  onClick,
  ...rest
}: Omit<LinkProps, "href" | "prefetch"> & { href: string; prefetch?: false }) {
  const router = useRouter();
  // Link と同じく、本番の build だけで先読みする(開発の next dev では先読みしない)
  const prefetchOnIntent = useCallback(() => {
    if (prefetch === false || process.env.NODE_ENV !== "production") return;
    // URL にできない href で throw しても、イベントの処理の外に出さない(lib/prefetch-intent.ts)
    prefetchQuietly(router, href);
  }, [router, href, prefetch]);
  return (
    <Link
      {...rest}
      href={href}
      prefetch={false}
      onMouseEnter={(e: MouseEvent<HTMLAnchorElement>) => {
        onMouseEnter?.(e);
        prefetchOnIntent();
      }}
      onFocus={(e: FocusEvent<HTMLAnchorElement>) => {
        onFocus?.(e);
        // キーボードで移ったフォーカスだけ(:focus-visible)。マウスで押したときのフォーカスは押す直前に起き、
        // router.prefetch() の中の確かめ(非同期)が終わる前に遷移がマウスで乗ったときの先読みを使い切るので、同じ画面をもう 1 回取ってしまう(実測)
        // :focus-visible を知らない古いブラウザでは先読みしない(matches が投げる SyntaxError は isFocusVisible の中で止める)
        if (isFocusVisible(e.currentTarget)) prefetchOnIntent();
      }}
      onTouchStart={(e: TouchEvent<HTMLAnchorElement>) => {
        onTouchStart?.(e);
        prefetchOnIntent();
      }}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        // 書き込みの後の読み直しが画面に反映される前に押した遷移は、vinext が黙って捨てる(lib/refresh-wait.ts。CE-R9)。
        // その間だけ、Link の遷移を止めて、反映の後に同じ行き先へ移る(後から押したリンクが前のものに替わる)。
        // 呼び出し元が止めたクリック(節のリンク・切り替えの枠など)と、新しいタブ・ダウンロードは触らない
        if (e.defaultPrevented || !isPlainLeftClick(e) || !isRefreshPending()) return;
        e.preventDefault();
        const options = { scroll: rest.scroll !== false };
        deferUntilRefreshed("navigation", () => (rest.replace ? router.replace(href, options) : router.push(href, options)));
      }}
    />
  );
}
