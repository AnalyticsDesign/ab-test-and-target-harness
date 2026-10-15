"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { CodeBlock } from "./CodeBlock";

/**
 * 発行の結果のカード(API キー = 決定 54 (11)、招待リンク・リセットリンク = backlog B47)。見出し + 説明 + 注意 + コピーできるコード + 閉じる。
 * 出したら見出しにフォーカスを移す(押した場所の近くに出るので気づきやすく、読み上げでも分かる)。
 * 移動の確認(useLeaveGuard)は持たない — 要るもの(二度と表示できない API キー)だけ呼ぶ側で付ける
 */
export function IssuedCard({
  title,
  titleId,
  testId,
  children,
  notice,
  code,
  copyLabel,
  closeLabel,
  onClose,
}: {
  title: string;
  /** 見出しの id。呼ぶ側が後からフォーカスを戻すときに使う(省略時は自動) */
  titleId?: string;
  testId: string;
  /** 見出しの下の説明(誰に・いつまで など) */
  children: ReactNode;
  /** 控え損ねないための注意。目立つ色で出す */
  notice: string;
  code: string;
  copyLabel: string;
  closeLabel: string;
  onClose: () => void;
}) {
  const autoId = useId();
  const headingId = titleId ?? autoId;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="card" aria-labelledby={headingId} data-testid={testId} style={{ borderColor: "var(--ok)", background: "var(--ok-soft)" }}>
      <h2 id={headingId} ref={heading} tabIndex={-1}>
        {title}
      </h2>
      {children}
      <p style={{ color: "var(--warn)", fontWeight: 500 }}>{notice}</p>
      <CodeBlock code={code} label={copyLabel} />
      <div style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {closeLabel}
        </button>
      </div>
    </section>
  );
}
