"use client";
import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { ErrorBox } from "@/components/ErrorBox";
import { useNow } from "@/components/LocalTime";
import { BusyScope } from "@/components/ui/BusyScope";
import { Icon } from "@/components/ui/Icon";
import { afterUploadedSelection, canUsePick, filterSortPage, formatFileLimit, pickerInitial } from "@/lib/images";
import { useUploadQueue } from "@/lib/use-upload-queue";
import type { SiteAsset } from "@/lib/types";
import { ImageGrid } from "./ImageGrid";
import { Pager } from "./Pager";
import { useSiteAssets } from "./SiteAssetsProvider";
import { UploadQueue } from "./UploadQueue";
import styles from "./ImageLibrary.module.css";

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/avif";
/** 一度に表示する数(一覧の画面の既定 48 より少なく、窓に収める) */
const PER_PAGE = 24;

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/**
 * 「画像を選ぶ」の窓(B68。spec §9.4。見た目の正はモック v3 の案 A)。
 * 一覧は SiteAssetsProvider が持つ 1 回の読みを使う(開き直しても読み直さない)。削除待ちの画像は一覧の応答に入らないので出ない。
 * 確認のモーダル(ConfirmDialog)の土台は共有しない: 下端の並びが「キャンセル → この画像を使う」(U1)で、幅も 6 列の格子が要るため。
 * 役割は role="dialog"(確認ではない)。外のクリックでは閉じない(選びかけを消さない)。Esc はキャンセル。開いたらフォーカスは絞り込みの欄。
 * 窓の中のアップロードは一覧の画面と同じ待ち行列(BusyScope の run に乗せず、行で進みを出す。spec §11 の K2 = 案 A)。
 * 上がった画像は手元の一覧に足して選ぶ(複数なら最後に上がった 1 枚)。送っている間は離れる前の確認に「アップロードの途中です」を載せる。
 * 選んだ画像は呼び出し元が下書きに入れるだけ(保存は帯。spec §11 の K1)
 */
export function ImagePicker({ siteId, open, initial, onPick, onClose }: { siteId: string; open: boolean; initial: string; onPick: (asset: SiteAsset) => void; onClose: () => void }) {
  const ctx = useSiteAssets();
  const snapshot = ctx?.snapshot ?? { status: "idle" as const, list: null, error: null };
  const assets = snapshot.list?.assets ?? null;
  const now = useNow();
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [dragging, setDragging] = useState(false);

  // 開いたときに選択・絞り込み・ページを戻す(描画中に前回の open と比べて直す)。今の画像は一覧が読めたときに選ぶ
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSelected(pickerInitial(assets, initial));
      setQ("");
      setPage(1);
    }
  }
  // 開いた後に一覧が読み終わったら、今の画像を選んでおく(まだ何も選んでいないときだけ)
  const [seenList, setSeenList] = useState(assets);
  if (assets !== seenList) {
    setSeenList(assets);
    if (open && selected === null && seenList === null) setSelected(pickerInitial(assets, initial));
  }

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      search.current?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);

  const queue = useUploadQueue({
    siteId,
    // 送るのは一覧を読んだ後だけ(ボタンとドロップは読み終わるまで受けない)。null は来ないが、型のために上限なしの値で埋める
    usage: () => ctx?.store.usage() ?? { count: 0, bytes: 0, pendingCount: 0, pendingBytes: 0, maxCount: Infinity, maxBytes: Infinity, maxFileBytes: Infinity },
    onUploaded: (a) => {
      ctx?.store.uploaded(a);
      setSelected((s) => afterUploadedSelection(s, a));
      // 上がった画像が絞り込みで隠れないように、先頭のページに戻す(新しい順の先頭に入る)
      setQ("");
      setPage(1);
    },
    onUsage: (u) => ctx?.store.setUsage(u),
  });
  const ready = snapshot.status === "ready";
  const enqueue = (files: File[]) => {
    if (ready && files.length > 0) queue.enqueue(files);
  };

  const slice = filterSortPage(assets ?? [], { q, use: "all", sort: "new", per: PER_PAGE, page });
  const chosen = selected && assets ? (assets.find((a) => a.id === selected) ?? null) : null;
  const usable = canUsePick(selected, assets);
  const use = (asset: SiteAsset | null) => {
    if (asset) onPick(asset);
  };

  return (
    <dialog
      ref={ref}
      role="dialog"
      aria-labelledby={`${id}-title`}
      className={`dialog ${styles.pickerDialog}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // 保険: ブラウザが cancel を経ずに閉じたときも、呼び出し元の状態をキャンセルにそろえる
      onClose={() => {
        if (open) onClose();
      }}
      // 窓に落としたファイルは窓が受ける(ブラウザがファイルを開かないように、窓の中のドラッグは既定の動きを止める)
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
        enqueue(Array.from(e.dataTransfer.files));
      }}
    >
      <div className={styles.pickerHead}>
        <h2 id={`${id}-title`}>画像を選ぶ</h2>
        <input
          ref={search}
          type="search"
          placeholder="名前で絞り込む"
          aria-label="名前で絞り込む"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
      </div>
      <div className={styles.pickerBody}>
        <p className={`${styles.dropzone}${dragging ? ` ${styles.pickerDrop}` : ""}`}>
          ここに画像のファイルをドロップしてアップロードできます(上げた画像が選ばれます。PNG / JPEG / GIF / WebP / AVIF
          {snapshot.list ? `、1 枚 ${formatFileLimit(snapshot.list.usage.maxFileBytes)} まで` : ""})
          <button type="button" className="btn btn-sm" disabled={!ready} onClick={() => fileInput.current?.click()}>
            <Icon name="upload" />
            ファイルを選んでアップロード
          </button>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              enqueue(files);
            }}
          />
        </p>
        <BusyScope id="image-picker-uploads" prompt={queue.active ? "uploading" : undefined}>
          <UploadQueue rows={queue.rows} active={queue.active} onClose={queue.clear} activeHint="送っている間も、ほかの画像を選べます" />
        </BusyScope>
        {snapshot.status === "error" ? (
          <>
            <ErrorBox message={`画像の一覧を読めませんでした: ${snapshot.error ?? ""}`} />
            <div className="row">
              <button type="button" className="btn btn-sm" onClick={() => void ctx?.store.ensure()}>
                もう一度読み込む
              </button>
            </div>
          </>
        ) : !ready ? (
          <p className="muted" role="status">
            画像の一覧を読み込んでいます…
          </p>
        ) : (
          <>
            <ImageGrid
              items={slice.items}
              selectedId={selected}
              now={now}
              className={styles.pickGrid}
              empty={q.trim() !== "" ? "この条件に一致する画像はありません" : "まだ画像はありません。ファイルをドロップするか、「ファイルを選んでアップロード」で追加します"}
              onSelect={setSelected}
              onActivate={(aid) => use(assets?.find((a) => a.id === aid) ?? null)}
            />
            <Pager slice={slice} onPage={setPage} />
          </>
        )}
      </div>
      <div className={styles.pickerFoot}>
        <div className={styles.actions}>
          <span className={styles.why}>{chosen ? `選択中: ${chosen.name}` : "画像を 1 つ選んでください"}</span>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="button" className="btn btn-primary" disabled={!usable} onClick={() => use(chosen)}>
            この画像を使う
          </button>
        </div>
      </div>
    </dialog>
  );
}
