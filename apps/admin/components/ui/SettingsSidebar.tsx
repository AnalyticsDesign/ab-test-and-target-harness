"use client";
import { Fragment, type MouseEvent } from "react";
import { AppLink } from "@/components/ui/AppLink";
import { usePathname } from "next/navigation";
import { backLabel, resolveOrigin, settingsGroups, switchSettingsHref, type SettingsItem, type SettingsPage } from "@/lib/nav";
import { isPlainLeftClick } from "@/lib/leave-guard";
import { setSettingsSection, useSectionErrors, useSettingsSection } from "@/lib/settings-section";
import { ContextSwitcher } from "./ContextSwitcher";
import { Icon } from "./Icon";
import { NavItem } from "./NavItem";
import { useSettingsOrigin } from "./SettingsOrigin";
import styles from "./Sidebar.module.css";

/**
 * 設定のメニュー(B60)。Sidebar は設定の画面(sidebarContext が settings)のときだけこれを描く。
 * hook(節の store・記憶)を Sidebar の中で条件付きで呼ばないため、別の部品にしている。
 * 描くのはメニューの上の部分だけで、外側の <nav>・最下部の「設定」・名前のメニューは Sidebar が描く。
 *
 * 上から: 戻るの行(設定を開く前の画面へ。右に戻り先の名前)/ 切り替えの枠(ホームから開いたときは出さない)/ 見出し「設定」/ 節。
 * 節の形は「設定を開いた場所」(provider の記憶。今の画面と合わなければ URL から決まる縮んだ形)で決まる。
 * instanceAdmin はシステムの節の管理の項目を出すかに使う(Sidebar が受け取ったセッションの値)
 */
export function SettingsSidebar({ page, instanceAdmin }: { page: SettingsPage; instanceAdmin: boolean }) {
  const pathname = usePathname();
  const { remembered, workspaces } = useSettingsOrigin();
  // サイト設定の画面で今開いている節(フォームが入れた値。フォームのいない画面・サーバーでの描画では一般)
  const currentSection = useSettingsSection("general");
  // 入力エラーのある節(フォームが書く。フォームのいない画面では空)
  const errorSections = useSectionErrors();
  const resolved = resolveOrigin(page, remembered);
  const { origin } = resolved;
  const groups = settingsGroups(origin, { workspaces, instanceAdmin });
  // 切り替えの枠はワークスペースから・サイトから開いたときだけ。summary にそのワークスペースが無い(読み込みに失敗した・権限が無い)ときは、
  // 空の枠を描かないよう出さない
  const switcherWs = origin.kind === "home" ? null : (workspaces.find((w) => w.id === origin.wid) ?? null);

  // サイト設定の項目。resolveOrigin は、サイト設定の画面ではそのサイトを origin にする(fitsPage)ので、
  // page がサイト設定なら、ここに並ぶ項目は今いるのと同じサイト設定の画面の節
  const siteItem = (item: SettingsItem & { section: NonNullable<SettingsItem["section"]> }) => {
    const samePage = page.kind === "site";
    const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
      // 同じ画面の節の切り替えは、ルーターを通さず store と URL(replaceState)だけを変える(再取得でフォームの状態とずれないため)。
      // 修飾キー付き・中ボタン(新しいタブで開く)と、既に誰かが処理したクリックはブラウザに任せる。
      // 未保存の入力があるときは、フォームの離脱の確認(document の capture)が先に受けて節を切り替えるので、ここまで届かない
      if (!samePage || !isPlainLeftClick(e)) return;
      e.preventDefault();
      setSettingsSection(item.section);
    };
    return (
      <NavItem
        key={item.key}
        href={item.href}
        icon={item.icon}
        label={item.label}
        current={samePage && item.section === currentSection}
        // 節は同じ画面の中の切り替えなので先読みしない
        prefetch={false}
        onClick={onClick}
        // 節の印(B60: 本文の中にあった節のメニューから移した)。testid は E2E が節を切り替えるのに使う
        testId={`section-${item.section}`}
        danger={item.section === "danger"}
        // 印は今開いている節には付けない(エクスペリエンスの編集画面のタブの印と同じ作法。開いている節ではエラーは欄の下に見えている)。
        // 同じサイト設定の画面にいるときだけ付ける(別の画面への遷移の途中に、前のフォームのエラーが残って見えないように)
        marked={samePage && errorSections.has(item.section) && item.section !== currentSection}
      />
    );
  };

  return (
    <>
      <AppLink href={resolved.backHref} className={styles.back}>
        <Icon name="left" size={14} />
        戻る
        {/* 名前は戻り先から決める(開いた場所と戻り先が違うことがある。例: ホームのカードからメンバーの画面へ入ったとき) */}
        <span className={styles.backTo}>{backLabel(resolved, workspaces)}</span>
      </AppLink>
      {/* 枠でサイトを選ぶと、サイト設定の画面なら同じ節のまま、ほかの画面ならそのサイトのサイト設定の一般へ(ユーザーの決定 5)。
          開いた場所は押したときに書かない: provider が画面の移動から更新する(離脱の確認で onClick が走らない経路でも働くため) */}
      {switcherWs ? (
        <ContextSwitcher
          workspaces={workspaces}
          wid={switcherWs.id}
          sid={origin.kind === "site" ? origin.sid : null}
          siteHref={(wid, sid) => switchSettingsHref(page, currentSection, { wid, sid })}
        />
      ) : null}
      <div className={styles.sideTitle}>設定</div>
      {groups.map((g) => (
        <Fragment key={g.scope}>
          <div className={styles.section}>
            <div>{g.heading}</div>
            {/* 対象の名前(サイト名・ワークスペース名)。メンバーがサイトではなくワークスペース全体のものだと読めるように */}
            {g.name ? <div className={styles.sectionName}>{g.name}</div> : null}
          </div>
          {g.items.map((item) =>
            item.section ? (
              siteItem({ ...item, section: item.section })
            ) : (
              <NavItem key={item.key} href={item.href} icon={item.icon} label={item.label} current={pathname === item.href} prefetch={item.prefetch} />
            ),
          )}
        </Fragment>
      ))}
    </>
  );
}
