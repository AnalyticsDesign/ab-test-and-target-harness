"use client";
import { useMemo, useState } from "react";
import type { ParamMatch } from "@wtt/core";
import { DEFAULT_PAGE_MATCH, normalizeRegexValue, PAGE_OP_OPTIONS, partOf, type PageMatchValue, type PagePart } from "@/lib/page-match";
import {
  addCondition,
  canAddCondition,
  conditionKindOptions,
  describeUrlMatch,
  PARAM_OP_OPTIONS,
  removeCondition,
  removeFirstCondition,
  switchConditionKind,
  URL_ROW_KIND_JA,
  URL_ROWS_MAX,
  urlRowProblem,
  withParamOp,
  withRowParts,
  type ConditionKind,
  type ConditionList,
  type UrlMatchValue,
  type UrlRowKind,
  type UrlRowValue,
} from "@/lib/url-match";
import { PageMatchField } from "./PageMatchField";
import { RegexAssist } from "./targeting/RegexAssist";
import { Picker } from "./ui/Picker";
import styles from "./TargetUrlField.module.css";

const AND_PLACEHOLDER: Record<PagePart, string> = { path: "/sale/", host: "shop.example.com", url: "https://www.example.com/lp/" };

const KIND_HINT: Record<UrlRowKind, string> = {
  include: "いずれかに一致するページ(1 行以上、10 行まで)",
  exclude: "いずれかに一致するページは、含めるに一致しても動かしません(任意、10 行まで)",
};
const PARAM_OPS = PARAM_OP_OPTIONS.map((o) => ({ value: o.op, label: o.label }));

/** 送る形のまま持つ: 空の exclude・params は消す(保存される JSON の表示も保存の形と同じにするため) */
function withRows(m: UrlMatchValue, kind: UrlRowKind, rows: UrlRowValue[]): UrlMatchValue {
  if (kind === "include") return { ...m, include: rows };
  const { exclude: _drop, ...rest } = m;
  return rows.length ? { ...rest, exclude: rows } : rest;
}

/**
 * 対象 URL の入力(B69、spec §7.2)。「含める」と「除く」の 2 つの枠に行を縦に並べ、行の間は「または」。
 * 行 = 最初の条件(PageMatchField)+「かつ」の条件(ページの条件(and)→ パラメータ。追補 §7)。含めるの最後の 1 行は消せず、
 * 上限(行 10・and 5・パラメータ 5)で追加のボタンを出さない。
 * 枠の下に要約と、保存される JSON。disabled(閲覧者・保存中)では追加・削除のボタンを出さず、欄を押せなくする。
 * 値の欄の name は含めるの 1 行目だけ "value"(既存のフォームと E2E が使う)、ほかの行は付けない
 */
export function TargetUrlField({ value, onChange, disabled }: { value: UrlMatchValue; onChange: (v: UrlMatchValue) => void; disabled?: boolean }) {
  const d = disabled ?? false;
  const text = describeUrlMatch(value);
  const group = (kind: UrlRowKind) => {
    const rows = kind === "include" ? value.include : (value.exclude ?? []);
    const setRows = (next: UrlRowValue[]) => onChange(withRows(value, kind, next));
    const setRow = (i: number, r: UrlRowValue) => setRows(rows.map((x, j) => (j === i ? r : x)));
    // 含めるは 1 行以上(最後の 1 行は消せない)。除くは 0 行にできる
    const canDelete = kind === "exclude" || rows.length > 1;
    return (
      <div className={styles.group} role="group" aria-label={URL_ROW_KIND_JA[kind]}>
        <div className={styles.head}>
          <b className={kind === "include" ? styles.kindIn : styles.kindOut}>{URL_ROW_KIND_JA[kind]}</b>
          <span className="muted">{KIND_HINT[kind]}</span>
        </div>
        {rows.length === 0 ? <span className="muted">除くページはありません</span> : null}
        {rows.map((r, i) => (
          <div key={i} className={styles.rowWrap}>
            {i > 0 ? <div className={styles.joiner}>または</div> : null}
            <UrlRow row={r} disabled={d} name={kind === "include" && i === 0 ? "value" : null} canDelete={canDelete} onChange={(next) => setRow(i, next)} onRemove={() => setRows(rows.filter((_, j) => j !== i))} />
          </div>
        ))}
        {d || rows.length >= URL_ROWS_MAX[kind] ? null : (
          <div>
            <button type="button" className="btn btn-sm" onClick={() => setRows([...rows, { page: DEFAULT_PAGE_MATCH }])}>
              {`+ ${URL_ROW_KIND_JA[kind]}ページ`}
            </button>
          </div>
        )}
      </div>
    );
  };
  return (
    <div className={styles.box}>
      {group("include")}
      {group("exclude")}
      <div className={styles.summary}>
        <span className="muted">動かすページ: </span>
        {text.include.map((t, i) => (
          <span key={i}>
            {i > 0 ? " または " : null}
            <b>{t}</b>
          </span>
        ))}
        {text.exclude.length ? (
          <>
            <br />
            <span className="muted">ただし次は除く: </span>
            {text.exclude.map((t, i) => (
              <span key={i}>
                {i > 0 ? " または " : null}
                <b>{t}</b>
              </span>
            ))}
          </>
        ) : null}
      </div>
      <details className={styles.json}>
        <summary>保存される JSON(エージェント・API と同じ形)</summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </details>
    </div>
  );
}

/** 条件の × (どの条件も「その条件を消す」にそろえる。追補 §7) */
function RemoveX({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={styles.iconX} aria-label="この条件を消す" title="この条件を消す" onClick={onClick}>
      ×
    </button>
  );
}

/**
 * 1 行(B69 追補 §7、モックの案 D): 最初の条件(ページの一致)→「かつ」の条件の行(ページの条件(and)を入力の順 → パラメータを入力の順。並べ替えは無い)
 * →「+ 条件(かつ)」→ 行を消すボタン。各条件の行の先頭は「条件の種類」のプルダウン。最初の条件の × は and の先頭を繰り上げる(無ければ値を空にする)
 */
function UrlRow({ row, disabled, name, canDelete, onChange, onRemove }: { row: UrlRowValue; disabled: boolean; name: string | null; canDelete: boolean; onChange: (r: UrlRowValue) => void; onRemove: () => void }) {
  const and = row.and ?? [];
  const params = row.params ?? [];
  const setAnd = (i: number, c: PageMatchValue) => onChange(withRowParts(row, { and: and.map((x, j) => (j === i ? c : x)) }));
  const setParam = (i: number, p: ParamMatch) => onChange(withRowParts(row, { params: params.map((x, j) => (j === i ? p : x)) }));
  // 行の下の案内(正規表現の誤りは欄の下の RegexAssist が出す)。行の値が変わったときだけ計算する
  const problem = useMemo(() => urlRowProblem(row, { regex: false }), [row]);
  const kindPicker = (list: ConditionList, i: number, value: ConditionKind) => (
    <Picker label="条件の種類" value={value} disabled={disabled} options={conditionKindOptions(row, list)} onChange={(k) => onChange(switchConditionKind(row, list, i, k as ConditionKind))} />
  );
  return (
    <div className={styles.row}>
      <div className={styles.line}>
        <PageMatchField name={name} value={row.page} disabled={disabled} onChange={(page) => onChange({ ...row, page })} />
        {disabled ? null : <RemoveX onClick={() => onChange(removeFirstCondition(row))} />}
      </div>
      {and.map((c, i) => (
        <div key={`a${i}`} className={styles.param}>
          <span className={styles.and}>かつ</span>
          {kindPicker("and", i, partOf(c))}
          <AndCondition value={c} disabled={disabled} onChange={(next) => setAnd(i, next)} />
          {disabled ? null : <RemoveX onClick={() => onChange(removeCondition(row, "and", i))} />}
        </div>
      ))}
      {params.map((p, i) => (
        <div key={`p${i}`} className={styles.param}>
          <span className={styles.and}>かつ</span>
          {kindPicker("params", i, "param")}
          <input className={styles.paramText} aria-label="パラメータの名前" placeholder="utm_source" value={p.name} disabled={disabled} onChange={(e) => setParam(i, { ...p, name: e.target.value })} />
          <Picker label="パラメータの一致の仕方" value={p.op} disabled={disabled} options={PARAM_OPS} onChange={(op) => setParam(i, withParamOp(p, op as ParamMatch["op"]))} />
          {p.op === "exists" ? null : (
            <input className={styles.paramText} aria-label="パラメータの値" value={p.value} disabled={disabled} onChange={(e) => setParam(i, { ...p, value: e.target.value })} />
          )}
          {disabled ? null : <RemoveX onClick={() => onChange(removeCondition(row, "params", i))} />}
        </div>
      ))}
      {problem ? <span className="field-error">{problem}</span> : null}
      {disabled ? null : (
        <div className={styles.actions}>
          {canAddCondition(row) ? (
            <button type="button" className={styles.link} onClick={() => onChange(addCondition(row))}>
              + 条件(かつ)
            </button>
          ) : (
            <span />
          )}
          {canDelete ? (
            <button type="button" className={styles.link} aria-label="この行を消す" title="この行を消す" onClick={onRemove}>
              この行を消す
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * and の 1 つの条件([値] [一致の仕方])。種類はこの行の先頭の「条件の種類」で選ぶ。正規表現の値は最初の条件と同じく ¥・全角を置き換え、
 * 問題の箇所と書き換えの案内(RegexAssist)を出す
 */
function AndCondition({ value, disabled, onChange }: { value: PageMatchValue; disabled: boolean; onChange: (v: PageMatchValue) => void }) {
  const part = partOf(value);
  const [replaced, setReplaced] = useState(false);
  const update = (next: PageMatchValue) => {
    const r = normalizeRegexValue(next);
    setReplaced(r.replaced);
    onChange(r.value);
  };
  const known = PAGE_OP_OPTIONS[part].some((o) => o.op === value.op);
  const opOptions = [...PAGE_OP_OPTIONS[part].map((o) => ({ value: o.op, label: o.label })), ...(known ? [] : [{ value: value.op, label: `${value.op}(使えません)`, disabled: true }])];
  return (
    <>
      <span className="muted">が</span>
      <input className={styles.andText} aria-label="値" value={value.value} disabled={disabled} placeholder={AND_PLACEHOLDER[part]} onChange={(e) => update({ ...value, value: e.target.value })} />
      <Picker label="一致の仕方" value={value.op} disabled={disabled} options={opOptions} onChange={(op) => update({ ...value, op })} />
      {value.op === "regex" && part !== "url" ? (
        <div className={styles.assist}>
          <RegexAssist value={value.value} part={part} replaced={replaced} onApply={(v) => update({ ...value, value: v })} />
        </div>
      ) : null}
    </>
  );
}
