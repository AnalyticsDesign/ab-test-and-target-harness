import { controlFetch } from "@/lib/control";
import { loginView } from "@/lib/login-view";
import { oauthErrorMessage } from "@/lib/oauth-errors";
import { ReloadError } from "@/components/ReloadError";
import { ErrorBox } from "@/components/ErrorBox";
import { PasswordLoginForm } from "./PasswordLoginForm";
import { PageMark } from "@/components/ui/PageMark";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const search = await searchParams;
  const { error } = search;
  // 同じキーが複数回付いた URL では配列になる(先頭だけを見る)
  const message = oauthErrorMessage(Array.isArray(error) ? error[0] : error);
  const options = await controlFetch<unknown>("/login-options").catch(() => null);
  if (options?.status === 401) {
    return (
      <div className="card" style={{ maxWidth: 420 }}>
        <PageMark path="/login" search={search} kind="error" />
        <h1>ログイン</h1>
        <ErrorBox message="ログイン方法の取得が拒否されました。管理者に確認してください。" />
      </div>
    );
  }
  const view = loginView(options);
  if (!view) {
    return <ReloadError title="ログイン" message="ログイン方法を確認できませんでした。しばらく待ってから再読み込みしてください。" />;
  }
  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <PageMark path={`/login`} search={search} />
      <h1>ログイン</h1>
      <ErrorBox message={message} />
      {view.google ? (
        <a className="btn btn-primary" href="/api/session/google">
          Google でログイン
        </a>
      ) : (
        <ErrorBox message="Google ログインが設定されていません。control に OAuth クライアントを設定してください" />
      )}
      <p className="muted">
        招待されたメールアドレスの Google アカウントでログインします。初回セットアップは <a href="/setup">/setup</a>
      </p>
      {view.passwordLogin ? <PasswordLoginForm /> : null}
    </div>
  );
}
