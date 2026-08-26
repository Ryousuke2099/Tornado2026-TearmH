import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import { existsSync } from 'node:fs';

ffmpeg.setFfmpegPath(ffmpegPath);

const FPS = 25;
const SHOT_SECONDS = 2.5;
const WIDTH = 1080;
const HEIGHT = 1920;
const MAX_SHOTS = 8;

// 写真が1枚しかない場合に、同じ写真から複数領域をクロップして疑似的な複数カットを作るためのフォールバック領域。
// スタイルの型(テンポ・色味・ズーム強さ等)をAIが選ぶ設計は未確定のため、まずは固定パターンで動かす。
const SINGLE_PHOTO_CROPS = [
  { x: 0, y: 0, w: 1, h: 1 },
  { x: 0, y: 0, w: 0.6, h: 0.6 },
  { x: 0.4, y: 0.4, w: 0.6, h: 0.6 },
];

function pickShots(photoPaths) {
  if (photoPaths.length === 1) {
    return SINGLE_PHOTO_CROPS.map((crop) => ({ imagePath: photoPaths[0], crop }));
  }
  if (photoPaths.length <= MAX_SHOTS) {
    return photoPaths.map((imagePath) => ({ imagePath, crop: null }));
  }
  // MAX_SHOTSを超える場合は時系列で均等に間引く。「AIがハイライトを選定」は未実装。
  const step = photoPaths.length / MAX_SHOTS;
  const sampled = [];
  for (let i = 0; i < MAX_SHOTS; i += 1) {
    sampled.push(photoPaths[Math.floor(i * step)]);
  }
  return sampled.map((imagePath) => ({ imagePath, crop: null }));
}

function buildFilterGraph(shots) {
  const frames = Math.round(SHOT_SECONDS * FPS);
  const perShotFilters = shots.map((shot, i) => {
    const cropFilter = shot.crop
      ? `crop=iw*${shot.crop.w}:ih*${shot.crop.h}:iw*${shot.crop.x}:ih*${shot.crop.y},`
      : '';
    return (
      `[${i}:v]${cropFilter}scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${WIDTH}:${HEIGHT},setsar=1,` +
      // d=1でzoompanの入力:出力フレームを1:1にし、無限ループ入力をtrimで狙った長さに切る。
      // (以前はd=framesにした上でtrimなしで入力側もframes分ループさせていたため、
      // zoompanのd(フレーム保持数)と入力フレーム数が掛け算されて動画が63倍近く長くなるバグがあった)
      `zoompan=z='min(zoom+0.0015,1.2)':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS},` +
      `trim=start_frame=0:end_frame=${frames},setpts=PTS-STARTPTS[v${i}]`
    );
  });
  const concatInputs = shots.map((_, i) => `[v${i}]`).join('');
  const concatFilter = `${concatInputs}concat=n=${shots.length}:v=1:a=0[outv]`;
  return [...perShotFilters, concatFilter].join(';');
}

// 予告編風の可変ショット数パイプライン: 写真(複数 or 1枚)→クロップ・ズーム・カット→SEミックス→mp4。
// AIによるキャッチコピー生成・スタイル選定(video-pipeline-tech-stack.mdの「未決定」項目)は未実装、
// まずはFFmpeg側のカット割りパイプライン自体の合意を優先する。
export function generateVideo({ photoPaths, outPath, sePath }) {
  if (!photoPaths || photoPaths.length === 0) {
    return Promise.reject(new Error('photoPaths is empty'));
  }

  const shots = pickShots(photoPaths);
  const filterGraph = buildFilterGraph(shots);
  const hasSe = Boolean(sePath && existsSync(sePath));

  return new Promise((resolve, reject) => {
    const command = ffmpeg();

    shots.forEach((shot) => {
      // -tは付けない(無限ループの静止画入力にして、フィルタ側のtrimで長さを確定する)
      command.input(shot.imagePath).inputOptions(['-loop 1', `-framerate ${FPS}`]);
    });

    if (hasSe) {
      command.input(sePath);
    }

    const outputOptions = [
      '-map', '[outv]',
      ...(hasSe ? ['-map', `${shots.length}:a`] : []),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      // moovアトムを先頭に置き、ブラウザでのプログレッシブ再生を可能にする
      '-movflags', '+faststart',
      ...(hasSe ? ['-shortest', '-c:a', 'aac'] : []),
    ];

    command
      .complexFilter(filterGraph)
      .outputOptions(outputOptions)
      .on('start', (cmd) => console.log('[ffmpeg]', cmd))
      .on('stderr', (line) => console.log('[ffmpeg]', line))
      .on('error', reject)
      .on('end', () => resolve(outPath))
      .save(outPath);
  });
}
