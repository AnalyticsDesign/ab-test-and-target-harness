"use client";
import { useState } from "react";
import { api, describeError } from "@/lib/client";
import type { Site } from "@/lib/types";
import { ErrorBox } from "../ErrorBox";

export function DangerZone({ site, canDelete }: { site: Site; canDelete: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState("");
  if (!canDelete) return <p className="muted">サイトの削除はオーナーだけが行えます</p>;
  return (
    <section className="danger-zone">
      <h3>サイトを削除</h3>
      <p>D1 / KV / R2 の画像をすべて削除します。配信中のエクスペリエンスがあるときは削除できません(先に終了します)。取り消せません。</p>
      <label className="field">
        <span className="field-label">確認のためサイト ID を入力</span>
        <input value={confirmId} onChange={(e) => setConfirmId(e.target.value)} />
      </label>
      <ErrorBox message={error} />
      <button
        type="button"
        className="btn btn-danger"
        disabled={busy || confirmId !== site.id}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api("DELETE", `/sites/${site.id}`);
            // クライアント遷移(router.push + router.refresh)では共有 layout(サイドバーの Site 一覧)が確実には描き直されない(このバージョンの Next.js/vinext で実測)ため、全画面の遷移にする
            window.location.assign(`/w/${site.workspaceId}`);
          } catch (e) {
            setError(describeError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        サイトを削除
      </button>
    </section>
  );
}
