"use client";
import { formatCount, type PageSlice } from "@/lib/images";
import styles from "./ImageLibrary.module.css";

/** ページ番号(前へ・番号・次へ・「49〜96 / 312 枚」)。「すべて」のとき(pages = 1)と 1 ページに収まるときは出さない */
export function Pager({ slice, onPage }: { slice: PageSlice; onPage: (page: number) => void }) {
  if (slice.pages <= 1) return null;
  const pages = Array.from({ length: slice.pages }, (_, i) => i + 1);
  return (
    <nav className={styles.pager} aria-label="ページ">
      <button type="button" className="btn btn-sm" disabled={slice.page <= 1} onClick={() => onPage(slice.page - 1)}>
        前へ
      </button>
      {pages.map((p) => (
        <button key={p} type="button" className="btn btn-sm" aria-current={p === slice.page ? "page" : undefined} onClick={() => onPage(p)}>
          {p}
        </button>
      ))}
      <button type="button" className="btn btn-sm" disabled={slice.page >= slice.pages} onClick={() => onPage(slice.page + 1)}>
        次へ
      </button>
      <span className="muted">
        {formatCount(slice.from)}〜{formatCount(slice.to)} / {formatCount(slice.total)} 枚
      </span>
    </nav>
  );
}
