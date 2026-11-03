import type { Site } from "@/lib/types";
import { CodeBlock } from "../ui/CodeBlock";
import { SectionLink } from "./SectionLink";
import { SECTIONS } from "./sections";

/** 節の見出し(B31 ⑥)。文字の正は sections.ts の SECTIONS */
const HEADING = SECTIONS.find((s) => s.id === "tag")!.heading;

/** フォームの外。タグの内容は今まで Site のナビに出していたものと同じ(設置タグのホストは導入ごとに違うので、不明なときは置き換えてもらう) */
export function InstallTag({ site, tagOrigin, canAdmin }: { site: Site; tagOrigin: string | null; canAdmin: boolean }) {
  // 値を変えられるのは管理者以上。それ未満は変えられない形で並べず、文言を「見る」にする
  const verb = canAdmin ? "変える" : "見る";
  const host = tagOrigin ?? "https://<設置タグのホスト>";
  return (
    <section className="card">
      <h2>{HEADING}</h2>
      <p className="muted">サイトの全ページの &lt;head&gt; 内、viewport の meta（&lt;meta name="viewport" …&gt;）の直後に置きます。画面の幅の条件は、タグが meta より後にあるときだけ正しい幅を読めます。{tagOrigin ? null : <>&lt;設置タグのホスト&gt; は設置タグを配っているホストに置き換えてください。</>}</p>
      <CodeBlock code={`<script src="${host}/s/${site.id}.js"></script>`} label="導入タグをコピー" />
      <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", margin: "16px 0 0" }}>
        <dt className="muted">サイト ID</dt>
        <dd style={{ margin: 0 }} className="mono">{site.id}</dd>
        <dt className="muted">モード</dt>
        <dd style={{ margin: 0 }}>
          {site.mode === "B" ? "B" : site.idSource === "ab" ? "A" : "C"}{" "}
          {/* モードは「ドメイン」の節の「導入の形」と、「訪問者 ID」の節の「訪問者 ID の取得元」で決まる */}
          <SectionLink to="identity">訪問者 ID で{verb}</SectionLink>
          <span className="muted">(導入の形は <SectionLink to="domains">ドメイン</SectionLink> の節)</span>
        </dd>
        <dt className="muted">ドメイン</dt>
        <dd style={{ margin: 0 }}>
          {site.domain} <SectionLink to="domains">ドメインで{verb}</SectionLink>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            複数のドメインのページに置くときは、ドメインの節の「タグを置くドメイン」に足します。
            {site.mode === "B" ? "Mode B では、足したドメインに Route を置いてから保存すると、Cloudflare 経由かを確かめます(手順はドメインの節)。" : null}
          </p>
        </dd>
      </dl>
    </section>
  );
}
