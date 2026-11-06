"use client";
import { AppLink } from "@/components/ui/AppLink";
import type { AssetProblemRow } from "@/lib/asset-problems";
import { isPlainLeftClick } from "@/lib/prefetch-intent";
import styles from "./ImageLibrary.module.css";

/**
 * 公開できない画像の一覧(B68。spec §22.5)。1 件ごとに理由・URL(等幅で短く。全文は title)・「エクスペリエンス名 / パターン名」のリンク。
 * 公開の確認の窓・公開の失敗・状態を変えるボタンの 409 が使う(行は lib/asset-problems.ts の assetProblemRows)。
 * inPlace = 今開いている画面の中で開く行の処理(無ければ null)。その行は遷移せず(クリックを止め、href は新しいタブ用に残す)、先読みもしない
 * (同じエクスペリエンスの画面を router で描き直すと、control への往復が起きるうえ、画面は tab・variant を切り替えないため)。
 * その行には data-in-place を付け、離れる前の確認(useLeaveGuard の capture 段)にも止めさせない(止めると onClick が呼ばれない)
 */
export function AssetProblemList({ rows, testId, inPlace }: { rows: AssetProblemRow[]; testId?: string; inPlace?: (row: AssetProblemRow) => (() => void) | null }) {
  if (rows.length === 0) return null;
  return (
    <ul className={styles.problems} data-testid={testId}>
      {rows.map((r) => {
        const here = inPlace?.(r) ?? null;
        return (
          <li key={r.key}>
            <span>{r.reason}</span>
            <code title={r.url}>{r.shortUrl}</code>
            {here ? (
              <AppLink
                href={r.href}
                prefetch={false}
                data-in-place=""
                onClick={(e) => {
                  // 新しいタブ・修飾キー付き・target・download のクリックはブラウザに任せる(AppLink・guardedHref と同じ判定)
                  if (!isPlainLeftClick(e)) return;
                  e.preventDefault();
                  here();
                }}
              >
                {r.label}
              </AppLink>
            ) : (
              <AppLink href={r.href}>{r.label}</AppLink>
            )}
          </li>
        );
      })}
    </ul>
  );
}
