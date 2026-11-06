"use client";
import { useState } from "react";
import { useConfirm } from "@/components/ConfirmProvider";
import { ErrorBox } from "@/components/ErrorBox";
import { LocalTime, useNow } from "@/components/LocalTime";
import { AppLink } from "@/components/ui/AppLink";
import { BusyNoticeText, useBusyNotice } from "@/components/ui/BusyNotice";
import { BusyScope, useBusyAction } from "@/components/ui/BusyScope";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { StatusPill } from "@/components/ui/StatusPill";
import { ApiClientError, api, describeError, fieldErrors } from "@/lib/client";
import { STATUS_JA, STATUS_TONE } from "@/lib/experiment-filter";
import { LARGE_IMAGE_BYTES, deleteBlockedReason, experimentOf, formatBytes, formatName, keptNotice, variantNameOf } from "@/lib/images";
import { DELETE_UNKNOWN, noticeOf } from "@/lib/busy-notice";
import type { AssetList, AssetUsage, SiteAsset, Status } from "@/lib/types";
import { AssetThumb } from "./ImageTile";
import styles from "./ImageLibrary.module.css";

type Props = {
  asset: SiteAsset;
  experiments: AssetList["experiments"];
  wid: string;
  siteId: string;
  canEdit: boolean;
  /**
   * 名前の変更の応答(1 件と usage)で手元を直す。書き込みが成功した時点で呼ぶ(詳細が外れた後でも呼ぶ。直すのは一覧を持つ親の state)
   */
  onRenamed: (asset: SiteAsset, usage: AssetUsage) => void;
  /** 削除待ちにした(一覧から外し、応答の usage で使用量を直す)。書き込みが成功した時点で呼ぶ(詳細が外れた後でも呼ぶ) */
  onDeleted: (id: string, usage: AssetUsage) => void;
  /** 押した後に使われ始めていた(409 asset_in_use)。応答の使い方と名前の表(experiments。形は受け取る側で確かめる)で手元を直す */
  onInUse: (asset: SiteAsset, experiments: unknown) => void;
};

/**
 * 右の詳細(案 A)。名前の保存と削除は詳細のカードを範囲にした BusyScope の run(after: "none")で行い、読み直さない(spec §11 の K2・K3)。
 * key は画像の ID にして、別の画像を開いたら入力と結果の 1 行を消す(呼び出し元)。
 * 一覧を直す onRenamed・onDeleted は、書き込みの中(応答が届いた時点)で呼ぶ。送っている間に格子で別の画像を選んで詳細が外れると、
 * run の結果は discarded になるが、一覧は親(ImageLibrary)の寿命で直る(I3。捨てるのは詳細の表示だけ)
 */
export function ImageDetail(props: Props) {
  return (
    // 貼り付く(sticky)のは格子の列の外側の aside。BusyScope は中身を div で包むので、カードの側に付けても貼り付かない
    <aside className={styles.detailCol} aria-label="画像の詳細">
      <BusyScope id="image-detail" className={`card ${styles.detail}`}>
        <DetailBody {...props} />
      </BusyScope>
    </aside>
  );
}

const STATUSES: readonly string[] = ["draft", "running", "paused", "archived"];

/** エクスペリエンスの状態の札。知らない値は札を出さない(生の値を画面に出さない) */
function ExperimentStatus({ status }: { status: string | undefined }) {
  if (!status || !STATUSES.includes(status)) return null;
  const s = status as Status;
  return <StatusPill tone={STATUS_TONE[s]}>{STATUS_JA[s]}</StatusPill>;
}

function DetailBody({ asset, experiments, wid, siteId, canEdit, onRenamed, onDeleted, onInUse }: Props) {
  const { run } = useBusyAction();
  const ask = useConfirm();
  const rename = useBusyNotice();
  const [name, setName] = useState(asset.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const blocked = deleteBlockedReason(asset);
  const now = useNow();
  const kept = keptNotice(asset, now);
  const base = `/w/${wid}/sites/${siteId}/experiments`;

  async function saveName() {
    rename.clear();
    setNameError(null);
    setDeleteError(null);
    const outcome = await run({
      after: "none",
      write: async (signal) => {
        const res = await api<SiteAsset & { usage: AssetUsage }>("PATCH", `/sites/${siteId}/assets/${asset.id}`, { name }, { signal });
        const { usage, ...renamed } = res;
        onRenamed(renamed, usage);
        return renamed;
      },
    });
    if (outcome.kind === "saved") {
      const renamed = outcome.value;
      setName(renamed.name);
      rename.show(outcome, "保存しました");
      return;
    }
    // 名前の重なり(409)と字数(422)は欄の下に出す。それ以外はボタンの近くの ErrorBox
    if (outcome.kind === "failed" && outcome.error instanceof ApiClientError && (outcome.error.code === "asset_name_taken" || outcome.error.status === 422)) {
      setNameError(fieldErrors(outcome.error).name ?? describeError(outcome.error));
      return;
    }
    rename.show(outcome, null);
  }

  async function remove() {
    rename.clear();
    setDeleteError(null);
    const outcome = await run({
      after: "none",
      confirm: () =>
        ask({
          title: `「${asset.name}」を削除しますか`,
          body: "削除待ちにします。24 時間の後に、どこでも使われていないことを確かめてから消します。サイトの HTML に直接貼った URL では表示されなくなります",
          confirmLabel: "削除する",
          tone: "danger",
        }),
      write: async (signal) => {
        const res = await api<{ status: "pending_deletion"; purgeAfter: number; usage: AssetUsage }>("DELETE", `/sites/${siteId}/assets/${asset.id}`, undefined, { signal });
        onDeleted(asset.id, res.usage);
        return res;
      },
    });
    if (outcome.kind === "saved") return;
    if (outcome.kind === "failed" && outcome.error instanceof ApiClientError && outcome.error.code === "asset_in_use") {
      // 押した後に使われ始めた: 応答の使い方で手元を直す。押せない理由の文がボタンの左に出る
      const { usedBy, deliveredIn, experiments: names } = outcome.error.extra;
      onInUse(
        {
          ...asset,
          usedBy: Array.isArray(usedBy) ? (usedBy as SiteAsset["usedBy"]) : asset.usedBy,
          deliveredIn: Array.isArray(deliveredIn) ? (deliveredIn as string[]) : asset.deliveredIn,
          inUse: true,
        },
        names,
      );
      return;
    }
    // それ以外の失敗(404 = ほかの人が先に削除した・5xx など)と、30 秒で結果が分からないときは、ボタンの近くの ErrorBox(決まり 5.2)
    if (outcome.kind === "unknown") {
      setDeleteError(DELETE_UNKNOWN);
      return;
    }
    const n = noticeOf(outcome, null);
    if (n?.error) setDeleteError(n.error);
  }

  return (
    <>
      <AssetThumb asset={asset} className={styles.detailThumb} />
      {canEdit ? (
        <>
          <label className="field">
            <span className="field-label">名前(管理用。公開される URL には入りません)</span>
            <input
              value={name}
              maxLength={100}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
                rename.clearStatus();
              }}
            />
            {nameError ? (
              <span role="alert" className="field-error">
                {nameError}
              </span>
            ) : null}
          </label>
          <div className={styles.actions}>
            <BusyNoticeText notice={rename.notice} />
            <button type="button" className="btn btn-sm btn-primary" disabled={name.trim() === "" || name === asset.name} onClick={() => void saveName()}>
              名前を保存
            </button>
          </div>
        </>
      ) : (
        <h2 className={styles.detailName} title={asset.name}>
          {asset.name}
        </h2>
      )}
      <dl className={styles.kv}>
        <dt>形式</dt>
        <dd>{formatName(asset.mime)}</dd>
        <dt>大きさ</dt>
        <dd>
          {formatBytes(asset.size)}
          {asset.size > LARGE_IMAGE_BYTES ? <StatusPill tone="warn">1MB 超(表示速度に影響します)</StatusPill> : null}
        </dd>
        <dt>幅 × 高さ</dt>
        <dd>{asset.width !== null && asset.height !== null ? `${asset.width} × ${asset.height}` : "-"}</dd>
        <dt>アップロード</dt>
        <dd>
          <LocalTime at={asset.createdAt} />
          {asset.createdBy.name ? `(${asset.createdBy.name})` : null}
        </dd>
      </dl>
      {kept ? (
        <p>
          <StatusPill tone="warn">{kept}</StatusPill>
        </p>
      ) : null}
      <CodeBlock code={asset.publicUrl} label="公開 URL をコピー" />
      <h3 className={styles.h3}>使っているパターン</h3>
      {asset.usedBy.length > 0 ? (
        <ul className={styles.uses}>
          {asset.usedBy.map((u) => {
            const exp = experimentOf(experiments, u.experimentId);
            return (
              <li key={`${u.experimentId}/${u.variantId}`}>
                <ExperimentStatus status={exp?.status} />
                <AppLink href={`${base}/${u.experimentId}?tab=variants&variant=${encodeURIComponent(u.variantId)}`}>
                  {exp?.name ?? u.experimentId} / {variantNameOf(exp, u.variantId) ?? u.variantId}
                </AppLink>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">どのパターンの変更でも使っていません</p>
      )}
      {asset.deliveredIn.length > 0 ? (
        <>
          <h3 className={styles.h3}>公開したときの内容で使用</h3>
          <ul className={styles.uses}>
            {asset.deliveredIn.map((eid) => (
              <li key={eid}>
                <ExperimentStatus status={experimentOf(experiments, eid)?.status} />
                <AppLink href={`${base}/${eid}`}>{experimentOf(experiments, eid)?.name ?? eid}</AppLink>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {canEdit ? (
        <>
          <ErrorBox message={deleteError} />
          <div className={styles.actions}>
            {blocked ? <span className={styles.why}>{blocked}</span> : null}
            <button type="button" className="btn btn-sm btn-danger" disabled={blocked !== null} onClick={() => void remove()}>
              削除する
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}
