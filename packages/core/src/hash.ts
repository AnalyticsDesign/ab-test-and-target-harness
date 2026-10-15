/** MurmurHash3 x86 32-bit。spec §7.2: seed は 0 固定。 */
export function murmur3_32(key: string, seed = 0): number {
  const data = new TextEncoder().encode(key);
  const len = data.length;
  const nblocks = len >>> 2;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h1 = seed >>> 0;
  for (let i = 0; i < nblocks; i++) {
    let k1 = view.getUint32(i * 4, true);
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
  }
  let k1 = 0;
  const tail = nblocks * 4;
  switch (len & 3) {
    case 3: k1 ^= data[tail + 2]! << 16; /* fallthrough */
    case 2: k1 ^= data[tail + 1]! << 8; /* fallthrough */
    case 1:
      k1 ^= data[tail]!;
      k1 = Math.imul(k1, c1);
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 = Math.imul(k1, c2);
      h1 ^= k1;
  }
  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

/** spec §7.2: bucket = murmur3_32(`${visitorId}:${experimentId}`) % 10000 */
export function bucketOf(visitorId: string, experimentId: string): number {
  return murmur3_32(`${visitorId}:${experimentId}`) % 10000;
}

/** spec §7.2: traffic は別ハッシュ列(`:traffic` サフィックス)で判定 */
export function inTraffic(visitorId: string, experimentId: string, trafficPercentage: number): boolean {
  if (trafficPercentage >= 100) return true;
  if (trafficPercentage <= 0) return false;
  return murmur3_32(`${visitorId}:${experimentId}:traffic`) % 100 < trafficPercentage;
}
