// buildVideo.js を「1ショットずつ描画→合成」の2フェーズにしたことで、メモリが
// ショット数にほぼ比例しなくなった(以前は巨大な filter_complex がRenderの512MBで
// OOM Killされていた)。負荷を絞りたい環境では MAX_SHOTS 環境変数で上書きできる。
export const MAX_SHOTS = Number(process.env.MAX_SHOTS) || 8;

// 予告編としてのリズムを作るのに要る最小ショット数。写真がこれ未満だと動画が短く
// なりすぎるため、写真を巡回させてこの数までショットを水増しする。
// 同じ写真でも focus_bias / motion / 色味 を変えれば別カットに見える。
//
// 値の根拠(buildVideo.js の TARGET_MIN_TOTAL_SECONDS=30 に合わせて逆算):
// buildVideo.js は総尺が30秒に満たない場合、ショット尺を最大 MAX_SHOT_SECONDS(5秒)
// まで伸ばして帳尻を合わせる。この「伸長だけ」で30秒に届く最小ショット数が7
// (medium tempo・slowトランジション想定: 7*4.586 - 6*0.35 ≒ 30.0秒)。
// 6ショット以下だと5秒/ショットの頭打ちに当たり、30秒に届かないまま頭打ちに
// なる(6ショットで28.25秒、3ショットで14.3秒など、徐々に短くなる)。
// 由来: 検証フィードバック 2026-08-31 杉谷「3枚だと動画というには短い/
// 少ない写真ほど補完してほしい/切替をゆっくりに」。2026-09-04、15秒→30秒への
// 目標引き上げに合わせて MIN_SHOTS も 4→7 に変更。
export const MIN_SHOTS = 7;

// 「どの写真ファイルをどのショットに使うか」だけを決める(演出はselectStyle.js/buildVideo.jsが担当)。
// MIN_SHOTS 未満: 写真を順に巡回させて MIN_SHOTS ショットまで水増し(1枚のみでも
// i%length=0 になるだけで同じロジックで扱える。連続で同じ写真にならないよう i%length)。
// MIN_SHOTS〜MAX_SHOTS枚: そのまま1枚1ショット。MAX_SHOTS超: 時系列で均等に間引く
// (AIによるハイライト選定は未実装)。
export function resolveShotImagePaths(photoPaths) {
  if (photoPaths.length < MIN_SHOTS) {
    return Array.from({ length: MIN_SHOTS }, (_, i) => photoPaths[i % photoPaths.length]);
  }
  if (photoPaths.length <= MAX_SHOTS) {
    return [...photoPaths];
  }
  const step = photoPaths.length / MAX_SHOTS;
  const sampled = [];
  for (let i = 0; i < MAX_SHOTS; i += 1) {
    sampled.push(photoPaths[Math.floor(i * step)]);
  }
  return sampled;
}
