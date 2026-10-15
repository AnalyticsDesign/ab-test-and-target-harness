"use client";
import { useState } from "react";
import { checkRegex, sampleValue, testRegex } from "@/lib/regex-assist";
import styles from "./Targeting.module.css";

const RESULT = { match: "✓ 一致します", nomatch: "✗ 一致しません", skipped: "— 判定されません(256 字を超えるパス・URL として読めない値)", invalid: "(正規表現を直すと試せます)" } as const;

/**
 * 正規表現を選んだときの案内(決定 49、設計書 §10.4): (1) 入力しながら、問題の箇所に色を付けて「何がだめで、どう書き換えるか」を出す
 * (2) 1 行の案内と ⓘ 使える書き方 (3) 説明の中の試す欄。円記号・全角の置き換えの通知(4)と、ホストの大文字の案内もここに出す
 */
export function RegexAssist({ value, part, replaced, onApply }: { value: string; part: "path" | "host"; replaced: boolean; onApply: (v: string) => void }) {
  const [help, setHelp] = useState(false);
  const [sample, setSample] = useState(part === "host" ? "www.example.com" : "/products/123");
  const check = value ? checkRegex(value) : null;
  const name = part === "host" ? "ホスト" : "パス";
  const result = value ? testRegex(value, part, sample) : "invalid";
  const normalized = sampleValue(part, sample); // 本番と同じ形にした試す値(照合はこの値で行う)
  return (
    <div className={styles.assist}>
      {check ? (
        <div className={styles.error} role="alert">
          <code className={styles.src}>
            {value.slice(0, check.issue.index)}
            <mark>{value.slice(check.issue.index, check.issue.index + check.issue.length) || " "}</mark>
            {value.slice(check.issue.index + check.issue.length)}
          </code>
          <span>⚠ {check.issue.message}</span>
          {check.issue.example !== undefined ? (
            <span>
              書き換えの例: <code>{check.issue.example}</code>{" "}
              {check.fix !== null ? (
                <button type="button" className={`btn ${styles.smallButton}`} onClick={() => onApply(check.fix!)}>
                  この形にする
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
      {replaced ? <small role="status">¥ を \ に置き換えました</small> : null}
      {part === "host" && /[A-Z]/.test(value) ? <small role="status">ホストは小文字にして照合します。大文字の英字は一致しません(小文字で書いてください)</small> : null}
      <small className="muted">
        {name}用の簡単な正規表現です。部分一致です(全体に一致させるには ^ と $ を付けます)。
        <button type="button" className={styles.linkButton} aria-expanded={help} onClick={() => setHelp((h) => !h)}>
          ⓘ 使える書き方{help ? "を閉じる" : ""}
        </button>
      </small>
      {help ? (
        <div className={styles.help} role="note">
          <strong>使える書き方</strong>
          <table>
            <tbody>
              <tr><th>文字</th><td>ふつうの文字。記号は前に \ を付けます(\. \/ \- など)</td></tr>
              <tr><th>文字の集まり</th><td>.(任意の 1 文字)、[a-z0-9_-]、[^/](/ 以外)、\d(数字)、\w、\s</td></tr>
              <tr><th>位置</th><td>^(先頭)、$(末尾)</td></tr>
              <tr><th>まとまり</th><td>( )、(?: )、|(または)</td></tr>
              <tr><th>繰り返し</th><td>?(あってもなくても)、*、+、{"{n}"}、{"{n,m}"}</td></tr>
            </tbody>
          </table>
          <ul>
            <li>繰り返しは 1 文字・[ ]・( ) のどれにも付けられます。{"{n,m}"} の m は 100 まで</li>
            <li>大きさは 1 つの正規表現につき 200 命令まで、サイト全体で 500 命令まで({"{0,100}"} のような大きな繰り返しは命令が増えます)</li>
            <li>大文字と小文字は区別します</li>
            <li>¥ で入力しても \ として扱います(Mac の ¥ キーや全角の ￥ も自動で置き換えます)</li>
            <li>{part === "host" ? "ホストは小文字にしてから照合します" : "256 字を超えるパスでは、正規表現の条件は判定されません(配信条件なら配信の対象外、目標なら数えません)"}</li>
          </ul>
          <div className={styles.examples}>
            例: <code>^/products/\d+/?$</code>
            <code>^/(ja|en)/pricing</code>
            <code>^/blog/.*</code>
            <code>\.example\.com$</code>
          </div>
          <label className="row">
            <span className={styles.unit}>試す{name}</span>
            <input aria-label={`試す${name}`} value={sample} onChange={(e) => setSample(e.target.value)} />
            <span role="status" className={result === "match" ? styles.ok : result === "nomatch" ? styles.ng : undefined}>
              {RESULT[result]}
            </span>
          </label>
          <small className="muted" data-testid="regex-sample-value">
            {normalized === null ? (
              "URL として読めない値です"
            ) : (
              <>
                この値で照合します: <code>{normalized}</code>
              </>
            )}
            ({part === "host" ? "本番と同じく、ホストは小文字にし、末尾のドットを除き、日本語のドメインは xn-- の形にします" : "本番と同じく、パスの日本語や記号は %E6… の形(percent-encoding)にします"})
          </small>
          <small className="muted">詳しくは運用ガイドの「配信条件の正規表現」の節を見てください</small>
        </div>
      ) : null}
    </div>
  );
}
