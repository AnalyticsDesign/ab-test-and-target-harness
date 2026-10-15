"use client";
import type { Change } from "@/lib/types";
import { insertIndent } from "@/lib/code-textarea";
import { changeTypeOptions } from "@/lib/capabilities";
import type { KeyboardEvent } from "react";
import { Picker } from "./ui/Picker";

const TYPES: Array<{ t: Change["type"]; label: string; code?: boolean }> = [
  { t: "TEXT", label: "TEXT(textContent を置換)" },
  { t: "IMAGE", label: "IMAGE(img の src をアップロードした画像に)" },
  { t: "HIDE", label: "HIDE(非表示)" },
  { t: "ATTRIBUTE", label: "ATTRIBUTE(許可された属性を置換)" },
  { t: "HTML", label: "HTML(コードの変更: HTML を挿入・置換)", code: true },
  { t: "CSS", label: "CSS(コードの変更: <style> を注入)", code: true },
  { t: "CUSTOM_JS", label: "CUSTOM_JS(コードの変更: function(element, ctx) を 1 回実行)", code: true },
];
export const isCodeChange = (t: string) => t === "HTML" || t === "CSS" || t === "CUSTOM_JS";
export const defaultPayload = (t: Change["type"]): Record<string, unknown> =>
  t === "TEXT"
    ? { text: "" }
    : t === "IMAGE"
      ? { src: "" }
      : t === "HIDE"
        ? {}
        : t === "ATTRIBUTE"
          ? { name: "href", value: "" }
          : t === "HTML"
            ? { html: "", position: "replace", runScripts: false }
            : t === "CSS"
              ? { css: "" }
              : { code: "" };

/** type ごとのフォーム。保存は親(ExperimentEditor)が `PUT …/changes` で Variant 単位に全置換する */
export function ChangeEditor({
  change,
  onChange,
  onRemove,
  disabled,
  pageUrl,
  imageUpload,
}: {
  change: Change;
  onChange: (c: Change) => void;
  onRemove: () => void;
  disabled?: boolean;
  pageUrl: string | null;
  imageUpload: boolean;
}) {
  const allowed = changeTypeOptions(imageUpload, change.type);
  const p = change.payload as Record<string, string | boolean>;
  const setP = (patch: Record<string, unknown>) => onChange({ ...change, payload: { ...change.payload, ...patch } });
  // Tab で 2 スペース(フォーカスは移さない)。Shift+Tab は標準のフォーカス移動のまま残す — キーボードで入力欄から出る手段(r1 CX-Medium-3)。
  // setP はレンダーごとに作り直されるのでメモ化しない(useCallback は依存が毎回変わり意味が無い)
  const onCodeKeyDown = (key: "html" | "css" | "code") => (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab" || e.shiftKey) return;
    e.preventDefault();
    const ta = e.currentTarget;
    const r = insertIndent(ta.value, ta.selectionStart, ta.selectionEnd);
    setP({ [key]: r.value });
    requestAnimationFrame(() => ta.setSelectionRange(r.cursor, r.cursor)); // 再レンダー後にカーソルを戻す
  };
  return (
    // data-testid: E2E(apps/admin/e2e)が Change の枠を一意に掴むための目印(id はランダムなので type で引く)
    <div className="card" data-testid={`change-${change.type}`}>
      <div className="row">
        <code>{change.id}</code>
        <Picker
          label="変更の種類"
          value={change.type}
          disabled={disabled}
          options={TYPES.filter((x) => allowed.includes(x.t)).map((x) => ({ value: x.t, label: x.label }))}
          onChange={(v) => {
            const t = v as Change["type"];
            onChange({ id: change.id, type: t, ...(t === "CSS" ? {} : { selector: change.selector ?? "" }), payload: defaultPayload(t) });
          }}
        />
        {isCodeChange(change.type) ? (
          <span
            className="badge badge-warn"
            title="任意のコードを訪問者のブラウザで実行します。本番化は管理者の公開を必ず経由します。CUSTOM_JS と HTML 内の <script> はページ読込ごとに 1 回だけ実行され、SPA の再描画では再実行されません"
          >
            コードの変更
          </span>
        ) : null}
        <button type="button" className="btn" style={{ marginLeft: "auto" }} disabled={disabled} onClick={onRemove}>
          削除
        </button>
      </div>
      {change.type !== "CSS" ? (
        <label className="field">
          <span className="field-label">セレクタ(500 字以内)</span>
          <span className="row">
            <input value={change.selector ?? ""} maxLength={500} disabled={disabled} style={{ flex: 1 }} onChange={(e) => onChange({ ...change, selector: e.target.value })} />
            {/* ピッカー本体は Plan 7。それまでは disabled + 注記(要件どおり) */}
            <a
              className="btn"
              aria-disabled="true"
              title="セレクタピッカーはステップ 7 で入ります。それまではブラウザの DevTools で「Copy selector」を使ってください"
              href={pageUrl ? `${pageUrl}#__ab_picker` : undefined}
              onClick={(e) => e.preventDefault()}
            >
              要素を選ぶ(準備中)
            </a>
          </span>
        </label>
      ) : null}
      {change.type === "TEXT" ? (
        <label className="field">
          <span className="field-label">テキスト</span>
          <textarea value={String(p.text ?? "")} disabled={disabled} onChange={(e) => setP({ text: e.target.value })} />
        </label>
      ) : null}
      {change.type === "IMAGE" ? (
        <label className="field">
          <span className="field-label">画像 URL(このサイトにアップロードした画像のみ)</span>
          <input value={String(p.src ?? "")} disabled={disabled} onChange={(e) => setP({ src: e.target.value })} />
        </label>
      ) : null}
      {change.type === "ATTRIBUTE" ? (
        <div className="row">
          <label className="field">
            <span className="field-label">属性名</span>
            <input value={String(p.name ?? "")} disabled={disabled} onChange={(e) => setP({ name: e.target.value })} list="attr-allow" />
          </label>
          <datalist id="attr-allow">
            {["href", "src", "alt", "title", "class", "id", "target", "rel", "placeholder", "value", "disabled", "hidden", "width", "height", "loading", "aria-label", "data-"].map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
          <label className="field" style={{ flex: 1 }}>
            <span className="field-label">値</span>
            <input value={String(p.value ?? "")} disabled={disabled} onChange={(e) => setP({ value: e.target.value })} />
          </label>
        </div>
      ) : null}
      {change.type === "HTML" ? (
        <>
          <label className="field">
            <span className="field-label">HTML</span>
            <textarea
              className="code"
              rows={10}
              spellCheck={false}
              value={String(p.html ?? "")}
              disabled={disabled}
              onChange={(e) => setP({ html: e.target.value })}
              onKeyDown={onCodeKeyDown("html")}
            />
          </label>
          <div className="row">
            <Picker
              label="挿入する位置"
              value={String(p.position ?? "replace")}
              disabled={disabled}
              options={["replace", "before", "after", "append"].map((v) => ({ value: v, label: v }))}
              onChange={(v) => setP({ position: v })}
            />
            <label>
              <input type="checkbox" checked={Boolean(p.runScripts)} disabled={disabled} onChange={(e) => setP({ runScripts: e.target.checked })} /> &lt;script&gt; を実行する(1 回のみ)
            </label>
          </div>
        </>
      ) : null}
      {change.type === "CSS" ? (
        <label className="field">
          <span className="field-label">CSS(変更ごとに &lt;style&gt; を &lt;head&gt; に注入。prehide の対象外)</span>
          <textarea
            className="code"
            rows={10}
            spellCheck={false}
            value={String(p.css ?? "")}
            disabled={disabled}
            onChange={(e) => setP({ css: e.target.value })}
            onKeyDown={onCodeKeyDown("css")}
          />
        </label>
      ) : null}
      {change.type === "CUSTOM_JS" ? (
        <label className="field">
          <span className="field-label">function(element, ctx) の本体。element = セレクタの最初の一致要素(this も同じ)、ctx = {"{ experimentId, variantId, changeId }"}。目標は window.AB.track(goalId)</span>
          <textarea
            className="code"
            rows={10}
            spellCheck={false}
            value={String(p.code ?? "")}
            disabled={disabled}
            onChange={(e) => setP({ code: e.target.value })}
            onKeyDown={onCodeKeyDown("code")}
          />
        </label>
      ) : null}
    </div>
  );
}
