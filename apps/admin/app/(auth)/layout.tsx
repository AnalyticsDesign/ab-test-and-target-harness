import type { ReactNode } from "react";

/** ログイン系(/login /setup /reset /invite)の枠。中身の各画面は変えない。E2E の appAlert が <main> を見るので <main> で包む */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: "100%", display: "flex", flexDirection: "column", alignItems: "center", padding: "56px 16px" }}>
      <p style={{ fontWeight: 600, fontSize: 15, margin: "0 0 24px" }}>AB Test and Target Harness</p>
      <main style={{ width: "100%", maxWidth: 480 }}>{children}</main>
    </div>
  );
}
