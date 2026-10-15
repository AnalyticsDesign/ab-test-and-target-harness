/**
 * control の API 契約の版(backlog D13 / 決定 56 (1)。検討記録 docs/dev/multiuser_consistency_study_v1.md 4.1)。
 * admin の BFF は control へのすべての要求に CLIENT_VERSION_HEADER で、control は全応答に API_VERSION_HEADER で名乗る。
 * v1.0 は名乗るだけで判定はしない(互換の判定と 426 client_too_old は、必要になった版で新しい control に足す)。
 * 上げる規則: 後方互換な変更(応答へのフィールド追加・任意フィールド・新しいエンドポイント)では上げない。
 * 必須フィールドの追加・削除・改名・既存フィールドの意味や既定値の変更・エンドポイントの削除で +1 する。
 * zod を import しない(admin のどこから import しても軽く保つ)
 */
export const API_CONTRACT_VERSION = 1;
export const API_VERSION_HEADER = "x-wtt-api-version";
export const CLIENT_VERSION_HEADER = "x-wtt-client-version";
