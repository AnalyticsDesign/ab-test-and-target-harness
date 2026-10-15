"use client";
import { useState } from "react";
import { api, describeError } from "@/lib/client";

export function AssetUpload({ siteId, experimentId, onUploaded, disabled }: { siteId: string; experimentId: string; onUploaded: (url: string) => void; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  return (
    <div className="row">
      <label className="row">
        <span>画像をアップロード</span>
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
          disabled={busy || disabled}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setWarn(f.size > 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(1)}MB あります。1MB 超の画像は表示速度に影響します` : null); // spec §13.5: 1MB 超は UI で警告
            const fd = new FormData();
            fd.set("file", f);
            fd.set("experimentId", experimentId);
            setBusy(true);
            setError(null);
            try {
              const a = await api<{ publicUrl: string }>("POST", `/sites/${siteId}/assets`, fd);
              onUploaded(a.publicUrl);
            } catch (err) {
              setError(describeError(err));
            } finally {
              setBusy(false);
              e.target.value = "";
            }
          }}
        />
      </label>
      <span className="muted">選ぶとすぐアップロードされ、このパターンに画像の変更(IMAGE)が 1 つ足されます</span>
      {warn ? <span className="muted">{warn}</span> : null}
      {error ? <span className="error-box">{error}</span> : null}
    </div>
  );
}
