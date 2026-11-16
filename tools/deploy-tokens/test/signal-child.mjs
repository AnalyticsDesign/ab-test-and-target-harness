// run.test.mjs の sigint_releases_lock が子のプロセスで動かす入口。
// 本物の入口の io(シグナルの扱いを含む)を使い、fetch だけを差し替える。最初の要求で READY を標準エラーに出して止まり、
// 親のテストがシグナルを送るのを待つ(本物の Cloudflare にはつながない)。
import { main, processIo } from "../run.mjs";

const hang = () => {
  process.stderr.write("READY\n");
  // 待ちの間もプロセスが終わらないよう、タイマーを置く(親のテストが 10 秒で止める)
  return new Promise(() => { setTimeout(() => {}, 20000); });
};

main(process.argv.slice(2), process.env, { ...processIo(), fetch: hang }).then((code) => { process.exitCode = code; });
