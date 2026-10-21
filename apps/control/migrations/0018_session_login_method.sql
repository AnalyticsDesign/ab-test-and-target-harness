-- B112: セッションを作った経路('password' = /sign-in/email・/sign-up/email、'google' = /callback/…、NULL = 分からない)を残す。
-- パスワード(非常口)で張ったセッションからの API キーの発行を断るため。
-- 足すだけの変更。control より前に流す(control を先に deploy すると、新しい control がセッションの INSERT にこの列を含め、ログインが失敗する)。
-- 既存の行は NULL のまま(発行の口は、NULL のときパスワードの記録の有無で判定する)
ALTER TABLE "session" ADD COLUMN "loginMethod" TEXT;
