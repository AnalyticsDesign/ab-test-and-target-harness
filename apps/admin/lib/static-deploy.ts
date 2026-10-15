/** 「配信ファイルを作り直す」の結果の文言。skipped = 更新する仕組み(デプロイ専用の Worker)が設定されていない。この場合は自動の再試行も無い */
export function staticRedeployMessage(state: "deployed" | "pending" | "skipped"): string {
  if (state === "deployed") return "配信ファイルを作り直しました";
  if (state === "pending") return "まだ更新できていません。自動で再試行を続けます";
  return "配信ファイルを更新する仕組みが設定されていません(導入手順を確認してください)";
}
