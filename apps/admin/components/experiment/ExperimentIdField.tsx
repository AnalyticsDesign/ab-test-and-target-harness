"use client";
import { useId } from "react";
import { EXPOSED_NOTE, InfoTip } from "./AnalyticsCard";

/**
 * エクスペリエンス ID の欄。新規作成と複製の画面で同じものを使う(B103)。
 * ID は dataLayer に出るので ⓘ に共通の注意を付ける(B77 Q25)。ⓘ はボタンなので label の外に置き、label は htmlFor で欄と結ぶ。
 * 作成の画面は FormData で読む(defaultValue)、複製の画面は状態で持つ(value)。どちらも onChange を渡せる(作成の画面はエラーを消すのに使う)。
 * error は送る前の検査(lib/slug-id.ts)の結果。補足とエラーは両方とも aria-describedby で欄に結ぶ
 */
export function ExperimentIdField({
  value,
  defaultValue,
  onChange,
  error,
  disabled,
  extraHint,
}: {
  value?: string;
  defaultValue?: string;
  onChange?: (v: string) => void;
  error?: string | null;
  disabled?: boolean;
  /** 画面ごとの補足(複製の画面の「変えなければ空いているものになります」など) */
  extraHint?: string;
}) {
  const idInput = useId();
  const hintId = useId();
  const errorId = useId();
  return (
    <div className="field">
      <span className="field-label row" style={{ gap: 6 }}>
        <label htmlFor={idInput}>エクスペリエンス ID(スラッグ)</label>
        <InfoTip label="エクスペリエンス ID の補足">{EXPOSED_NOTE}</InfoTip>
      </span>
      <input
        id={idInput}
        name="id"
        required
        pattern="[a-z0-9][a-z0-9_\-]{0,63}"
        placeholder="exp_hero_copy"
        value={value}
        defaultValue={defaultValue}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      />
      <span className="field-hint" id={hintId}>
        GA4 の experimentId としてそのまま送られます。割当ハッシュの入力でもあるため作成後は変更できません{extraHint ? `。${extraHint}` : ""}
      </span>
      {error ? (
        <span id={errorId} className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
