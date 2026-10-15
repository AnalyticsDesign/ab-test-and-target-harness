/** 非常用のパスワードログインが開いているあいだ、ログイン中の全員に出す(閉じ忘れの検知) */
export function BreakGlassBanner() {
  return (
    <div className="banner-warn banner-full" data-testid="break-glass-banner" role="status">
      {/* 文は 1 つの <span> にまとめる: .banner-warn は justify-content: space-between なので、
          兄弟に分けると文の途中が幅いっぱいに散らばってしまう */}
      <span>
        非常用のパスワードログインが開いています。用が済んだら control の非常用トークン(<code>AB_BREAK_GLASS_TOKEN</code>)を削除してください
      </span>
    </div>
  );
}
