"use client";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { CopyButton } from "@/components/ui/CopyButton";
import { MISSING_IMAGE_TEXT, assetForSrc, canOpenPicker, formatBytes, formatName } from "@/lib/images";
import type { SiteAsset } from "@/lib/types";
import { AssetThumb } from "./ImageTile";
import { useSiteAssets } from "./SiteAssetsProvider";
import styles from "./ImageLibrary.module.css";

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/**
 * パターンの IMAGE の変更の欄(B68。spec §9.3)。「縮小画像(96px)+ 名前 + 大きさ · 形式 +『別の画像にする』」の枠。
 * assets = SiteAssetsProvider が読んだ一覧(読み終わるまでは null で、公開 URL を等幅で出す)。一覧に無い src は、その旨と URL を出して選び直しを勧める。
 * 枠にファイルを 1 枚落とすと上げて、その画像にする。送るのは provider の層(uploadOne。run に乗せない)で、欄がタブ・パターンの切り替えで外れても、
 * 上がった画像は手元の一覧に入り、送っている間の離れる前の確認(「アップロードの途中です」)も残る。欄が外れた後に上がった画像は、欄には入れない。
 * 下書きを変えるのは onChange だけ(保存は帯。spec §11 の K1)。disabled(閲覧者・終了したエクスペリエンス)では窓を開かず、ドロップも受けない
 */
export function ImageField({ src, assets, onChange, disabled }: { src: string; assets: SiteAsset[] | null; onChange: (publicUrl: string) => void; disabled: boolean }) {
  const ctx = useSiteAssets();
  const [dragging, setDragging] = useState(false);
  const view = assetForSrc(assets, src);
  const openable = ctx !== null && canOpenPicker({ disabled, mode: ctx.mode });
  // 一覧の読みに失敗した(読み終わらない)。窓を開けば読み直し、窓の中にも「もう一度読み込む」がある
  const loadFailed = ctx?.snapshot.status === "error";

  // この欄から送った分の進み(覆わない)。sending = 送っている数(続けて落としても、全部が解けるまで「アップロード中」を出す)。
  // error = 最後に失敗した理由(次に落としたら消す)。欄が外れた後に解けた結果は、欄にも下書きにも入れない
  const [sending, setSending] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const mounted = useRef(true);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const choose = async () => {
    if (!ctx || !openable) return;
    const picked = await ctx.pick(src);
    if (picked) onChange(picked.publicUrl);
  };

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file || !ctx || !openable) return;
    setSending((n) => n + 1);
    setUploadError(null);
    const r = await ctx.uploadOne(file);
    if (!mounted.current) return;
    setSending((n) => Math.max(0, n - 1));
    // 続けて落としたときは、上がった順にその画像にする(最後に上がった 1 枚が残る)
    if (r.ok) onChangeRef.current(r.asset.publicUrl);
    else setUploadError(r.error);
  };

  return (
    <div className="field">
      <span className="field-label">画像</span>
      <div
        className={`${styles.field}${dragging ? ` ${styles.fieldDrop}` : ""}`}
        data-testid="image-field"
        onDragOver={(e) => {
          if (!hasFiles(e) || !openable) return;
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={onDrop}
      >
        {view.kind === "found" ? (
          <>
            <AssetThumb asset={view.asset} className={styles.fieldThumb} />
            <span className={styles.fieldInfo}>
              <span className={styles.fieldName} title={view.asset.name}>
                {view.asset.name}
              </span>
              <span className="muted">
                {formatBytes(view.asset.size)} · {formatName(view.asset.mime)}
              </span>
              {openable ? <span className="muted">ここに画像のファイルをドロップしても差し替えられます</span> : null}
            </span>
          </>
        ) : view.kind === "missing" ? (
          <span className={styles.fieldInfo}>
            <span className="field-error">{MISSING_IMAGE_TEXT}</span>
            <span className="muted">「画像を選ぶ」から、このサイトの画像を選び直してください</span>
          </span>
        ) : view.kind === "loading" && loadFailed ? (
          <span className={styles.fieldInfo}>
            <span className="field-error">画像の一覧を読めませんでした。「画像を選ぶ」から読み直せます</span>
          </span>
        ) : view.kind === "loading" ? (
          <span className={styles.fieldInfo}>
            <span className="muted">画像の一覧を読み込んでいます…</span>
          </span>
        ) : (
          <span className={styles.fieldInfo}>
            <span className="muted">画像が選ばれていません。ここにファイルをドロップするか、「画像を選ぶ」から選びます</span>
          </span>
        )}
        <button type="button" className="btn btn-sm" disabled={!openable} onClick={() => void choose()}>
          {view.kind === "found" || (view.kind === "loading" && !loadFailed) ? "別の画像にする" : "画像を選ぶ"}
        </button>
      </div>
      {src.trim() !== "" ? (
        <span className={styles.fieldUrl}>
          <code>{src}</code>
          <CopyButton text={src} label="画像の URL をコピー" className="btn btn-sm" iconOnly />
        </span>
      ) : null}
      {/* ドロップで上げた 1 枚の進み(覆わない。離れる前の確認は provider の層が載せる) */}
      {sending > 0 ? (
        <span className={styles.fieldStatus} role="status">
          <span className={styles.spinner} aria-hidden="true" />
          アップロード中
        </span>
      ) : null}
      {uploadError ? (
        <p role="alert" className="error-box">
          アップロードできませんでした: {uploadError}
        </p>
      ) : null}
    </div>
  );
}
