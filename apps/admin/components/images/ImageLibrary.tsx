"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNow } from "@/components/LocalTime";
import { api, describeError } from "@/lib/client";
import { BusyScope } from "@/components/ui/BusyScope";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import {
  PER_PAGES,
  SORT_KEYS,
  SORT_LABELS,
  USE_FILTERS,
  USE_LABELS,
  addAsset,
  applyUsage,
  expandAssetList,
  filterSortPage,
  formatCount,
  formatFileLimit,
  mergeExperiments,
  pendingSlice,
  removeAsset,
  replaceAsset,
  replayOps,
  usageSummary,
  writeListParams,
  type AssetListOp,
  type InitialAssets,
  type ListParams,
  type PerPage,
  type SortKey,
} from "@/lib/images";
import { useUploadQueue } from "@/lib/use-upload-queue";
import type { AssetList, AssetListResponse, AssetUsage, SiteAsset } from "@/lib/types";
import { DropOverlay } from "./DropOverlay";
import { ImageDetail } from "./ImageDetail";
import { ImageGrid } from "./ImageGrid";
import { Pager } from "./Pager";
import { UploadQueue } from "./UploadQueue";
import styles from "./ImageLibrary.module.css";

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/avif";

/**
 * サイトの画像の一覧(B68。spec §9.2。見た目の正はモック v3 の案 A)。
 * 一覧は画面を開いたときの 1 回の GET(page.tsx)で読み、描画では最初のページの分だけを受け取る(initialAssets。全件が少なければ全件)。
 * 全件でなければ、マウントの後に BFF で全件を 1 回読む(Q331。1,000 枚の全件を描画で渡すと admin の CPU が大きく増えたため)。
 * 読み終わるまでは、描画で渡したページの分と数を出し、引数を変えたら「読み込んでいます」を出す。読み終わるまでの手元の直し(名前の変更・
 * 削除・アップロード)は ops に積み、届いた全件に当て直す(GET が書き込みより前に始まっていても、直した分を失わない)。
 * その後は名前の変更・削除・アップロードの応答で手元を直す(読み直さない)。
 * ほかの人の操作は画面を開き直すまで反映されない(上限の正は control。超えたら 409 の usage で直す)。
 * アップロードは待ち行列が自分で 1 枚ずつ送り(BusyScope の run に乗せない)、動いている間は prompt="uploading" で離れる前に確認する
 */
export function ImageLibrary({ wid, siteId, initial, canEdit, initialParams }: { wid: string; siteId: string; initial: InitialAssets; canEdit: boolean; initialParams: ListParams }) {
  // 応答の各件に URL を戻すのはここ(描画の props は応答のまま渡し、ブラウザへの転送を小さく保つ)
  const [state, setStateRaw] = useState(() => expandAssetList(initial.list));
  const [complete, setComplete] = useState(initial.complete);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 全件を読み終わるまでに当てた直し(読み終わったら全件に当て直す)。読み終わった後は積まない
  const pendingOps = useRef<AssetListOp[] | null>(initial.complete ? null : []);
  const setState = useCallback((op: AssetListOp) => {
    pendingOps.current?.push(op);
    setStateRaw(op);
  }, []);
  const [params, setParamsState] = useState(initialParams);
  const now = useNow();
  // 待ち行列の上限の判定は、最新の usage(201・409 で置き換えた値)を読む
  const usageRef = useRef(state.usage);
  usageRef.current = state.usage;

  // URL への書き込みは更新の関数の外で行う(更新の関数は StrictMode で 2 回呼ばれうるので、副作用を置かない)
  const paramsRef = useRef(params);
  const setParams = useCallback((patch: Partial<ListParams>) => {
    const next = { ...paramsRef.current, ...patch };
    paramsRef.current = next;
    setParamsState(next);
    try {
      writeListParams(next);
    } catch {
      // Safari は短い間に replaceState を何度も呼ぶと例外を投げる。URL が遅れるだけなので画面は止めない
    }
  }, []);

  const queue = useUploadQueue({
    siteId,
    usage: () => usageRef.current,
    onUploaded: (a) => setState((s) => addAsset(s, a)),
    onUsage: (u) => {
      usageRef.current = u;
      setState((s) => applyUsage(s, u));
    },
  });

  // 全件をマウントの後に 1 回読む(BFF。StrictMode の effect の 2 回目では読まない)。失敗したら「もう一度読む」で読み直す
  const loading = useRef(false);
  const loadAll = useCallback(() => {
    if (loading.current || pendingOps.current === null) return;
    loading.current = true;
    setLoadError(null);
    api<AssetListResponse>("GET", `/sites/${siteId}/assets`)
      .then((res) => {
        const ops = pendingOps.current ?? [];
        pendingOps.current = null;
        setStateRaw(replayOps(expandAssetList(res), ops));
        setComplete(true);
      })
      .catch((e: unknown) => setLoadError(describeError(e)))
      .finally(() => {
        loading.current = false;
      });
  }, [siteId]);
  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const fileInput = useRef<HTMLInputElement>(null);
  const slice = complete ? filterSortPage(state.assets, params) : pendingSlice(state.assets, initial.slice, initialParams, params);
  const selected = params.image ? (state.assets.find((a) => a.id === params.image) ?? null) : null;
  const summary = usageSummary(state.usage);
  const filtered = params.q.trim() !== "" || params.use !== "all";

  const onSelect = (id: string) => setParams({ image: params.image === id ? null : id });
  const onRenamed = (a: SiteAsset, u: AssetUsage) => setState((s) => applyUsage(replaceAsset(s, a), u));
  // この画面が付いているか。削除の応答は書き込みの中で届くので、戻る・進むで別の画面に移った後にも届きうる
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // 詳細の書き込みの中から呼ばれる(送っている間に別の画像を選んでいても呼ばれる)。選択を外すのは、消した画像を開いたままのときだけ。
  // 画面が外れた後は URL を書かない(移った先の画面の URL を replaceState で書き換えないように)。手元の一覧の更新は外れていれば無害
  const onDeleted = (id: string, u: AssetUsage) => {
    setState((s) => applyUsage(removeAsset(s, id), u));
    if (mounted.current && paramsRef.current.image === id) setParams({ image: null });
  };
  // 409 asset_in_use の応答の使い方で直す(名前の変更の応答と違い、ここは使い方そのものを差し替える)
  const onInUse = (a: SiteAsset, names: unknown) => setState((s) => mergeExperiments({ ...s, assets: s.assets.map((x) => (x.id === a.id ? a : x)) }, names));

  return (
    <>
      <PageHeader
        title="画像"
        meta={
          <span className={`${styles.meter}${summary.warn ? ` ${styles.meterWarn}` : ""}`}>
            <span>{summary.text}</span>
            <span className={styles.bar} aria-hidden="true">
              <i style={{ width: `${(summary.ratio * 100).toFixed(1)}%` }} />
            </span>
          </span>
        }
        actions={
          canEdit ? (
            <>
              <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()}>
                <Icon name="upload" />
                画像をアップロード
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
                  if (files.length > 0) queue.enqueue(files);
                }}
              />
            </>
          ) : null
        }
      />
      {canEdit ? <p className={styles.dropzone}>画像のファイルを、この画面のどこにでもドラッグ&ドロップしてアップロードできます(PNG / JPEG / GIF / WebP / AVIF、1 枚 {formatFileLimit(state.usage.maxFileBytes)} まで)</p> : null}
      <DropOverlay enabled={canEdit} onFiles={queue.enqueue} />
      {/* 待ち行列は覆わない。動いている間だけ、離れる前の確認に「アップロードの途中です」を載せる */}
      <BusyScope id="image-uploads" prompt={queue.active ? "uploading" : undefined}>
        <UploadQueue rows={queue.rows} active={queue.active} onClose={queue.clear} />
      </BusyScope>
      <div className={styles.toolbar}>
        <input type="search" placeholder="名前で絞り込む" aria-label="名前で絞り込む" value={params.q} onChange={(e) => setParams({ q: e.target.value, page: 1 })} />
        <span className={styles.seg} role="group" aria-label="使っているか">
          {USE_FILTERS.map((u) => (
            <button key={u} type="button" aria-pressed={params.use === u} onClick={() => setParams({ use: u, page: 1 })}>
              {USE_LABELS[u]}
            </button>
          ))}
        </span>
        <select aria-label="並べる順" value={params.sort} onChange={(e) => setParams({ sort: e.target.value as SortKey, page: 1 })}>
          {SORT_KEYS.map((k) => (
            <option key={k} value={k}>
              {SORT_LABELS[k]}
            </option>
          ))}
        </select>
        <span className={styles.perGroup}>
          <span className="muted">一度に表示</span>
          <span className={styles.seg} role="group" aria-label="一度に表示">
            {PER_PAGES.map((p: PerPage) => (
              <button key={p} type="button" aria-pressed={params.per === p} onClick={() => setParams({ per: p, page: 1 })}>
                {p === "all" ? "すべて" : p}
              </button>
            ))}
          </span>
        </span>
        <span className="muted">{slice ? `${formatCount(slice.total)} 枚` : "…"}</span>
      </div>
      <div className={`${styles.lib}${selected ? "" : ` ${styles.libNoDetail}`}`}>
        <div>
          {loadError ? (
            <p className={styles.loadNote} role="alert">
              画像の一覧の残りを読み込めませんでした: {loadError}{" "}
              <button type="button" className="btn btn-sm" onClick={loadAll}>
                もう一度読み込む
              </button>
            </p>
          ) : !complete ? (
            <p className={styles.loadNote} role="status">
              画像の一覧の残りを読み込んでいます…
            </p>
          ) : null}
          {slice ? (
            <>
              <ImageGrid
                items={slice.items}
                selectedId={selected?.id ?? null}
                now={now}
                empty={filtered ? "この条件に一致する画像はありません" : canEdit ? "まだ画像はありません。右上の「画像をアップロード」か、ファイルのドラッグ&ドロップで追加します" : "まだ画像はありません"}
                onSelect={onSelect}
              />
              {/* 読み終わるまでは、ページ送りは描画で渡した数のまま押せる(押すと読み込み中の表示になり、読み終わったらそのページを出す) */}
              <Pager slice={slice} onPage={(page) => setParams({ page })} />
            </>
          ) : null}
        </div>
        {selected ? (
          <ImageDetail key={selected.id} asset={selected} experiments={state.experiments} wid={wid} siteId={siteId} canEdit={canEdit} onRenamed={onRenamed} onDeleted={onDeleted} onInUse={onInUse} />
        ) : null}
      </div>
    </>
  );
}
