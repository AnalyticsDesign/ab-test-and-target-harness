/**
 * control の API 契約の版(backlog D13 / 決定 56 (1)。検討記録 docs/dev/multiuser_consistency_study_v1.md 4.1。Plan 12 K2 / 決定 63 (3))。
 * admin の BFF は control へのすべての要求に CLIENT_VERSION_HEADER で、control は全応答に API_VERSION_HEADER で名乗る。
 * 判定の規則: control は書き込みで、名乗った版が MIN_CLIENT_VERSION より小さい(形に合わない名乗りは 0 と数える)なら
 * 426 client_too_old で断る。名乗りなし(ヘッダー無し)は断らない(admin の BFF 以外の呼び出し元を巻き込まないため)。
 * 読み取りは断らない。
 * 上げる規則: 後方互換な変更(応答へのフィールド追加・任意フィールド・新しいエンドポイント)では上げない。
 * 必須フィールドの追加・削除・改名・既存フィールドの意味や既定値の変更・エンドポイントの削除で +1 する。
 * API_CONTRACT_VERSION を上げるとき、MIN_CLIENT_VERSION は既定で同じ値に上げる(古い admin の書き込みを断つ)。
 * 古い admin に猶予を残すため据え置くなら、理由を MIN_CLIENT_VERSION_KEPT_BECAUSE に書く
 * (空のままなら core のテストが落ちる)。
 * zod を import しない(admin のどこから import しても軽く保つ)
 */
// 2(2026-10-28、backlog B156): API キーで読んだ招待の一覧(GET /workspaces/:wid/invitations)の id・url が null になりうる(型の変更)
// 3(2026-11-02、backlog B148): サイトの作成・保存の書き込みの欄を domains に変えた(domain・allowedOrigins・hosts は 422)。応答の hosts を edgeDomains に改名
export const API_CONTRACT_VERSION = 3;
export const API_VERSION_HEADER = "x-wtt-api-version";
export const CLIENT_VERSION_HEADER = "x-wtt-client-version";

/** 書き込みを受ける admin の最小の版。これより小さい名乗りは 426 client_too_old */
// 3(B148): 古い管理画面は domain・allowedOrigins・hosts を送るので、書き込みは 422 になる。426 で読み込み直しを促す
export const MIN_CLIENT_VERSION = 3;
/** MIN を API_CONTRACT_VERSION より低く据え置くときだけ、その理由を書く(猶予を残す根拠。決定 63 (3))。同じ版なら空 */
export const MIN_CLIENT_VERSION_KEPT_BECAUSE = "";
/** control が全応答に付ける「いまの最小の版」のヘッダー(admin が自分の古さを知るため) */
export const MIN_CLIENT_VERSION_HEADER = "x-wtt-min-client-version";
/** admin の BFF が control に、ブラウザの接続元 IP を渡すヘッダー */
export const CLIENT_IP_HEADER = "x-wtt-client-ip";

// 名乗りの形: 先頭が 0 でない 1〜6 桁の十進数だけ(符号・小数・空白・先頭ゼロは不正)
const CLIENT_VERSION_PATTERN = /^[1-9][0-9]{0,5}$/;

/**
 * 名乗りの値を版の数に読む。ヘッダーが無い(null)なら null(名乗りなし)、
 * あっても形に合わなければ 0(読めない名乗りは最も古い扱い)
 */
export function parseClientVersion(raw: string | null): number | null {
  if (raw === null) return null;
  return CLIENT_VERSION_PATTERN.test(raw) ? Number(raw) : 0;
}

/**
 * 自分(BFF)の版と、ブラウザが名乗った版の小さいほう。
 * ブラウザの名乗りが無い・読めない場合は 0(どちらも「古い」側に倒す)
 */
export function lowerClientVersion(own: number, browser: string | null): number {
  return Math.min(own, parseClientVersion(browser) ?? 0);
}
