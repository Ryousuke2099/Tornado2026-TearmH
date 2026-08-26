import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STYLE } from './selectStyle.js';

ffmpeg.setFfmpegPath(ffmpegPath);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SE_DIR = path.join(__dirname, '..', '..', 'assets', 'se');

const FPS = 25;
const WIDTH = 1080;
const HEIGHT = 1920;
const MAX_SHOTS = 8;

// AIの役割は「どの型を使うか」の判断のみ。実際の値はここでFFmpeg側があらかじめ用意しておく
// (video-pipeline-tech-stack.mdの「AIとFFmpegの役割分担」案)。

const TEMPO_SECONDS = { slow: 3.5, medium: 2.5, fast: 1.6 };

const ZOOM_PARAMS = {
  subtle: { target: 1.08, rate: 0.0008 },
  moderate: { target: 1.2, rate: 0.0015 },
  strong: { target: 1.35, rate: 0.0025 },
};

// FFmpegの色調整フィルタ。vintageのみffmpeg組み込みのcurvesプリセットを使う。
const COLOR_GRADE_FILTERS = {
  warm: 'colorbalance=rs=0.15:gs=0.05:bs=-0.15',
  cool: 'colorbalance=rs=-0.15:gs=0:bs=0.15',
  vintage: 'curves=preset=vintage',
  vivid: 'eq=saturation=1.4:contrast=1.1',
  monochrome: 'hue=s=0',
};

// 写真が1枚しかない場合に、同じ写真から複数領域をクロップして疑似的な複数カットを作るためのフォールバック領域。
// focus_biasごとに切り出す位置を変える(faceは中央寄りをやや強めに、backgroundは画角を狭めない)。
const SINGLE_PHOTO_CROPS = {
  face: [
    { x: 0.1, y: 0.05, w: 0.8, h: 0.8 },
    { x: 0.25, y: 0, w: 0.5, h: 0.5 },
    { x: 0.15, y: 0.15, w: 0.6, h: 0.6 },
  ],
  background: [
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 0, y: 0.3, w: 1, h: 0.7 },
    { x: 0.2, y: 0.2, w: 0.8, h: 0.8 },
  ],
  balanced: [
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 0, y: 0, w: 0.6, h: 0.6 },
    { x: 0.4, y: 0.4, w: 0.6, h: 0.6 },
  ],
};

// 複数枚のときの追加クロップ(faceのみ中央寄りに軽く寄せる。background/balancedは画角そのまま)。
const MULTI_PHOTO_CROP = {
  face: { x: 0.1, y: 0.05, w: 0.8, h: 0.8 },
  background: null,
  balanced: null,
};

function pickShots(photoPaths, focusBias) {
  if (photoPaths.length === 1) {
    const crops = SINGLE_PHOTO_CROPS[focusBias] ?? SINGLE_PHOTO_CROPS.balanced;
    return crops.map((crop) => ({ imagePath: photoPaths[0], crop }));
  }

  const crop = MULTI_PHOTO_CROP[focusBias] ?? null;
  if (photoPaths.length <= MAX_SHOTS) {
    return photoPaths.map((imagePath) => ({ imagePath, crop }));
  }
  // MAX_SHOTSを超える場合は時系列で均等に間引く。「AIがハイライトを選定」は未実装。
  const step = photoPaths.length / MAX_SHOTS;
  const sampled = [];
  for (let i = 0; i < MAX_SHOTS; i += 1) {
    sampled.push(photoPaths[Math.floor(i * step)]);
  }
  return sampled.map((imagePath) => ({ imagePath, crop }));
}

function buildFilterGraph(shots, style) {
  const shotSeconds = TEMPO_SECONDS[style.tempo] ?? TEMPO_SECONDS.medium;
  const zoom = ZOOM_PARAMS[style.zoom_intensity] ?? ZOOM_PARAMS.moderate;
  const colorFilter = COLOR_GRADE_FILTERS[style.color_grade] ?? COLOR_GRADE_FILTERS.vivid;
  const frames = Math.round(shotSeconds * FPS);

  const perShotFilters = shots.map((shot, i) => {
    const cropFilter = shot.crop
      ? `crop=iw*${shot.crop.w}:ih*${shot.crop.h}:iw*${shot.crop.x}:ih*${shot.crop.y},`
      : '';
    return (
      `[${i}:v]${cropFilter}scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${WIDTH}:${HEIGHT},setsar=1,${colorFilter},` +
      // d=1でzoompanの入力:出力フレームを1:1にし、無限ループ入力をtrimで狙った長さに切る。
      // (以前はd=framesにした上でtrimなしで入力側もframes分ループさせていたため、
      // zoompanのd(フレーム保持数)と入力フレーム数が掛け算されて動画が63倍近く長くなるバグがあった)
      `zoompan=z='min(zoom+${zoom.rate},${zoom.target})':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS},` +
      `trim=start_frame=0:end_frame=${frames},setpts=PTS-STARTPTS[v${i}]`
    );
  });
  const concatInputs = shots.map((_, i) => `[v${i}]`).join('');
  const concatFilter = `${concatInputs}concat=n=${shots.length}:v=1:a=0[outv]`;
  return [...perShotFilters, concatFilter].join(';');
}

function resolveSePath(musicMood) {
  const candidates = [`${musicMood}.mp3`, 'default.mp3'];
  for (const name of candidates) {
    const candidatePath = path.join(SE_DIR, name);
    if (existsSync(candidatePath)) return candidatePath;
  }
  return null;
}

// 予告編風の可変ショット数パイプライン: 写真(複数 or 1枚)→クロップ・ズーム・カット→SEミックス→mp4。
// style(selectStyle.jsがAIまたはデフォルトで決める)に従って、テンポ・色味・ズーム強さ・
// 人物/背景の重み付け・SEを切り替える。実際の描画処理(力仕事)はすべてFFmpeg側が担う。
export function generateVideo({ photoPaths, outPath, style = DEFAULT_STYLE }) {
  if (!photoPaths || photoPaths.length === 0) {
    return Promise.reject(new Error('photoPaths is empty'));
  }

  const shots = pickShots(photoPaths, style.focus_bias);
  const filterGraph = buildFilterGraph(shots, style);
  const sePath = resolveSePath(style.music_mood);
  const hasSe = Boolean(sePath);

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
