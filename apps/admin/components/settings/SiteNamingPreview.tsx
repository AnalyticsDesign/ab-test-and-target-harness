import { useEffect, useRef, useState } from "react";
import { siteDataLayerPreview } from "@/lib/datalayer-preview";
import type { AnalyticsSettings } from "@/lib/types";
import { AnalyticsSection } from "../experiment/AnalyticsCard";
import { DataLayerPreview } from "../experiment/DataLayerPreview";
import { readAnalytics } from "./analytics-fields";
import styles from "./AnalyticsNaming.module.css";

export function SiteNamingPreview({ saved, readOnly, active, busy }: {
  saved: AnalyticsSettings;
  readOnly: boolean;
  active: boolean;
  busy: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(saved);

  useEffect(() => {
    if (!active || readOnly || busy) return;
    const form = container.current?.closest("form");
    const nameField = form?.querySelector<HTMLInputElement>('input[name="analytics.dataLayerName"]');
    if (!form || !nameField) return;

    const read = () => {
      // 保存中の無効な欄は FormData に含まれないので、直前の入力を保つ。
      if (!nameField.disabled) setDraft(readAnalytics(new FormData(form)));
    };
    const onInput = (event: Event) => {
      if (event.target instanceof HTMLInputElement && event.target.name.startsWith("analytics.")) read();
    };
    // 節を開き直した後や保存後も、欄に残っている最新の入力を読む。
    read();
    form.addEventListener("input", onInput);
    return () => form.removeEventListener("input", onInput);
  }, [active, readOnly, busy, saved]);

  // 節を離れても、保存中に戻ったときに備えて最後に読んだ値を保つ。
  if (!active) return null;
  const names = readOnly ? saved : draft;
  return (
    <div ref={container} className={styles.preview}>
      <AnalyticsSection
        output
        title="出力される内容"
        tipLabel="出力される内容の補足"
        tip="タグが dataLayer に送る内容です。キー名はこの画面の入力の値で、保存前でも変わります。ID と名前はエクスペリエンス・目標ごとに入ります"
      >
        {siteDataLayerPreview(names).map(({ id, title, pushes }) => (
          <div key={id} className={styles.example}>
            <h4>{title}{id === "rateLimited" ? <span className="muted">名前は固定</span> : null}</h4>
            {pushes.map((lines, index) => (
              <DataLayerPreview key={index} lines={lines} extraKey={names.extraKey} dataLayerName={names.dataLayerName} />
            ))}
          </div>
        ))}
      </AnalyticsSection>
    </div>
  );
}
