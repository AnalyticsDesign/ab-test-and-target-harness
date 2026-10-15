import { Suspense, type ReactNode } from "react";

/** `useSearchParams` を使う画面は Suspense に包む(Next のビルド要件) */
export default function Layout({ children }: { children: ReactNode }) {
  return <Suspense>{children}</Suspense>;
}
