/** runtime の診断で接頭辞をそろえ、メッセージに添える値は元の引数のまま渡す。 */
export function runtimeDebug(message: string, ...args: unknown[]): void {
  console.debug("wtt: " + message, ...args);
}
