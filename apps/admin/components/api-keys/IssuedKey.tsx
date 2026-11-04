"use client";
import { useEffect, useRef } from "react";
import { capLabel, scopeLabel } from "@/lib/api-keys";
import { isLogoutSubmit } from "@/lib/leave-guard";
import { ExpiryLabel } from "../LocalTime";
import { IssuedCard } from "../ui/IssuedCard";
import { useBusyAction } from "../ui/BusyScope";
import type { IssuedResult } from "./IssueKeyForm";

const TITLE_ID = "issued-title";

/** 離れる操作の元(押したリンク・ログアウトのボタン)か。離れる前の確認が閉じた後、ブラウザはここへフォーカスを戻す */
function isLeaveSource(el: Element): boolean {
  if (el.closest("a[href]")) return true;
  const form = el.closest("form");
  return form !== null && isLogoutSubmit(form.getAttribute("action"));
}

const focusTitle = () => document.getElementById(TITLE_ID)?.focus();

/**
 * 発行の結果(決定 54 (11))。発行カードと同じ場所に置き換えて出し、「保管したので閉じる」まで次の発行はできない。
 * 控えずに離れる前の確認は PageLeaveGuard が出す(ApiKeysPanel の範囲の prompt="issuedKey"。B173 第 2 段)。ここはフォーカスだけを持つ:
 * - 発行の覆い(親の BusyScope)の下で出るので、IssuedCard の出した時のフォーカスは inert で効かない。覆いが外れた後に見出しへ移す
 * - 「戻って控える」の後、確認が閉じてフォーカスが範囲の外(押したリンク・ログアウト)に戻っていたら見出しへ移す。
 *   <dialog> の close は泡立たないが capture では受けられ、ブラウザがフォーカスを戻した後に届く。
 *   ほかの確認(一覧の失効など)を取りやめたときは、押したボタンにフォーカスを残す(リンク・ログアウトだけを見る)
 */
export function IssuedKey({ issued, onClose }: { issued: IssuedResult; onClose: () => void }) {
  const { busy } = useBusyAction();
  const root = useRef<HTMLDivElement>(null);

  // 覆いと busy は同じ描画で外れる(BusyScope の finally)ので、busy が false になった後の effect では inert も外れている。
  // 覆いの間に利用者が別の所へフォーカスを動かしていた(body 以外にあり、まだ画面にある)ときは奪わない(BusyScope と同じ)
  useEffect(() => {
    if (busy) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) focusTitle();
  }, [busy]);

  useEffect(() => {
    const onDialogClose = (e: Event) => {
      if (!(e.target instanceof HTMLDialogElement)) return;
      const active = document.activeElement;
      if (!active || root.current?.contains(active) || !isLeaveSource(active)) return;
      focusTitle();
    };
    document.addEventListener("close", onDialogClose, true);
    return () => document.removeEventListener("close", onDialogClose, true);
  }, []);

  return (
    <div ref={root}>
      <IssuedCard
        title="API キーを発行しました"
        titleId={TITLE_ID}
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
    </div>
  );
}
