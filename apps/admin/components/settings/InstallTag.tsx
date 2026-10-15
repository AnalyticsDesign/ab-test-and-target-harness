import type { Site } from "@/lib/types";
import { CodeBlock } from "../ui/CodeBlock";

/** フォームの外。タグの内容は今まで Site のナビに出していたものと同じ(設置タグのホストは導入ごとに違うので、不明なときは置き換えてもらう) */
export function InstallTag({ site, tagOrigin }: { site: Site; tagOrigin: string | null }) {
  const host = tagOrigin ?? "https://<設置タグのホスト>";
  return (
    <section className="card">
      <h2>導入タグ</h2>
      <p className="muted">サイトの全ページの &lt;head&gt; 内、viewport の meta（&lt;meta name="viewport" …&gt;）の直後に置きます。画面の幅の条件は、タグが meta より後にあるときだけ正しい幅を読めます。{tagOrigin ? null : <>&lt;設置タグのホスト&gt; は設置タグを配っているホストに置き換えてください。</>}</p>
      <CodeBlock code={`<script src="${host}/s/${site.id}.js"></script>`} label="導入タグをコピー" />
      <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", margin: "16px 0 0" }}>
        <dt className="muted">サイト ID</dt>
        <dd style={{ margin: 0 }} className="mono">{site.id}</dd>
        <dt className="muted">モード</dt>
        <dd style={{ margin: 0 }}>{site.mode === "B" ? "D-lite" : site.idSource === "ab" ? "A" : "C"}</dd>
        <dt className="muted">ドメイン</dt>
        <dd style={{ margin: 0 }}>{site.domain}</dd>
      </dl>
    </section>
  );
}
