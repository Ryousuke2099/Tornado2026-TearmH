import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHitSePath } from './ensureSe.js';
import { hasFilter } from './ffmpegCapabilities.js';
import { renderCatchphraseImage } from './renderCatchphrase.js';

ffmpeg.setFfmpegPath(ffmpegPath);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SE_DIR = path.join(__dirname, '..', '..', 'assets', 'se');

const FPS = 25;
const DISABLE_XFADE = process.env.DISABLE_XFADE === 'true';
// Renderの無料プラン(RAM 512MB)向けに 1080x1920 から落としてある。
// 根本対応(ショットを1本ずつ描画)後は解像度を戻す余地があるが、合成フェーズで
// クリップ本数ぶんのH.264デコーダを同時に開くため、まずは安全側の720pのままにする。
const WIDTH = 720;
const HEIGHT = 1280;

// AIの役割は「どの型を使うか(ショットごと)」の判断のみ。実際の値はここでFFmpeg側が用意する。
// テンポ(=尺)は原則全ショット共通。ショットごとに尺まで変えるとxfadeの累積オフセット計算が
// 複雑になるためスコープ外。
const TEMPO_SECONDS = { slow: 3.5, medium: 2.5, fast: 1.6 };
// カット間のクロスフェード秒数。テンポが速いほど切り替えも短く鋭くする。
const TRANSITION_SECONDS = { slow: 0.35, medium: 0.25, fast: 0.15 };

// 写真(=ショット)が少ないと動画が短くなりすぎる。総尺がこの秒数を下回る場合は
// ショット尺を必要分だけ伸ばしてここに寄せ、切り替えもslow相当までゆっくりにする。
// 由来: 検証フィードバック 2026-08-31 杉谷「3枚だと動画というには短い」。
// 2026-09-04 に15秒→30秒へ引き上げ(15秒でもまだ短いとの追加FB)。
// この値は planShots.js の MIN_SHOTS の根拠にもなっている(揃えて変更すること) —
// MIN_SHOTS はここでの再伸長が MAX_SHOT_SECONDS の頭打ちに当たらずに済む
// 最小ショット数として逆算してある。
const TARGET_MIN_TOTAL_SECONDS = 30;
const MAX_SHOT_SECONDS = 5;

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

// 演出の「動きの種類」。
// - zoom_in: ズームインしながらパン
// - zoom_out: ズームアウト(最初から寄っていて引いていく)
// - static: 完全に静止(zoompan自体を使わない)
// - pan_only: ズームは固定倍率のまま、パンだけで動きを出す
const MOTION_TYPES = ['zoom_in', 'zoom_out', 'static', 'pan_only'];

function buildZoomExpr(motion, zoom) {
  if (motion === 'zoom_out') {
    return `if(eq(on,0),${zoom.target},max(zoom-${zoom.rate},1.0))`;
  }
  if (motion === 'pan_only') {
    return `${zoom.target}`;
  }
  // zoom_in(デフォルト)
  return `min(zoom+${zoom.rate},${zoom.target})`;
}

// パン方向。ズーム中にon(出力フレーム番号)/framesの進行に応じて微小に動かす。
const PAN_DRIFT = {
  'up-left': { dx: -1, dy: -1 },
  'up-right': { dx: 1, dy: -1 },
  'down-left': { dx: -1, dy: 1 },
  'down-right': { dx: 1, dy: 1 },
  none: { dx: 0, dy: 0 },
};
const PAN_DRIFT_PX = 60; // ズーム中にパンで動かす最大ピクセル数

// 人物(顔)中心か風景中心かで、切り出す範囲を変える。
const FOCUS_CROPS = {
  face: { x: 0.15, y: 0.05, w: 0.7, h: 0.7 },
  balanced: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
  background: null, // 画角を狭めない
};

// ─────────────────────────────────────────────────────────────────────────
// タイミング(全ショット共通の尺・トランジション・カット位置)を先に確定する。
// xfadeのoffsetもSEのディレイもここから導出されるので、一度計算すれば全体の整合が保たれる。
// ─────────────────────────────────────────────────────────────────────────
function computeTiming(shotCount, tempo) {
  let shotSeconds = TEMPO_SECONDS[tempo] ?? TEMPO_SECONDS.medium;
  let transitionSeconds = TRANSITION_SECONDS[tempo] ?? TRANSITION_SECONDS.medium;

  const rawTotalSeconds = shotCount * shotSeconds - (shotCount - 1) * transitionSeconds;
  if (rawTotalSeconds < TARGET_MIN_TOTAL_SECONDS) {
    // transitionSeconds を先に確定してから neededShotSeconds を計算する。
    // 逆順(旧実装のバグ)だと、shotSeconds は「引き上げ前の短いtransition」を
    // 前提に計算されるのに、直後でtransitionを伸ばしてしまうため、実際の
    // totalDurationSeconds が TARGET_MIN_TOTAL_SECONDS より短くなっていた
    // (例: 写真3枚→4ショットで 15.0s のはずが 14.7s にしかならない)。
    // 2026-09-04 検証で発覚(FB「3枚だと短い」への対応のはずが未達だった)。
    transitionSeconds = Math.max(transitionSeconds, TRANSITION_SECONDS.slow);
    const neededShotSeconds =
      (TARGET_MIN_TOTAL_SECONDS + (shotCount - 1) * transitionSeconds) / shotCount;
    shotSeconds = Math.min(MAX_SHOT_SECONDS, Math.max(shotSeconds, neededShotSeconds));
  }

  const frames = Math.round(shotSeconds * FPS);
  const totalDurationSeconds = shotCount * shotSeconds - (shotCount - 1) * transitionSeconds;

  // k番目(1始まり)のxfadeのoffset = k*(shotSeconds - transitionSeconds)。
  const cutOffsetsSeconds = [];
  for (let i = 1; i < shotCount; i += 1) {
    cutOffsetsSeconds.push(i * (shotSeconds - transitionSeconds));
  }

  return { shotSeconds, transitionSeconds, frames, totalDurationSeconds, cutOffsetsSeconds };
}

// ─────────────────────────────────────────────────────────────────────────
// 1ショットぶんの映像フィルタ鎖(ラベル無し = `-vf` にそのまま渡せる形)。
// クロップ→スケール→色味→ヴィネット→グレイン→zoompan(または静止)→固定fps。
// ─────────────────────────────────────────────────────────────────────────
function buildShotVideoFilter(shotStyle, frames) {
  const crop = FOCUS_CROPS[shotStyle.focus_bias] ?? null;
  const cropFilter = crop
    ? `crop=iw*${crop.w}:ih*${crop.h}:iw*${crop.x}:ih*${crop.y},`
    : '';
  const zoom = ZOOM_PARAMS[shotStyle.zoom_intensity] ?? ZOOM_PARAMS.moderate;
  const colorFilter = COLOR_GRADE_FILTERS[shotStyle.color_grade] ?? COLOR_GRADE_FILTERS.vivid;
  const motion = MOTION_TYPES.includes(shotStyle.motion) ? shotStyle.motion : 'zoom_in';
  const vignetteFilter = shotStyle.vignette ? ',vignette' : '';
  // フィルムグレイン。ffmpeg-staticのバイナリによってはnoiseフィルタが無いことがあるため確認してから使う。
  const grainFilter = shotStyle.grain && hasFilter('noise') ? ',noise=alls=20:allf=t' : '';

  const basePrefix =
    `${cropFilter}scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
    `crop=${WIDTH}:${HEIGHT},setsar=1,${colorFilter}${vignetteFilter}${grainFilter}`;
  // fpsを明示的に固定しておかないと、後段(合成フェーズのxfade)が
  // "constant frame rate ... invalid" で落ちることがある(Renderのffmpeg-staticで発生)。
  const tail = `setpts=PTS-STARTPTS,fps=${FPS}`;

  if (motion === 'static') {
    // 動きなし。zoompanを使わず、同じ画像をframes分並べるだけ。
    return `${basePrefix},trim=start_frame=0:end_frame=${frames},${tail}`;
  }

  const pan = PAN_DRIFT[shotStyle.pan_direction] ?? PAN_DRIFT.none;
  const xExpr = `iw/2-(iw/zoom/2)+${pan.dx}*${PAN_DRIFT_PX}*(on/${frames})`;
  const yExpr = `ih/2-(ih/zoom/2)+${pan.dy}*${PAN_DRIFT_PX}*(on/${frames})`;
  const zoomExpr = buildZoomExpr(motion, zoom);

  return (
    `${basePrefix},` +
    // zoompanは「1つの入力フレームからd枚の出力フレームを生成し、その間だけzoom値を積み上げる」
    // 仕組みなので、d=framesにしてショット全体を1回の入力フレームから作らせる。
    `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':` +
    `d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS},` +
    `trim=start_frame=0:end_frame=${frames},${tail}`
  );
}

// ─────────────────────────────────────────────────────────────────────────
// フェーズ2a: 描画済みクリップを xfade で「2本ずつ」逐次的に畳み込む。
// 1回のffmpegに渡す映像入力は常に2本だけなので、ショット数が増えても
// メモリはほぼ一定(以前の1パス合成はN本のデコーダ+N-1個のxfadeを1プロセスに
// 同時展開していて、写真枚数に比例してメモリが増えていた)。
// 代償は中間クリップの再エンコード(N-1回)。プロトタイプの720pでは許容範囲。
// ─────────────────────────────────────────────────────────────────────────
async function mergeClipsProgressive({ clipPaths, shotStyles, timing }) {
  const { shotSeconds, transitionSeconds } = timing;
  const temps = [];
  if (clipPaths.length === 1) {
    return { mergedPath: clipPaths[0], temps };
  }

  let accPath = clipPaths[0];
  // acc(これまで畳み込んだ映像)の理想尺。実ファイルのフレーム丸めではなくこの式で
  // 進める(xfadeのoffset計算を安定させるため)。
  let accDurationSeconds = shotSeconds;

  for (let i = 1; i < clipPaths.length; i += 1) {
    const offsetSeconds = Math.max(0, accDurationSeconds - transitionSeconds);
    const transitionType = shotStyles[i].transition_in ?? 'fade';
    const mergedPath = `${clipPaths[0]}.acc${i}.mp4`;
    temps.push(mergedPath);
    const inputA = accPath;
    const inputB = clipPaths[i];
    const mergeFilters = DISABLE_XFADE
      ? [
          `[0:v]fps=${FPS},setsar=1,format=yuv420p,setpts=PTS-STARTPTS[a]`,
          `[1:v]fps=${FPS},setsar=1,format=yuv420p,setpts=PTS-STARTPTS[b]`,
          '[a][b]concat=n=2:v=1:a=0[outv]',
        ]
      : [
          // ffmpeg-static 7.x can expose MP4 inputs to xfade with an invalid
          // time base. Normalize it explicitly before applying transitions.
          `[0:v]fps=${FPS},settb=AVTB,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[a]`,
          `[1:v]fps=${FPS},settb=AVTB,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[b]`,
          `[a][b]xfade=transition=${transitionType}:` +
            `duration=${transitionSeconds}:offset=${offsetSeconds}[outv]`,
        ];
    // eslint-disable-next-line no-await-in-loop
    await runFfmpeg((command) => {
      command
        .input(inputA)
        .input(inputB)
        .complexFilter(mergeFilters)
        .outputOptions([
          '-map', '[outv]',
          '-an',
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', '20', // 中間クリップは繰り返し再エンコードされるので画質を少し上げておく
          '-threads', '1',
          '-pix_fmt', 'yuv420p',
          '-r', `${FPS}`,
        ])
        .save(mergedPath);
    });
    accPath = mergedPath;
    accDurationSeconds += shotSeconds - transitionSeconds;
  }

  return { mergedPath: accPath, temps };
}

// ─────────────────────────────────────────────────────────────────────────
// フェーズ2b: 畳み込み済みの無音映像に、SEミックスとキャッチコピーを1パスで足す。
// 映像入力は1本だけ。音声(BGM/ヒット音)のデコードとoverlay1枚は軽い。
// ─────────────────────────────────────────────────────────────────────────
async function muxAudioAndCatchphrase({
  mergedVideoPath,
  timing,
  styleResult,
  showCatchphrase,
  catchphraseImagePath,
  catchphraseBoxHeight,
  outPath,
}) {
  const bgPath = resolveSePath(styleResult.music_mood);
  const hitPath = resolveHitSePath(styleResult.music_mood);
  // 入力順: [畳み込み映像=0] [キャッチコピー画像?=1] [BGM?] [ヒット音 × カット数]
  const audioPlan = buildAudioPlan({
    cutOffsetsSeconds: timing.cutOffsetsSeconds,
    bgPath,
    hitPath,
    videoInputCount: 1 + (showCatchphrase ? 1 : 0),
    totalDurationSeconds: timing.totalDurationSeconds,
  });

  const filters = [];
  let finalVideoLabel = '0:v'; // 既定: 映像はそのままコピー
  if (showCatchphrase) {
    const catchphraseY = Math.round(HEIGHT * 0.78) - catchphraseBoxHeight;
    filters.push('[0:v]null[outv]');
    filters.push(...buildCatchphraseFilter(1, catchphraseY, timing.totalDurationSeconds));
    finalVideoLabel = '[outv_text]';
  }
  if (audioPlan) {
    filters.push(...audioPlan.filters);
  }

  await runFfmpeg((command) => {
    command.input(mergedVideoPath);
    if (showCatchphrase) {
      command.input(catchphraseImagePath).inputOptions(['-loop 1', `-framerate ${FPS}`]);
    }
    if (audioPlan) {
      audioPlan.extraInputs.forEach(({ path: inputPath, loop }) => {
        const input = command.input(inputPath);
        if (loop) input.inputOptions(['-stream_loop', '-1']);
      });
    }
    if (filters.length > 0) {
      command.complexFilter(filters);
    }
    command
      .outputOptions([
        '-map', finalVideoLabel,
        ...(audioPlan ? ['-map', '[outa]'] : []),
        // キャッチコピーを焼き込むときだけ再エンコード。無ければ映像はコピーで無劣化。
        '-c:v', showCatchphrase ? 'libx264' : 'copy',
        ...(showCatchphrase
          ? ['-preset', 'veryfast', '-crf', '20', '-threads', '1', '-pix_fmt', 'yuv420p']
          : []),
        '-movflags', '+faststart',
        ...(audioPlan ? ['-shortest', '-c:a', 'aac'] : []),
      ])
      .save(outPath);
  });
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
    // BGM素材は数秒の短いループ素材なので -stream_loop -1 で無限リピート入力し、
    // atrimで動画の総尺ちょうどに切り詰める(無限入力のままだと際限なく伸びる)。
    extraInputs.push({ path: bgPath, loop: true });
    filters.push(
      `[${idx}:a]aformat=sample_rates=44100:channel_layouts=stereo,` +
        `atrim=duration=${totalDurationSeconds},asetpts=PTS-STARTPTS[bg]`
    );
    mixLabels.push('[bg]');
  }

  if (hitPath && cutOffsetsSeconds.length > 0) {
    cutOffsetsSeconds.forEach((offsetSeconds, i) => {
      const idx = nextInputIndex;
      nextInputIndex += 1;
      extraInputs.push({ path: hitPath, loop: false });
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

  // ヒット音だけだと音声トラックが動画よりずっと短くなり、後段の-shortestが動画側を
  // 切り詰めてしまう。apad(whole_dur指定)で動画と同じ長さまで無音パディングする
  // (whole_durを省くと際限なく無音を生成しようとしてハングする)。
  filters.push(
    `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest,` +
      `apad=whole_dur=${totalDurationSeconds}[outa]`
  );
  return { filters, extraInputs };
}

// 動画冒頭に短いキャッチコピーを重ねる(AIが「似合う」と判断した場合のみ)。
// drawtext(freetype同梱ビルドが必要)がRenderのffmpeg-staticに無いため、テキストは
// renderCatchphrase.js側でsharpにより透過PNGとして描画し、ここではoverlayで重ねるだけ。
function buildCatchphraseFilter(imageInputIndex, catchphraseY, totalDurationSeconds) {
  const fadeInEnd = 0.4;
  const holdEnd = 2.6;
  const fadeOutStart = holdEnd;
  const fadeOutDuration = 0.4;
  // キャッチコピー画像の入力は -loop 1 で無限供給されるため、trimで動画全体の長さへ切る。
  const totalFrames = Math.round(totalDurationSeconds * FPS);

  return [
    `[${imageInputIndex}:v]format=rgba,` +
      `fade=t=in:st=0:d=${fadeInEnd}:alpha=1,` +
      `fade=t=out:st=${fadeOutStart}:d=${fadeOutDuration}:alpha=1,` +
      `trim=start_frame=0:end_frame=${totalFrames},setpts=PTS-STARTPTS[textlayer]`,
    `[outv][textlayer]overlay=x=0:y=${catchphraseY}:` +
      `enable='between(t,0,${fadeOutStart + fadeOutDuration})'[outv_text]`,
  ];
}

function resolveSePath(musicMood) {
  const candidatePath = path.join(SE_DIR, `${musicMood}.mp3`);
  return existsSync(candidatePath) ? candidatePath : null;
}

// fluent-ffmpegの1コマンドをPromiseで実行する小さなラッパ。
function runFfmpeg(configure) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg();
    configure(command);
    command
      .on('start', (cmd) => console.log('[ffmpeg]', cmd))
      .on('stderr', (line) => console.log('[ffmpeg]', line))
      .on('error', (err) => reject(err))
      .on('end', () => resolve());
  });
}

// フェーズ1: 1ショットを単独のffmpegで描画し、CFRなmp4クリップとして書き出す。
// 同時に存在するzoompanは常に1つだけなので、ショット数を増やしてもメモリはほぼ一定。
async function renderShotClip({ imagePath, videoFilter, frames, clipPath }) {
  await runFfmpeg((command) => {
    command
      .input(imagePath)
      .inputOptions(['-loop 1', `-framerate ${FPS}`])
      .videoFilters(videoFilter)
      .outputOptions([
        '-an',
        // trim(end_frame=frames)と同じ枚数で頭打ちにして、クリップ長を元実装と一致させる。
        '-frames:v', `${frames}`,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-threads', '1',
        '-pix_fmt', 'yuv420p',
        '-r', `${FPS}`,
      ])
      .save(clipPath);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 予告編風の可変ショット数パイプライン(2フェーズ)。
//   フェーズ1: 写真ごとに個別のffmpegでショットクリップを描画(zoompan等の力仕事はここ、1本ずつ)
//   フェーズ2: 描画済みクリップをxfade連鎖 + SEミックス + キャッチコピーで1本に合成(軽い)
// 以前は全部を1つの巨大な filter_complex に入れていたため、写真枚数に比例して
// メモリが増え、Renderの512MBプランで5枚以上がOOM Kill(exit 137)されていた。
// ─────────────────────────────────────────────────────────────────────────
export async function generateVideo({ shotImagePaths, outPath, styleResult }) {
  if (!shotImagePaths || shotImagePaths.length === 0) {
    throw new Error('shotImagePaths is empty');
  }
  if (!styleResult?.shots || styleResult.shots.length !== shotImagePaths.length) {
    throw new Error('styleResult.shots must match shotImagePaths length');
  }

  const shotStyles = styleResult.shots;
  const timing = computeTiming(shotImagePaths.length, styleResult.tempo);

  // キャッチコピーはAIが「似合う」と判断したときだけ重ねる。
  const catchphraseText = styleResult.catchphrase_text?.trim();
  const showCatchphrase = Boolean(
    styleResult.catchphrase_shown && catchphraseText && hasFilter('overlay')
  );
  const catchphraseImagePath = showCatchphrase ? `${outPath}.catchphrase.png` : null;
  let catchphraseBoxHeight = 0;
  if (catchphraseImagePath) {
    ({ boxHeight: catchphraseBoxHeight } = await renderCatchphraseImage({
      text: catchphraseText,
      videoWidth: WIDTH,
      outPath: catchphraseImagePath,
    }));
  }

  const clipPaths = shotImagePaths.map((_, i) => `${outPath}.shot${i}.mp4`);
  const tempFiles = [...clipPaths, catchphraseImagePath].filter(Boolean);

  const cleanup = () => {
    for (const p of tempFiles) {
      if (p && p !== outPath && existsSync(p)) {
        try {
          unlinkSync(p);
        } catch {
          // 一時ファイルの後始末なので失敗しても無視
        }
      }
    }
  };

  try {
    // ── フェーズ1: ショットクリップを1本ずつ描画(zoompanは常に1つだけ) ──
    for (let i = 0; i < shotImagePaths.length; i += 1) {
      const videoFilter = buildShotVideoFilter(shotStyles[i], timing.frames);
      // 直列実行が肝(並列化するとzoompanが複数同時に走りメモリ一定の保証が崩れる)。
      // eslint-disable-next-line no-await-in-loop
      await renderShotClip({
        imagePath: shotImagePaths[i],
        videoFilter,
        frames: timing.frames,
        clipPath: clipPaths[i],
      });
    }

    // ── フェーズ2a: クリップを2本ずつxfadeで畳み込む(映像入力は常に2本だけ) ──
    const { mergedPath, temps: mergeTemps } = await mergeClipsProgressive({
      clipPaths,
      shotStyles,
      timing,
    });
    tempFiles.push(...mergeTemps);

    // ── フェーズ2b: 無音映像にSEミックスとキャッチコピーを足して仕上げる ──
    await muxAudioAndCatchphrase({
      mergedVideoPath: mergedPath,
      timing,
      styleResult,
      showCatchphrase,
      catchphraseImagePath,
      catchphraseBoxHeight,
      outPath,
    });

    return outPath;
  } finally {
    cleanup();
  }
}
