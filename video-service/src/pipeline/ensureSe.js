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

// 背景BGM(ループ用の短いループ素材)。複数のsine波を和音として重ね、tremoloで音量を
// 揺らすことで単調なビープ音ではなく持続的なパッドっぽい響きにしている。
// duration(秒)×frequency(Hz)・duration×tremoloFreqが必ず整数になる値を選んでおくことで、
// ループの継ぎ目(-stream_loop -1で無限ループさせる際の境界)で波形が0または同じ位相に戻り、
// ブツ切れnoiseが聞こえないようにしている。
const BGM_PRESETS = {
  calm: {
    duration: 8,
    tones: [
      { freq: 220, vol: 0.22 },
      { freq: 330, vol: 0.16 },
    ],
    tremoloFreq: 0.25,
    tremoloDepth: 0.25,
  },
  nostalgic: {
    duration: 8,
    tones: [
      { freq: 196, vol: 0.18 },
      { freq: 247, vol: 0.14 },
      { freq: 294, vol: 0.12 },
    ],
    tremoloFreq: 0.25,
    tremoloDepth: 0.2,
  },
  upbeat: {
    duration: 8,
    tones: [
      { freq: 392, vol: 0.22 },
      { freq: 523, vol: 0.16 },
    ],
    tremoloFreq: 0.5,
    tremoloDepth: 0.45,
  },
  dramatic: {
    duration: 8,
    tones: [
      { freq: 65, vol: 0.3 },
      { freq: 98, vol: 0.2 },
    ],
    tremoloFreq: 0.25,
    tremoloDepth: 0.35,
  },
};

function hitPath(mood) {
  return path.join(SE_DIR, `${mood}-hit.mp3`);
}

function bgmPath(mood) {
  return path.join(SE_DIR, `${mood}.mp3`);
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

function synthesizeBgm(mood) {
  const preset = BGM_PRESETS[mood];
  const outPath = bgmPath(mood);
  return new Promise((resolve, reject) => {
    const command = ffmpeg();
    preset.tones.forEach((tone) => {
      command.input(`sine=frequency=${tone.freq}:duration=${preset.duration}`).inputOptions(['-f', 'lavfi']);
    });
    const toneFilters = preset.tones.map((tone, i) => `[${i}:a]volume=${tone.vol}[t${i}]`);
    const mixInputs = preset.tones.map((_, i) => `[t${i}]`).join('');
    const filters = [
      ...toneFilters,
      `${mixInputs}amix=inputs=${preset.tones.length}:duration=longest,` +
        `tremolo=f=${preset.tremoloFreq}:d=${preset.tremoloDepth}[bgm]`,
    ];
    command
      .complexFilter(filters)
      .outputOptions(['-map', '[bgm]'])
      .audioCodec('libmp3lame')
      .on('error', reject)
      .on('end', () => resolve(outPath))
      .save(outPath);
  });
}

// サーバー起動時に1回だけ呼び、4つのmusic_mood分のヒット音・BGMループが無ければ生成しておく。
export async function ensureSeAssets() {
  if (!existsSync(SE_DIR)) mkdirSync(SE_DIR, { recursive: true });
  for (const mood of Object.keys(HIT_PRESETS)) {
    if (!existsSync(hitPath(mood))) {
      await synthesizeHit(mood);
    }
    if (!existsSync(bgmPath(mood))) {
      await synthesizeBgm(mood);
    }
  }
}

export function resolveHitSePath(mood) {
  const candidate = hitPath(mood);
  return existsSync(candidate) ? candidate : null;
}
