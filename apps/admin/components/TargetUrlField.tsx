"use client";
import type { ParamMatch } from "@wtt/core";
import { DEFAULT_PAGE_MATCH } from "@/lib/page-match";
import {
  describeUrlMatch,
  PARAM_OP_OPTIONS,
  paramsProblem,
  URL_PARAMS_MAX,
  URL_ROW_KIND_JA,
  URL_ROWS_MAX,
  withParamOp,
  type UrlMatchValue,
  type UrlRowKind,
  type UrlRowValue,
} from "@/lib/url-match";
import { PageMatchField } from "./PageMatchField";
import { Picker } from "./ui/Picker";
import styles from "./TargetUrlField.module.css";

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
function withParams(r: UrlRowValue, params: ParamMatch[]): UrlRowValue {
  return params.length ? { ...r, params } : { page: r.page };
}

/**
 * 対象 URL の入力(B69、spec §7.2)。「含める」と「除く」の 2 つの枠に行を縦に並べ、行の間は「または」。
 * 行 = ページの一致(PageMatchField)+ パラメータの条件(「かつ」)。含めるの最後の 1 行は消せず、上限(行 10・パラメータ 5)で追加のボタンを出さない。
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

/** 1 行(ページの一致 + 行を消すボタン + パラメータの条件の行 +「+ パラメータの条件(かつ)」) */
function UrlRow({ row, disabled, name, canDelete, onChange, onRemove }: { row: UrlRowValue; disabled: boolean; name: string | null; canDelete: boolean; onChange: (r: UrlRowValue) => void; onRemove: () => void }) {
  const params = row.params ?? [];
  const setParam = (i: number, p: ParamMatch) => onChange(withParams(row, params.map((x, j) => (j === i ? p : x))));
  const problem = paramsProblem(params);
  return (
    <div className={styles.row}>
      <div className={styles.line}>
        <PageMatchField name={name} value={row.page} disabled={disabled} onChange={(page) => onChange({ ...row, page })} />
        {disabled || !canDelete ? null : (
          <button type="button" className={styles.iconX} aria-label="この行を消す" title="この行を消す" onClick={onRemove}>
            ×
          </button>
        )}
      </div>
      {params.map((p, i) => (
        <div key={i} className={styles.param}>
          <span className={styles.and}>かつ</span>
          <span className="muted">パラメータ</span>
          <input className={styles.paramText} aria-label="パラメータの名前" placeholder="utm_source" value={p.name} disabled={disabled} onChange={(e) => setParam(i, { ...p, name: e.target.value })} />
          <Picker label="パラメータの一致の仕方" value={p.op} disabled={disabled} options={PARAM_OPS} onChange={(op) => setParam(i, withParamOp(p, op as ParamMatch["op"]))} />
          {p.op === "exists" ? null : (
            <input className={styles.paramText} aria-label="パラメータの値" value={p.value} disabled={disabled} onChange={(e) => setParam(i, { ...p, value: e.target.value })} />
          )}
          {disabled ? null : (
            <button type="button" className={styles.iconX} aria-label="このパラメータの条件を消す" title="このパラメータの条件を消す" onClick={() => onChange(withParams(row, params.filter((_, j) => j !== i)))}>
              ×
            </button>
          )}
        </div>
      ))}
      {problem ? <span className="field-error">{problem}</span> : null}
      {disabled || params.length >= URL_PARAMS_MAX ? null : (
        <div className={styles.param}>
          <button type="button" className={styles.link} onClick={() => onChange(withParams(row, [...params, { name: "", op: "equals", value: "" }]))}>
            + パラメータの条件(かつ)
          </button>
        </div>
      )}
    </div>
  );
}
