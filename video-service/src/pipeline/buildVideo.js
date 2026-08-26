import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STYLE } from './selectStyle.js';
import { resolveHitSePath } from './ensureSe.js';

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

// カット間のクロスフェード秒数。テンポが速いほど切り替えも短く鋭くする。
const TRANSITION_SECONDS = { slow: 0.35, medium: 0.25, fast: 0.15 };

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

// ショットごとにズーム時のパン方向を変え、全カット同じ「中央から真っ直ぐズーム」にならないようにする。
// on(出力フレーム番号)/frames の比率でx/yを動かし、ズームインしながら斜めに流れる動きを作る。
const PAN_VARIANTS = [
  { dx: 1, dy: -1 }, // 右上へ流れながらズーム
  { dx: -1, dy: 1 }, // 左下へ流れながらズーム
  { dx: -1, dy: -1 }, // 左上へ流れながらズーム
  { dx: 1, dy: 1 }, // 右下へ流れながらズーム
];
const PAN_DRIFT_PX = 60; // ズーム中にパンで動かす最大ピクセル数(1080x1920基準)

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

// 各ショットの映像フィルタ([v0][v1]...)と、それらをxfadeで繋いだ最終段[outv]を組み立てる。
// 予告編らしさの核: ①ショットごとに違う方向へズーム+パン ②ハードカットではなくクロスフェードで繋ぐ。
function buildVideoFilterGraph(shots, style) {
  const shotSeconds = TEMPO_SECONDS[style.tempo] ?? TEMPO_SECONDS.medium;
  const transitionSeconds = TRANSITION_SECONDS[style.tempo] ?? TRANSITION_SECONDS.medium;
  const zoom = ZOOM_PARAMS[style.zoom_intensity] ?? ZOOM_PARAMS.moderate;
  const colorFilter = COLOR_GRADE_FILTERS[style.color_grade] ?? COLOR_GRADE_FILTERS.vivid;
  const frames = Math.round(shotSeconds * FPS);

  const perShotFilters = shots.map((shot, i) => {
    const cropFilter = shot.crop
      ? `crop=iw*${shot.crop.w}:ih*${shot.crop.h}:iw*${shot.crop.x}:ih*${shot.crop.y},`
      : '';
    const pan = PAN_VARIANTS[i % PAN_VARIANTS.length];
    // x/yはzoompan既定の中央寄せ式に、on(出力フレーム番号)/frames の進行に応じた
    // 微小なドリフトを足すことで、単なる中央ズームインから斜めのパンを加えた動きにしている。
    const xExpr = `iw/2-(iw/zoom/2)+${pan.dx}*${PAN_DRIFT_PX}*(on/${frames})`;
    const yExpr = `ih/2-(ih/zoom/2)+${pan.dy}*${PAN_DRIFT_PX}*(on/${frames})`;
    return (
      `[${i}:v]${cropFilter}scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${WIDTH}:${HEIGHT},setsar=1,${colorFilter},` +
      // zoompanは「1つの入力フレームからd枚の出力フレームを生成し、その間だけzoom値を積み上げる」
      // 仕組みなので、d=framesにしてショットの全フレームを1回の入力フレームから作らせる必要がある
      // (d=1だと出力1枚ごとに新しい入力フレーム扱いになりzoomの積み上げが毎回リセットされ、
      // 見た目上ズームが一切動かないバグになる)。入力側は-loop 1のみで無限に同じ画像を供給できるが、
      // d=framesにしたことで実際に消費されるのは最初の1フレームだけなので、以前あった
      // 「d×入力フレーム数の掛け算で動画が63倍に伸びる」問題は起きない。trimは念のための安全弁。
      `zoompan=z='min(zoom+${zoom.rate},${zoom.target})':x='${xExpr}':y='${yExpr}':` +
      `d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS},` +
      `trim=start_frame=0:end_frame=${frames},setpts=PTS-STARTPTS[v${i}]`
    );
  });

  // ハードカット(concat)ではなくxfadeの連鎖で繋ぐ。全ショット同じ長さ(shotSeconds)である前提で、
  // k番目(1始まり)のxfadeのoffsetはk*(shotSeconds-transitionSeconds)になる
  // (導出: 1本目と2本目を繋いだ時点の尺は2L-T、そこに3本目を繋ぐ時のoffsetは(2L-T)-T=2L-2T、
  //  以降も同様にk*(L-T)のパターンになる)。
  const transitionFilters = [];
  const offsetsSeconds = [];
  let outputLabel = 'v0';
  if (shots.length === 1) {
    transitionFilters.push('[v0]null[outv]');
  } else {
    for (let i = 1; i < shots.length; i += 1) {
      const offsetSeconds = i * (shotSeconds - transitionSeconds);
      offsetsSeconds.push(offsetSeconds);
      const nextLabel = i === shots.length - 1 ? 'outv' : `vx${i}`;
      transitionFilters.push(
        `[${outputLabel}][v${i}]xfade=transition=fade:duration=${transitionSeconds}:offset=${offsetSeconds}[${nextLabel}]`
      );
      outputLabel = nextLabel;
    }
  }

  const totalDurationSeconds = shots.length * shotSeconds - (shots.length - 1) * transitionSeconds;

  return {
    filters: [...perShotFilters, ...transitionFilters],
    cutOffsetsSeconds: offsetsSeconds,
    totalDurationSeconds,
  };
}

// 各カットの切り替えタイミングに合わせて短い「衝撃音」を鳴らし、あれば背景SE(bgPath)ともミックスする。
// 音声入力が1つも無ければnullを返し、呼び出し側は無音のまま出力する。
function buildAudioPlan({ cutOffsetsSeconds, bgPath, hitPath, videoInputCount, totalDurationSeconds }) {
  const filters = [];
  const mixLabels = [];
  let nextInputIndex = videoInputCount;
  const extraInputs = [];

  if (bgPath) {
    const idx = nextInputIndex;
    nextInputIndex += 1;
    extraInputs.push(bgPath);
    filters.push(`[${idx}:a]aformat=sample_rates=44100:channel_layouts=stereo[bg]`);
    mixLabels.push('[bg]');
  }

  if (hitPath && cutOffsetsSeconds.length > 0) {
    cutOffsetsSeconds.forEach((offsetSeconds, i) => {
      const idx = nextInputIndex;
      nextInputIndex += 1;
      extraInputs.push(hitPath);
      const delayMs = Math.max(0, Math.round(offsetSeconds * 1000));
      const label = `hit${i}`;
      filters.push(
        `[${idx}:a]adelay=${delayMs}:all=1,aformat=sample_rates=44100:channel_layouts=stereo[${label}]`
      );
      mixLabels.push(`[${label}]`);
    });
  }

  if (mixLabels.length === 0) {
    return null;
  }

  // ヒット音だけ(=短い断続音のみ)だと音声トラックが動画よりずっと短くなり、
  // 後段の-shortestが動画側を音声の短さに合わせて切り詰めてしまう。apad(whole_dur指定)で
  // 動画と同じ長さまで無音パディングする。whole_durを指定せず素の`apad`だけにすると
  // 際限なく無音を生成しようとしてフィルタ処理がハングし、"No space left on device"のような
  // 異常終了を引き起こしたため、必ず秒数を明示する。
  filters.push(
    `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest,` +
      `apad=whole_dur=${totalDurationSeconds}[outa]`
  );
  return { filters, extraInputs };
}

function resolveSePath(musicMood) {
  const candidatePath = path.join(SE_DIR, `${musicMood}.mp3`);
  return existsSync(candidatePath) ? candidatePath : null;
}

// 予告編風の可変ショット数パイプライン: 写真(複数 or 1枚)→クロップ・ズーム・パン→クロスフェード→
// SEミックス→mp4。style(selectStyle.jsがAIまたはデフォルトで決める)に従って、テンポ・色味・
// ズーム強さ・人物/背景の重み付け・SEを切り替える。実際の描画処理(力仕事)はすべてFFmpeg側が担う。
export function generateVideo({ photoPaths, outPath, style = DEFAULT_STYLE }) {
  if (!photoPaths || photoPaths.length === 0) {
    return Promise.reject(new Error('photoPaths is empty'));
  }

  const shots = pickShots(photoPaths, style.focus_bias);
  const { filters: videoFilters, cutOffsetsSeconds, totalDurationSeconds } = buildVideoFilterGraph(shots, style);

  const bgPath = resolveSePath(style.music_mood);
  const hitPath = resolveHitSePath(style.music_mood);
  const audioPlan = buildAudioPlan({
    cutOffsetsSeconds,
    bgPath,
    hitPath,
    videoInputCount: shots.length,
    totalDurationSeconds,
  });

  const allFilters = audioPlan ? [...videoFilters, ...audioPlan.filters] : videoFilters;

  return new Promise((resolve, reject) => {
    const command = ffmpeg();

    shots.forEach((shot) => {
      // -tは付けない(無限ループの静止画入力にして、フィルタ側のtrimで長さを確定する)
      command.input(shot.imagePath).inputOptions(['-loop 1', `-framerate ${FPS}`]);
    });

    if (audioPlan) {
      audioPlan.extraInputs.forEach((inputPath) => command.input(inputPath));
    }

    const outputOptions = [
      '-map', '[outv]',
      ...(audioPlan ? ['-map', '[outa]'] : []),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      // moovアトムを先頭に置き、ブラウザでのプログレッシブ再生を可能にする
      '-movflags', '+faststart',
      ...(audioPlan ? ['-shortest', '-c:a', 'aac'] : []),
    ];

    command
      .complexFilter(allFilters)
      .outputOptions(outputOptions)
      .on('start', (cmd) => console.log('[ffmpeg]', cmd))
      .on('stderr', (line) => console.log('[ffmpeg]', line))
      .on('error', reject)
      .on('end', () => resolve(outPath))
      .save(outPath);
  });
}
