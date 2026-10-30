import type { Site } from "@/lib/types";
import { pickParam } from "@/lib/url-state";

/**
 * サイト設定の page.tsx(サーバー)と SharingCard(クライアント)の両方が使うので、"use client" の無いこのファイルに置く。
 * "use client" のファイルの関数をサーバーから呼ぶと、クライアント参照に置き換わって呼んだ時点で投げる(test/client-boundary.test.ts)
 */

/** 作成で衝突を避けるために変えたこと(作成の画面が遷移の URL の ?sharing= で渡す)。off = 共有をオフにした / renamed = 正本 Cookie 名を変えた */
export type SharingAdjusted = "off" | "renamed";

/**
 * URL の ?sharing= を、読み込んだサイトの今の値と突き合わせて知らせの種類にする。
 * 作成の応答の sharingAdjusted は、共有をオフにした(shareSubdomains = false)か、共有はオンのまま Cookie 名を変えたかのどちらか(B139 Q29)。
 * 手で付けた ?sharing= で事実と違う知らせを出さないよう、サイトの共有の値と合うときだけ出す
 */
export function sharingNoticeFor(raw: string | string[] | undefined, site: Pick<Site, "shareSubdomains">): SharingAdjusted | null {
  const param = pickParam(raw, ["off", "renamed", "none"] as const, "none");
  if (param === "off") return site.shareSubdomains ? null : "off";
  if (param === "renamed") return site.shareSubdomains ? "renamed" : null;
  return null;
}

/**
 * 保存の本文に足す shareSubdomains。画面の値(share)が保存済みの値(saved)と違うときだけ送る。
 * 送った保存は「利用者が選んだ値」として共有の自動の移行の対象から外れるため、ほかの設定の保存で、
 * 移行を待っているサイトの共有をオフのまま決めてしまわない。オン→オフ→オンと戻した場合も、保存済みと同じなので送らない(B139)
 */
export function sharingPatch(share: boolean, saved: boolean): { shareSubdomains?: boolean } {
  return share !== saved ? { shareSubdomains: share } : {};
}

/**
 * 422 sharing_conflict の欄のエラーに、直し方(hint)も添える。fieldErrors は message だけを欄に渡すが、
 * この衝突は「どう直すか」が要点で、hint がフォーム末尾のエラーの箱にしか出ないとチェックから離れる(B139 のモック突き合わせ)。
 * 他のエラーと、hint の無いときは何も変えない
 */
export function withSharingHint(fields: Record<string, string>, code: string, hint: unknown): Record<string, string> {
  const message = fields.shareSubdomains;
  if (code !== "sharing_conflict" || !message || typeof hint !== "string" || hint.length === 0) return fields;
  return { ...fields, shareSubdomains: `${message} ${hint}` };
}
