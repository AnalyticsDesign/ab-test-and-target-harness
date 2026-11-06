"use client";
import { StatusPill } from "@/components/ui/StatusPill";
import { assetBadges, formatBytes, formatName } from "@/lib/images";
import type { SiteAsset } from "@/lib/types";
import styles from "./ImageLibrary.module.css";

/** 縮小画像(4:3・市松模様・contain)。縮小版がまだなら元の画像を出し、作り待ちなら右下に「縮小版を作成中」 */
export function AssetThumb({ asset, className }: { asset: SiteAsset; className?: string }) {
  return (
    <span className={`${styles.thumb}${className ? ` ${className}` : ""}`}>
      {/* 画面に入った分だけ読む。縮小版も元の画像も公開 URL からブラウザが直接読む(control を通らない) */}
      <img src={asset.thumbnailUrl ?? asset.publicUrl} alt="" loading="lazy" decoding="async" />
      {asset.thumbnail === "pending" ? <span className={styles.pending}>縮小版を作成中</span> : null}
    </span>
  );
}

/** 格子の 1 枚。一覧の画面では押すと右に詳細を開く(もう一度押すと閉じる)。選ぶ窓では押すと選び、ダブルクリックで使う */
export function ImageTile({ asset, selected, now, onSelect, onActivate }: { asset: SiteAsset; selected: boolean; now: number | null; onSelect: (id: string) => void; onActivate?: (id: string) => void }) {
  return (
    <button
      type="button"
      className={styles.tile}
      aria-pressed={selected}
      title={asset.name}
      onClick={() => onSelect(asset.id)}
      onDoubleClick={onActivate ? () => onActivate(asset.id) : undefined}
    >
      <AssetThumb asset={asset} />
      <span className={styles.meta}>
        <span className={styles.tileName}>{asset.name}</span>
        <span className={styles.sub}>
          {formatBytes(asset.size)} · {formatName(asset.mime)}
        </span>
        <span className={`${styles.sub} ${styles.badges}`}>
          {assetBadges(asset, now).map((b) => (
            <StatusPill key={b.label} tone={b.tone} title={b.title}>
              {b.label}
            </StatusPill>
          ))}
        </span>
      </span>
    </button>
  );
}
