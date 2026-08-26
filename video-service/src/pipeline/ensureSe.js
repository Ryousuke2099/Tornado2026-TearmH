import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';

ffmpeg.setFfmpegPath(ffmpegPath);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SE_DIR = path.join(__dirname, '..', '..', 'assets', 'se');

// 外部のロイヤリティフリー素材が用意できるまでの仮SE。カット切り替え時に鳴らす短い
// 「衝撃音(サイン波のthump + ノイズのhiss)」をFFmpegの音声合成だけで作る。
// 実素材(assets/se/{mood}.mp3)が用意され次第、buildVideo.js側でそちらを優先して使う。
const HIT_PRESETS = {
  calm: { thumpFreq: 220, thumpDur: 0.12, noiseDur: 0.08, noiseHighpass: 4000, volume: 0.5 },
  nostalgic: { thumpFreq: 180, thumpDur: 0.18, noiseDur: 0.1, noiseHighpass: 3000, volume: 0.6 },
  upbeat: { thumpFreq: 300, thumpDur: 0.1, noiseDur: 0.12, noiseHighpass: 2500, volume: 0.8 },
  dramatic: { thumpFreq: 90, thumpDur: 0.3, noiseDur: 0.18, noiseHighpass: 1800, volume: 1.0 },
};

function hitPath(mood) {
  return path.join(SE_DIR, `${mood}-hit.mp3`);
}

function synthesizeHit(mood) {
  const preset = HIT_PRESETS[mood];
  const outPath = hitPath(mood);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(`sine=frequency=${preset.thumpFreq}:duration=${preset.thumpDur}`)
      .inputOptions(['-f', 'lavfi'])
      .input(`anoisesrc=color=white:duration=${preset.noiseDur}`)
      .inputOptions(['-f', 'lavfi'])
      .complexFilter([
        `[0:a]afade=t=out:st=0:d=${preset.thumpDur},volume=${preset.volume}[thump]`,
        `[1:a]afade=t=out:st=0:d=${preset.noiseDur},highpass=f=${preset.noiseHighpass},volume=${preset.volume * 0.5}[hiss]`,
        '[thump][hiss]amix=inputs=2:duration=longest[se]',
      ])
      .outputOptions(['-map', '[se]'])
      .audioCodec('libmp3lame')
      .on('error', reject)
      .on('end', () => resolve(outPath))
      .save(outPath);
  });
}

// サーバー起動時に1回だけ呼び、4つのmusic_mood分のヒット音が無ければ生成しておく。
export async function ensureSeAssets() {
  if (!existsSync(SE_DIR)) mkdirSync(SE_DIR, { recursive: true });
  for (const mood of Object.keys(HIT_PRESETS)) {
    if (!existsSync(hitPath(mood))) {
      await synthesizeHit(mood);
    }
  }
}

export function resolveHitSePath(mood) {
  const candidate = hitPath(mood);
  return existsSync(candidate) ? candidate : null;
}
