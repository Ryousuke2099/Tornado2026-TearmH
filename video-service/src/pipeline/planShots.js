export const MAX_SHOTS = 8;

// 「どの写真ファイルをどのショットに使うか」だけを決める(演出はselectStyle.js/buildVideo.jsが担当)。
// 1枚のみ: 同じ写真を3ショット分使う(疑似カット用、演出側で違うfocus_bias/パンを当てて変化を出す)。
// 8枚以下: そのまま1枚1ショット。8枚超: 時系列で均等に間引く(AIによるハイライト選定は未実装)。
export function resolveShotImagePaths(photoPaths) {
  if (photoPaths.length === 1) {
    return [photoPaths[0], photoPaths[0], photoPaths[0]];
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
