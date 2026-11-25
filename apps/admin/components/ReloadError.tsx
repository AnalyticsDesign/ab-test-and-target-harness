"use client";

import { ErrorBox } from "@/components/ErrorBox";
import { PageMark } from "@/components/ui/PageMark";
import { reloadDocument } from "@/lib/navigate";

/** 画面全体を読み直す。保護領域では layout のセッション確認からやり直す。 */
export function ReloadError({ title, message }: { title: string; message: string }) {
  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <PageMark kind="error" />
      <h1>{title}</h1>
      <ErrorBox message={message} />
      <button type="button" className="btn btn-primary" onClick={reloadDocument}>
        再読み込みする
      </button>
    </div>
  );
}
