import { controlFetch } from "@/lib/control";
import { loginView } from "@/lib/login-view";
import { oauthErrorMessage } from "@/lib/oauth-errors";
import { ErrorBox } from "@/components/ErrorBox";
import { PasswordLoginForm } from "./PasswordLoginForm";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const { error } = await searchParams;
  // 同じキーが複数回付いた URL では配列になる(先頭だけを見る)
  const message = oauthErrorMessage(Array.isArray(error) ? error[0] : error);
  // control が答えない・形が違うときは「Google のみ」に倒す(lib/login-view.ts)
  const view = loginView(await controlFetch<unknown>("/login-options"));
  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <h1>ログイン</h1>
      <ErrorBox message={message} />
      {view.google ? (
        <a className="btn btn-primary" href="/api/session/google">
          Google でログイン
        </a>
      ) : (
        <p className="error-box">Google ログインが設定されていません。control に OAuth クライアントを設定してください</p>
      )}
      <p className="muted">
        招待されたメールアドレスの Google アカウントでログインします。初回セットアップは <a href="/setup">/setup</a>
      </p>
      {view.passwordLogin ? <PasswordLoginForm /> : null}
    </div>
  );
}
