import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHitSePath } from './ensureSe.js';

ffmpeg.setFfmpegPath(ffmpegPath);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SE_DIR = path.join(__dirname, '..', '..', 'assets', 'se');
const FONT_PATH = path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansJP.ttf');

// FFmpegのフィルタグラフでは`\`と`:`が特殊文字になるため、Windowsの絶対パス
// (例: C:\Users\...)をfontfile=/textfile=にそのまま渡すと壊れる。エスケープする。
function escapeFilterPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:');
}

const FPS = 25;
// Renderの無料プラン(RAM 512MB)でOOM Kill(exit 137)が発生したため、1080x1920から解像度を
// 落として負荷を下げている。ハッカソンのプロトタイプ検証用途では画質より安定動作を優先。
const WIDTH = 720;
const HEIGHT = 1280;

// AIの役割は「どの型を使うか(ショットごと)」の判断のみ。実際の値はここでFFmpeg側が用意する
// (video-pipeline-tech-stack.mdの「AIとFFmpegの役割分担」案)。テンポ(=尺)だけは全ショット共通の
// ままにしている。ショットごとに尺まで変えるとxfadeの累積オフセット計算が複雑になるため、
// ハッカソンの残り時間を踏まえてスコープ外にした。

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

// 演出の「動きの種類」。以前は全ショット固定でzoompanのズームインしかしていなかったが、
// 「演出をズームに固定するな」との指摘を受けて4種類に分けた。
// - zoom_in: 従来通りズームインしながらパン
// - zoom_out: ズームアウト(最初から寄っていて引いていく)。zoompanの'zoom'変数はon(フレーム番号)が
//   0のときだけ明示的にtarget値を返し、以降はそこから減算する式にすることで実現している
//   (reverseフィルタで映像を逆再生する案もあるが、フレームをすべてメモリに溜め込む必要があり
//   Renderの512MBプランでOOMを起こしたばかりなので採用しなかった)
// - static: 完全に静止(zoompan自体を使わない)。動きの無いカットも混ぜて緩急をつける
// - pan_only: ズームは固定倍率のまま変化させず、パンだけで動きを出す
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

// パン方向。ズームインしながらon(出力フレーム番号)/framesの進行に応じて微小に動かす。
const PAN_DRIFT = {
  'up-left': { dx: -1, dy: -1 },
  'up-right': { dx: 1, dy: -1 },
  'down-left': { dx: -1, dy: 1 },
  'down-right': { dx: 1, dy: 1 },
  none: { dx: 0, dy: 0 },
};
const PAN_DRIFT_PX = 60; // ズーム中にパンで動かす最大ピクセル数(1080x1920基準)

// 人物(顔)中心か風景中心かで、切り出す範囲を変える。
const FOCUS_CROPS = {
  face: { x: 0.15, y: 0.05, w: 0.7, h: 0.7 },
  balanced: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
  background: null, // 画角を狭めない
};

// 各ショットの映像フィルタ([v0][v1]...)と、それらをxfadeで繋いだ最終段[outv]を組み立てる。
// 予告編らしさの核: ①ショットごとに違う演出(パン方向・ズーム強さ・色味・ヴィネット・トランジション種類)
// ②ハードカットではなくクロスフェードで繋ぐ。
function buildVideoFilterGraph(shotImagePaths, shotStyles, tempo) {
  const shotSeconds = TEMPO_SECONDS[tempo] ?? TEMPO_SECONDS.medium;
  const transitionSeconds = TRANSITION_SECONDS[tempo] ?? TRANSITION_SECONDS.medium;
  const frames = Math.round(shotSeconds * FPS);

  const perShotFilters = shotImagePaths.map((_, i) => {
    const shotStyle = shotStyles[i];
    const crop = FOCUS_CROPS[shotStyle.focus_bias] ?? null;
    const cropFilter = crop ? `crop=iw*${crop.w}:ih*${crop.h}:iw*${crop.x}:ih*${crop.y},` : '';
    const zoom = ZOOM_PARAMS[shotStyle.zoom_intensity] ?? ZOOM_PARAMS.moderate;
    const colorFilter = COLOR_GRADE_FILTERS[shotStyle.color_grade] ?? COLOR_GRADE_FILTERS.vivid;
    const motion = MOTION_TYPES.includes(shotStyle.motion) ? shotStyle.motion : 'zoom_in';
    const vignetteFilter = shotStyle.vignette ? ',vignette' : '';
    // フィルムグレイン(粒状ノイズ)。ズーム・パンだけでなく質感でも演出にバリエーションを出す。
    const grainFilter = shotStyle.grain ? ',noise=alls=20:allf=t' : '';

    const basePrefix =
      `[${i}:v]${cropFilter}scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${WIDTH}:${HEIGHT},setsar=1,${colorFilter}${vignetteFilter}${grainFilter}`;

    // zoompanのfpsオプションだけでは、ffmpegのビルドによって出力ストリームに
    // 「一定フレームレート」の情報がうまく伝わらず、後段のxfadeが
    // "inputs needs to be a constant frame rate; current rate of 1/0 is invalid"
    // で失敗することがある(ローカルのffmpeg 6.1では問題なかったが、Renderにデプロイした
    // ffmpeg-staticのLinuxバイナリで発生)。fpsフィルタを明示的に挟んで固定する。
    const tail = `setpts=PTS-STARTPTS,fps=${FPS}[v${i}]`;

    if (motion === 'static') {
      // 動きなし。zoompan自体を使わず、同じ画像をそのままframes分並べるだけ。
      return `${basePrefix},trim=start_frame=0:end_frame=${frames},${tail}`;
    }

    const pan = motion === 'pan_only' ? (PAN_DRIFT[shotStyle.pan_direction] ?? PAN_DRIFT.none) : PAN_DRIFT[shotStyle.pan_direction] ?? PAN_DRIFT.none;
    const xExpr = `iw/2-(iw/zoom/2)+${pan.dx}*${PAN_DRIFT_PX}*(on/${frames})`;
    const yExpr = `ih/2-(ih/zoom/2)+${pan.dy}*${PAN_DRIFT_PX}*(on/${frames})`;
    const zoomExpr = buildZoomExpr(motion, zoom);

    return (
      `${basePrefix},` +
      // zoompanは「1つの入力フレームからd枚の出力フレームを生成し、その間だけzoom値を積み上げる」
      // 仕組みなので、d=framesにしてショットの全フレームを1回の入力フレームから作らせる必要がある
      // (d=1だと出力1枚ごとに新しい入力フレーム扱いになりzoomの積み上げが毎回リセットされ、
      // 見た目上ズームが一切動かないバグになる)。入力側は-loop 1のみで無限に同じ画像を供給できるが、
      // d=framesにしたことで実際に消費されるのは最初の1フレームだけなので、以前あった
      // 「d×入力フレーム数の掛け算で動画が63倍に伸びる」問題は起きない。trimは念のための安全弁。
      `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':` +
      `d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS},` +
      `trim=start_frame=0:end_frame=${frames},${tail}`
    );
  });

  // ハードカット(concat)ではなくxfadeの連鎖で繋ぐ。トランジションの「種類」はショットごとに違っても、
  // 「長さ」は全ショット共通(transitionSeconds)にしているので、k番目(1始まり)のxfadeのoffsetは
  // k*(shotSeconds-transitionSeconds)になる(導出: 1本目と2本目を繋いだ時点の尺は2L-T、そこに
  // 3本目を繋ぐ時のoffsetは(2L-T)-T=2L-2T、以降も同様にk*(L-T)のパターンになる)。
  const transitionFilters = [];
  const offsetsSeconds = [];
  let outputLabel = 'v0';
  if (shotImagePaths.length === 1) {
    transitionFilters.push('[v0]null[outv]');
  } else {
    for (let i = 1; i < shotImagePaths.length; i += 1) {
      const offsetSeconds = i * (shotSeconds - transitionSeconds);
      offsetsSeconds.push(offsetSeconds);
      const transitionType = shotStyles[i].transition_in ?? 'fade';
      const nextLabel = i === shotImagePaths.length - 1 ? 'outv' : `vx${i}`;
      transitionFilters.push(
        `[${outputLabel}][v${i}]xfade=transition=${transitionType}:duration=${transitionSeconds}:offset=${offsetSeconds}[${nextLabel}]`
      );
      outputLabel = nextLabel;
    }
  }

  const totalDurationSeconds =
    shotImagePaths.length * shotSeconds - (shotImagePaths.length - 1) * transitionSeconds;

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

// 動画冒頭に短いキャッチコピーを重ねる(AIが「似合う」と判断した場合のみ)。
// テキストの中身を直接filter文字列に埋め込むとffmpegのフィルタ構文上の特殊文字
// (コロン・引用符など)のエスケープが必要で壊れやすいため、textfile=で外部ファイルから読ませる。
function buildCatchphraseFilter(catchphraseTextPath) {
  const fontSize = Math.round(WIDTH / 16);
  const fadeInEnd = 0.4;
  const holdEnd = 2.6;
  const fadeOutEnd = 3.0;
  const alphaExpr =
    `if(lt(t,${fadeInEnd}),t/${fadeInEnd},` +
    `if(lt(t,${holdEnd}),1,` +
    `if(lt(t,${fadeOutEnd}),(${fadeOutEnd}-t)/${fadeOutEnd - holdEnd},0)))`;

  return (
    `[outv]drawtext=fontfile='${escapeFilterPath(FONT_PATH)}':` +
    `textfile='${escapeFilterPath(catchphraseTextPath)}':` +
    `fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.45:boxborderw=24:` +
    `x=(w-text_w)/2:y=h*0.78:alpha='${alphaExpr}'[outv_text]`
  );
}

function resolveSePath(musicMood) {
  const candidatePath = path.join(SE_DIR, `${musicMood}.mp3`);
  return existsSync(candidatePath) ? candidatePath : null;
}

// 予告編風の可変ショット数パイプライン: 写真→ショットごとのクロップ・ズーム・パン・色味・ヴィネット→
// ショットごとに違うトランジションで連結→SEミックス→mp4。styleResult(selectStyle.jsがAIまたは
// デフォルトで決める)に従って、ショットごとの演出とテンポ・SEを切り替える。実際の描画処理
// (力仕事)はすべてFFmpeg側が担う。
export function generateVideo({ shotImagePaths, outPath, styleResult }) {
  if (!shotImagePaths || shotImagePaths.length === 0) {
    return Promise.reject(new Error('shotImagePaths is empty'));
  }
  if (!styleResult?.shots || styleResult.shots.length !== shotImagePaths.length) {
    return Promise.reject(new Error('styleResult.shots must match shotImagePaths length'));
  }

  const { filters: videoFilters, cutOffsetsSeconds, totalDurationSeconds } = buildVideoFilterGraph(
    shotImagePaths,
    styleResult.shots,
    styleResult.tempo
  );

  const bgPath = resolveSePath(styleResult.music_mood);
  const hitPath = resolveHitSePath(styleResult.music_mood);
  const audioPlan = buildAudioPlan({
    cutOffsetsSeconds,
    bgPath,
    hitPath,
    videoInputCount: shotImagePaths.length,
    totalDurationSeconds,
  });

  // キャッチコピーはAIが「似合う」と判断したときだけ(catchphrase_shown)重ねる。
  const catchphraseText = styleResult.catchphrase_text?.trim();
  const showCatchphrase = Boolean(styleResult.catchphrase_shown && catchphraseText);
  const catchphraseTextPath = showCatchphrase ? `${outPath}.catchphrase.txt` : null;
  if (catchphraseTextPath) {
    writeFileSync(catchphraseTextPath, catchphraseText, 'utf-8');
  }

  const allFilters = audioPlan ? [...videoFilters, ...audioPlan.filters] : [...videoFilters];
  if (showCatchphrase) {
    allFilters.push(buildCatchphraseFilter(catchphraseTextPath));
  }
  const finalVideoLabel = showCatchphrase ? '[outv_text]' : '[outv]';

  const cleanup = () => {
    if (catchphraseTextPath && existsSync(catchphraseTextPath)) {
      unlinkSync(catchphraseTextPath);
    }
  };

  return new Promise((resolve, reject) => {
    const command = ffmpeg();

    shotImagePaths.forEach((imagePath) => {
      // -tは付けない(無限ループの静止画入力にして、フィルタ側のtrimで長さを確定する)
      command.input(imagePath).inputOptions(['-loop 1', `-framerate ${FPS}`]);
    });

    if (audioPlan) {
      audioPlan.extraInputs.forEach((inputPath) => command.input(inputPath));
    }

    const outputOptions = [
      '-map', finalVideoLabel,
      ...(audioPlan ? ['-map', '[outa]'] : []),
      '-c:v', 'libx264',
      // Renderの無料プラン(RAM 512MB)向けにメモリ・CPU負荷を下げる設定
      '-preset', 'veryfast',
      '-threads', '1',
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
      .on('error', (err) => {
        cleanup();
        reject(err);
      })
      .on('end', () => {
        cleanup();
        resolve(outPath);
      })
      .save(outPath);
  });
}
