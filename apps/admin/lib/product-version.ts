export type ProductVersionView =
  | { kind: "same"; version: string }
  | { kind: "diff"; admin: string; control: string }
  | { kind: "unknown"; admin: string };

/** 更新の途中の食い違いも、旧 control が版を返さない場合も区別して表示する。 */
export function productVersionView(admin: string, control: string | null): ProductVersionView {
  if (control === null) return { kind: "unknown", admin };
  if (admin === control) return { kind: "same", version: admin };
  return { kind: "diff", admin, control };
}
