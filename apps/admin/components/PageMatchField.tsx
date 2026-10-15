"use client";
import { useState } from "react";
import { normalizeRegexValue, PAGE_OP_OPTIONS, PAGE_PART_LABELS, partOf, withPart, type PageMatchValue, type PagePart } from "@/lib/page-match";
import { Picker } from "./ui/Picker";
import { RegexAssist } from "./targeting/RegexAssist";

const PART_OPTIONS = (["path", "host", "url"] as const).map((p) => ({ value: p, label: PAGE_PART_LABELS[p] }));
const PLACEHOLDER: Record<PagePart, { text: string; regex: string }> = {
  path: { text: "/lp/", regex: "^/products/\\d+$" },
  host: { text: "www.example.com", regex: "^shop\\." },
  url: { text: "https://www.example.com/lp/", regex: "" },
};

/**
 * ページの一致の入力欄([パス / ホスト / URL][値][一致の仕方])。対象 URL・目標の PAGEVIEW・閲覧したページの条件で共通(決定 49、設計書 §12)。
 * 値の欄の name は既定で "value"(E2E と既存のフォームが使う。null なら name を付けない = 条件の行の中など、フォームの値として送らない場所)。保存できない組み合わせ(v0.9 から残った URL 全体の正規表現)も「(使えません)」で見せる。
 * 正規表現の値は、入力・一致の仕方・照合する部分のどれを変えたときも ¥・全角を置き換え、置き換えたら知らせる(設計書 §10.4 の 4)
 */
export function PageMatchField({ value, onChange, disabled, name = "value" }: { value: PageMatchValue; onChange: (v: PageMatchValue) => void; disabled?: boolean; name?: string | null }) {
  const part = partOf(value);
  const known = PAGE_OP_OPTIONS[part].some((o) => o.op === value.op);
  const [replaced, setReplaced] = useState(false);
  const update = (next: PageMatchValue) => {
    const r = normalizeRegexValue(next);
    setReplaced(r.replaced);
    onChange(r.value);
  };
  const opOptions = [...PAGE_OP_OPTIONS[part].map((o) => ({ value: o.op, label: o.label })), ...(known ? [] : [{ value: value.op, label: `${value.op}(使えません)`, disabled: true }])];
  return (
    <span className="row">
      <Picker label="照合する部分" value={part} disabled={disabled} options={PART_OPTIONS} onChange={(p) => update(withPart(value, p as PagePart))} />
      <input
        name={name ?? undefined}
        aria-label="値"
        required
        value={value.value}
        disabled={disabled}
        placeholder={value.op === "regex" ? PLACEHOLDER[part].regex : PLACEHOLDER[part].text}
        onChange={(e) => update({ ...value, part, value: e.target.value })}
      />
      <Picker label="一致の仕方" value={value.op} disabled={disabled} options={opOptions} onChange={(op) => update({ ...value, part, op })} />
      {value.op === "regex" && part !== "url" ? <RegexAssist value={value.value} part={part} replaced={replaced} onApply={(v) => update({ ...value, part, value: v })} /> : null}
    </span>
  );
}
