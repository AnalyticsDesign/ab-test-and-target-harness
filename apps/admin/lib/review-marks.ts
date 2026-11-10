export const REVIEW_MARK_LABEL: Record<"code" | "external_url", string> = {
  code: "コードを含む",
  external_url: "外部の URL を含む",
};
export const REVIEW_MARK_TITLE: Record<keyof typeof REVIEW_MARK_LABEL, string> = {
  code: "コードを含む可能性のある変更です。配信前に内容と表示を確認してください",
  external_url: "外部の URL を参照する変更です。参照先と表示を確認してから公開してください",
};
