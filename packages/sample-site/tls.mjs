// E2E 用の自己署名の証明書(HTTPS のサーバー用)。テスト専用で本番とは無関係。
// 鍵と証明書は git 管理外の .tls/ に実行時に作る(リポジトリに秘密鍵に見えるファイルを置かない)。openssl コマンドを使う
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIR = join(fileURLToPath(new URL(".", import.meta.url)), ".tls");

/**
 * 鍵と証明書(PEM)を返す。無ければ作る。ブラウザ側は ignoreHTTPSErrors で受けるので、有効期間は長めでよい(SAN は念のため *.example.test を入れる)。
 * 同時に起動されても鍵と証明書が食い違わないよう、.tls/ の中の一時ディレクトリに組で作り、ディレクトリごと current/ へ rename する
 * (rename は原子的。先に置いた側が勝ち、負けた側は自分の分を捨てて current/ を読む)
 */
export function ensureTestCert(dir = DEFAULT_DIR) {
  const pair = join(dir, "current");
  if (!existsSync(join(pair, "key.pem")) || !existsSync(join(pair, "cert.pem"))) {
    mkdirSync(dir, { recursive: true });
    const tmp = mkdtempSync(join(dir, "tmp-"));
    try {
      execFileSync(
        "openssl",
        [
          "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
          "-subj", "/CN=example.test",
          "-addext", "subjectAltName=DNS:example.test,DNS:*.example.test,DNS:localhost",
          "-keyout", join(tmp, "key.pem"), "-out", join(tmp, "cert.pem"),
        ],
        { stdio: ["ignore", "ignore", "pipe"] }, // 失敗時は openssl の stderr が例外に載る
      );
      try {
        renameSync(tmp, pair);
      } catch (e) {
        // 並行して先に置かれた(空でない current/ がある)ときだけ受け入れる。それ以外は握りつぶさない
        if (!(e && (e.code === "ENOTEMPTY" || e.code === "EEXIST")) || !existsSync(join(pair, "cert.pem"))) throw e;
      }
    } catch (e) {
      if (e && e.code === "ENOENT" && String(e.syscall).startsWith("spawn")) throw new Error("E2E の HTTPS 用の証明書を作るには openssl コマンドが要ります(PATH に見つかりません)", { cause: e });
      throw e;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return { key: readFileSync(join(pair, "key.pem")), cert: readFileSync(join(pair, "cert.pem")) };
}
