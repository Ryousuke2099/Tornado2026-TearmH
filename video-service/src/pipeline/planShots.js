// buildVideo.js を「1ショットずつ描画→合成」の2フェーズにしたことで、メモリが
// ショット数にほぼ比例しなくなった(以前は巨大な filter_complex がRenderの512MBで
// OOM Killされていた)。負荷を絞りたい環境では MAX_SHOTS 環境変数で上書きできる。
export const MAX_SHOTS = Number(process.env.MAX_SHOTS) || 8;

// 予告編としてのリズムを作るのに要る最小ショット数。写真がこれ未満だと動画が短く
// なりすぎる(2枚≒4.75秒)ため、写真を巡回させてこの数までショットを水増しする。
// 同じ写真でも focus_bias / motion / 色味 を変えれば別カットに見える(1枚のみ時と同じ発想)。
// 由来: 検証フィードバック 2026-08-31 杉谷「3枚だと動画というには短い/少ない写真ほど補完してほしい」。
export const MIN_SHOTS = 4;

// 「どの写真ファイルをどのショットに使うか」だけを決める(演出はselectStyle.js/buildVideo.jsが担当)。
// 1枚のみ: 同じ写真を3ショット分使う(疑似カット用、演出側で違うfocus_bias/パンを当てて変化を出す)。
// 2〜3枚: 写真を順に巡回させてMIN_SHOTSショットまで水増し(連続で同じ写真にならないよう i%length)。
// MIN_SHOTS〜8枚: そのまま1枚1ショット。8枚超: 時系列で均等に間引く(AIによるハイライト選定は未実装)。
export function resolveShotImagePaths(photoPaths) {
  if (photoPaths.length === 1) {
    return [photoPaths[0], photoPaths[0], photoPaths[0]];
  }
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
