export type ReviewMark = "code" | "external_url";

/** セレクタから要素は確定できないので、コードに当たりうる場合は確認を促す。 */
export function reviewMarkOf(change: { type: string; selector?: string | null; payload: unknown }): ReviewMark | null {
  if (change.type === "IMAGE") return null;
  if (["HTML", "CSS", "CUSTOM_JS"].includes(change.type)) return "code";
  if (change.type !== "TEXT" && change.type !== "ATTRIBUTE") return null;
  if (/(style|link|iframe|base|script|embed)/i.test(change.selector ?? "")) return "code";
  if (change.type !== "ATTRIBUTE" || !change.payload || typeof change.payload !== "object") return null;
  const { name, value } = change.payload as { name?: unknown; value?: unknown };
  if (typeof name !== "string") return null;
  if (name.toLowerCase() === "rel") return "code";
  if (!["href", "src"].includes(name.toLowerCase()) || typeof value !== "string") return null;
  const url = value.replace(/[\u0000-\u0020\u007f]/g, "").replace(/\\/g, "/");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) return "external_url";
  try { return new URL(url, "https://base.invalid/").origin !== "https://base.invalid" ? "external_url" : null; }
  catch { return "external_url"; }
}
