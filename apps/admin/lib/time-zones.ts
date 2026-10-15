/** Site 設定のタイムゾーンの選択肢(ブラウザが知っている IANA 名)。今の値が一覧に無くても落とさない(先頭に置く) */
export function timeZoneOptions(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return all.includes(current) ? all : [current, ...all];
}
