/** 設計書 4.6。label = サブメニューの短い名前、heading = 節の見出し(今の名前のまま)。inForm = 1 回の保存に含まれる節 */
export type SectionId = "general" | "tag" | "identity" | "naming" | "external" | "danger";

export const SECTIONS: Array<{ id: SectionId; label: string; heading: string; inForm: boolean }> = [
  { id: "general", label: "一般", heading: "一般", inForm: true },
  { id: "tag", label: "導入タグ", heading: "導入タグ", inForm: false },
  { id: "identity", label: "訪問者 ID", heading: "訪問者 ID", inForm: true },
  { id: "naming", label: "外部計測の名前", heading: "外部計測の名前(dataLayer の名札)", inForm: true },
  { id: "external", label: "外部 ID", heading: "分析(外部 ID)", inForm: true },
  { id: "danger", label: "危険な操作", heading: "危険な操作", inForm: false },
];

export const SECTION_IDS = SECTIONS.map((s) => s.id) as readonly SectionId[];

const IDENTITY = new Set(["mode", "hosts", "idSource", "byoidCookie", "visitorCookieName", "uuidCookieEnabled", "uuidCookieName"]);
const EXTERNAL = new Set(["ga4PropertyId", "bigqueryDataset"]);

/** 入力欄の name、または control の 422 の path(ドット区切り)から、その欄がある節を引く。不明は先頭の節 */
export function sectionOfField(name: string): SectionId {
  const head = name.split(".")[0]!;
  if (head === "analytics" || head === "exposure" || head === "conversion" || head === "extraKey" || head === "dataLayerName") return "naming";
  if (IDENTITY.has(head)) return "identity";
  if (EXTERNAL.has(head)) return "external";
  return "general";
}

/**
 * B31 ④: 欄を変えたときに消すエラーのキーを判定する関数。入力欄の name と、control の 422 の fields のキーは 1 対 1 ではないので、ここで対応を持つ:
 * - analytics の欄は、422 の種類によって `analytics.` が付く形と付かない形の両方で返る(SiteSettingsForm の analyticsError と同じ理由)
 * - 「参照する Cookie 名」(byoidCookie)は送るときに idSource にまとめるので、エラーは idSource で返る
 * - 配列の欄(allowedOrigins・hosts)は要素ごとに `name.0` の形で返ることがある
 * 節ごとではなく欄ごとに消す: 節ごとに消すと、同じ節に残っている別の欄のエラーまで消えるため
 */
export function fieldKeysFor(name: string): (key: string) => boolean {
  const exact = new Set([name]);
  if (name.startsWith("analytics.")) exact.add(name.slice("analytics.".length));
  if (name === "byoidCookie") exact.add("idSource");
  const indexed = `${name}.`;
  return (key) => exact.has(key) || key.startsWith(indexed);
}

/**
 * ブラウザの検証は不正な欄**すべて**に invalid を飛ばしてから、**最初の 1 つ**にフォーカスして吹き出しを出す。
 * 開く節はその最初の欄の節(invalid は DOM の順に飛ぶので、集めた名前の先頭)
 */
export function firstInvalidSection(names: string[]): SectionId {
  return names.length > 0 ? sectionOfField(names[0]!) : "general";
}
