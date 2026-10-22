/**
 * 素のオブジェクトを自分のキーだけで引く(B135)。`constructor`・`toString`・`__proto__` など prototype にある名前で、
 * 継承したプロパティを返さない。runtime は es2020 向けに build するので Object.hasOwn(ES2022)は使わない。
 * `{}.hasOwnProperty` は `Object.prototype.hasOwnProperty` と同じもの(runtime の gzip を 7 B 減らすための短い書き方)
 */
export const own = <T>(o: Record<string, T>, k: string): T | undefined => ({}.hasOwnProperty.call(o, k) ? o[k] : undefined);
