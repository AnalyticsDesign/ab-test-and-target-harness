/** 名前を並べる上限。これを超えたら先頭だけ出して「ほか N サイト」にまとめる(長い一覧で文が読めなくなるのを避ける) */
const LISTED_MAX = 5;

/**
 * メンバーの画面に出す 1 文: 「ロール」がどこに効くかを、サイトの名前で具体的に言う。
 * ロールはワークスペース単位で、そのワークスペースの全サイトに効く(サイトごとには変えられない)。
 * 設定のメニューではサイト設定とメンバーが別々の場所になったので、メンバーの画面だけでも効く範囲が分かるようにする
 */
export function memberScopeText(siteNames: string[]): string {
  const n = siteNames.length;
  if (n === 0) return "このワークスペースにはまだサイトがありません。ロールは、これから作るサイトにも効きます。";
  if (n === 1) return `ロールはこのワークスペースのサイト(${siteNames[0]})に効きます。`;
  const listed = siteNames.slice(0, LISTED_MAX).join("・");
  const names = n > LISTED_MAX ? `${listed} ほか ${n - LISTED_MAX} サイト` : listed;
  return `ロールはこのワークスペースの ${n} サイト(${names})すべてに効きます。`;
}
