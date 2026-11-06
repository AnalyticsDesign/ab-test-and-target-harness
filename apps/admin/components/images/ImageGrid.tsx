"use client";
import type { SiteAsset } from "@/lib/types";
import { ImageTile } from "./ImageTile";
import styles from "./ImageLibrary.module.css";

/**
 * 縮小画像の格子(画像は見て選ぶため、表ではなく格子にする)。列の数は CSS で固定(ImageLibrary.module.css)。
 * 空のときも枠の場所に 1 行で出す(決まり 3.3)。
 * className = 列の数を変える(選ぶ窓は 6 / 3 / 2)。onActivate = ダブルクリック(選ぶ窓の「この画像を使う」と同じ)
 */
export function ImageGrid({
  items,
  selectedId,
  now,
  empty,
  onSelect,
  onActivate,
  className,
}: {
  items: SiteAsset[];
  selectedId: string | null;
  now: number | null;
  empty: string;
  onSelect: (id: string) => void;
  onActivate?: (id: string) => void;
  className?: string;
}) {
  if (items.length === 0) return <p className={styles.empty}>{empty}</p>;
  return (
    <div className={`${styles.grid}${className ? ` ${className}` : ""}`}>
      {items.map((a) => (
        <ImageTile key={a.id} asset={a} selected={a.id === selectedId} now={now} onSelect={onSelect} onActivate={onActivate} />
      ))}
    </div>
  );
}
