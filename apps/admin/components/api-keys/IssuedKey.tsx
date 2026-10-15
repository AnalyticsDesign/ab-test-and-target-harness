"use client";
import { capLabel, scopeLabel } from "@/lib/api-keys";
import { ExpiryLabel } from "../LocalTime";
import { IssuedCard } from "../ui/IssuedCard";
import type { IssuedResult } from "./IssueKeyForm";

/**
 * 発行の結果(決定 54 (11))。発行カードと同じ場所に置き換えて出し、「保管したので閉じる」まで次の発行はできない。
 * 見出しの id は `issued-title` に固定する(ApiKeysPanel が「戻って控える」の後にフォーカスを戻す)
 */
export function IssuedKey({ issued, onClose }: { issued: IssuedResult; onClose: () => void }) {
  return (
    <IssuedCard
      title="API キーを発行しました"
      titleId="issued-title"
      testId="issued-key"
      notice="このキーは今だけ表示されます。閉じると二度と表示できません(ブラウザの「戻る」で移動しても消えます)。コピーして安全な場所に保管してください。"
      code={issued.key}
      copyLabel="キーをコピー"
      closeLabel="保管したので閉じる"
      onClose={onClose}
    >
      <p className="muted">
        名前: {issued.name} / 範囲: {scopeLabel(issued)} / 権限: {capLabel(issued.roleCap)} / 期限: <ExpiryLabel expiresAt={issued.expiresAt} />
      </p>
    </IssuedCard>
  );
}
