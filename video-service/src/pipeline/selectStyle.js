import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// video-pipeline-tech-stack.mdの「AIの役割: FFmpegとユーザーの『懸け橋』」案の実装。
// AIは動画そのものを生成せず、FFmpeg側に用意した「型」の中からどれを使うかをJSONで判断するだけ。
//
// 2026-08-26改訂: 当初は動画全体に1つのスタイルを適用していたが、「全カット同じ演出で単調」との
// 指摘を受け、ショット(カット)ごとに違う演出をAIに選ばせる設計に変更。写真の中身(人物中心か
// 風景か、明るいか暗いか等)を見てショットごとに判断させることで、同じ写真セットでも毎回違う
// 組み合わせの動画になる。
//
// 2026-08-27改訂: Anthropic APIのクレジット残高不足で動作確認できなかったため、無料枠のある
// Gemini APIを優先的に使う構成に変更(GEMINI_API_KEYがあればGemini、無ければANTHROPIC_API_KEY、
// どちらも無ければデフォルトスタイル、の順にフォールバックする)。

const CLAUDE_MODEL = 'claude-sonnet-5';
const GEMINI_MODEL = 'gemini-3.6-flash';

// xfadeのtransition種別は多数あるが、動作確認済みの見た目が分かりやすいものだけに絞る。
const TRANSITIONS = [
  'fade', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight',
  'slideup', 'slidedown', 'circleopen', 'dissolve', 'pixelize',
];
const PAN_DIRECTIONS = ['up-left', 'up-right', 'down-left', 'down-right', 'none'];
const ZOOM_INTENSITIES = ['subtle', 'moderate', 'strong'];
const COLOR_GRADES = ['warm', 'cool', 'vintage', 'vivid', 'monochrome'];
const FOCUS_BIASES = ['face', 'background', 'balanced'];
const MUSIC_MOODS = ['calm', 'nostalgic', 'upbeat', 'dramatic'];
const TEMPOS = ['slow', 'medium', 'fast'];
// 「演出をズームに固定するな」との指摘を受けて追加。buildVideo.jsのMOTION_TYPESと値を揃えること。
const MOTIONS = ['zoom_in', 'zoom_out', 'static', 'pan_only'];

function buildShotItemSchema() {
  return {
    type: 'object',
    properties: {
      focus_bias: { type: 'string', enum: FOCUS_BIASES, description: 'この写真は人物(顔)中心か、風景・情景中心か' },
      motion: {
        type: 'string',
        enum: MOTIONS,
        description: '動きの種類。zoom_in=ズームイン、zoom_out=ズームアウト、static=静止、pan_only=ズームなしでパンのみ',
      },
      pan_direction: { type: 'string', enum: PAN_DIRECTIONS, description: 'パンする方向(motionがstaticの場合は無視される)' },
      zoom_intensity: { type: 'string', enum: ZOOM_INTENSITIES, description: 'ズームの強さ(motionがstaticの場合は無視される)' },
      color_grade: { type: 'string', enum: COLOR_GRADES, description: 'この写真に合う色味' },
      vignette: { type: 'boolean', description: '画面周辺を暗くする映画的な効果を入れるか' },
      grain: { type: 'boolean', description: 'フィルムグレイン(粒状ノイズ)を乗せてシネマティックな質感を出すか' },
      transition_in: {
        type: 'string',
        enum: TRANSITIONS,
        description: '前のショットからこのショットへ切り替わる時のトランジション種類(最初のショットでは無視される)',
      },
    },
    required: ['focus_bias', 'motion', 'pan_direction', 'zoom_intensity', 'color_grade', 'vignette', 'grain', 'transition_in'],
  };
}

function buildStyleSchema(shotCount) {
  return {
    type: 'object',
    properties: {
      tempo: { type: 'string', enum: TEMPOS, description: 'カット切り替えの速さ(動画全体で共通)。落ち着いた1日ならslow、賑やかな1日ならfast' },
      music_mood: { type: 'string', enum: MUSIC_MOODS, description: '合わせるSE(効果音)の雰囲気(動画全体で共通)' },
      reasoning: { type: 'string', description: '全体の判断理由を日本語1〜2文で(ユーザーに見せる用)' },
      catchphrase_shown: {
        type: 'boolean',
        description: '動画の冒頭にキャッチコピーの文字を重ねるかどうか。写真の雰囲気に合う場合のみtrue',
      },
      catchphrase_text: {
        type: 'string',
        description: '冒頭に表示する日本語のキャッチコピー。14文字以内の短い1行。catchphrase_shownがfalseなら空文字でよい',
      },
      shots: {
        type: 'array',
        minItems: shotCount,
        maxItems: shotCount,
        description: `ショットごとの演出。写真の順番通りに、必ず${shotCount}件返す`,
        items: buildShotItemSchema(),
      },
    },
    required: ['tempo', 'music_mood', 'reasoning', 'catchphrase_shown', 'catchphrase_text', 'shots'],
  };
}

function defaultShotStyle(i) {
  // AI未使用時のフォールバック。単調にならない程度にインデックスで多少ずらす。
  const pan = PAN_DIRECTIONS[i % (PAN_DIRECTIONS.length - 1)]; // 'none'は使わない
  const transition = TRANSITIONS[i % TRANSITIONS.length];
  const motion = MOTIONS[i % MOTIONS.length];
  return {
    focus_bias: 'balanced',
    motion,
    pan_direction: pan,
    zoom_intensity: 'moderate',
    color_grade: 'vivid',
    vignette: false,
    grain: i % 2 === 0,
    transition_in: transition,
  };
}

export function buildDefaultStyle(shotCount) {
  return {
    tempo: 'medium',
    music_mood: 'nostalgic',
    reasoning: '(AI未使用のデフォルト設定)',
    catchphrase_shown: false,
    catchphrase_text: '',
    ai_used: false,
    shots: Array.from({ length: shotCount }, (_, i) => defaultShotStyle(i)),
  };
}

function readImage(filePath) {
  const buffer = readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mediaType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return { buffer, mediaType };
}

function toAnthropicImageBlock(filePath) {
  const { buffer, mediaType } = readImage(filePath);
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } };
}

function toGeminiImagePart(filePath) {
  const { buffer, mediaType } = readImage(filePath);
  return { inlineData: { mimeType: mediaType, data: buffer.toString('base64') } };
}

function buildPromptText(shotCount, isSinglePhotoFallback) {
  const catchphraseNote =
    '動画冒頭に短い日本語キャッチコピーを重ねるかどうかも判断してください。' +
    '写真の雰囲気に合う一言が思いつく場合だけcatchphrase_shownをtrueにし、' +
    '14文字以内の短い1行をcatchphrase_textに入れてください。無理に付けなくてよく、' +
    '合わないと感じたらcatchphrase_shownはfalse、catchphrase_textは空文字にしてください。';

  return (
    (isSinglePhotoFallback
      ? `これは交換日記アプリのための写真です。写真が1枚しかないため、同じ写真を${shotCount}個の異なる` +
        'クロップ・演出でショットとして使い、疑似的に複数カットの予告編風動画にします。' +
        `shotsには順番に${shotCount}件、それぞれ違うfocus_bias/motion/pan_direction/zoom_intensity/color_gradeの` +
        '組み合わせを選び、単調にならないようにしてください(1件目はtransition_inを無視して構いません)。'
      : 'これは交換日記アプリのために、ある人が今日撮った写真です。写真は時系列の順番で並んでいます。' +
        `shotsには写真の順番通りに${shotCount}件返してください。それぞれの写真の内容・雰囲気・` +
        '被写体(人物中心か景色中心か)に合わせて、ショットごとに違う演出を判断してください' +
        '(全ショット同じ組み合わせにならないよう変化をつけてください。1件目のtransition_inは無視されます)。') +
    catchphraseNote
  );
}

function validateShots(shots, shotCount) {
  return Array.isArray(shots) && shots.length === shotCount;
}

let anthropicClient = null;
function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropicClient) anthropicClient = new Anthropic();
  return anthropicClient;
}

let geminiClient = null;
function getGeminiClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!geminiClient) geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return geminiClient;
}

async function selectStyleWithGemini(uniquePaths, promptText, shotCount) {
  const genAI = getGeminiClient();
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: buildStyleSchema(shotCount),
    },
  });

  const result = await model.generateContent([...uniquePaths.map(toGeminiImagePart), { text: promptText }]);
  const parsed = JSON.parse(result.response.text());
  if (!validateShots(parsed?.shots, shotCount)) return null;
  return parsed;
}

async function selectStyleWithClaude(uniquePaths, promptText, shotCount) {
  const anthropic = getAnthropicClient();
  const tool = {
    name: 'select_style',
    description: '写真ごとの内容や雰囲気から、予告編風動画のショットごとの演出と全体のテンポ・SEを選ぶ',
    input_schema: buildStyleSchema(shotCount),
  };

  const message = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'select_style' },
    messages: [
      { role: 'user', content: [...uniquePaths.map(toAnthropicImageBlock), { type: 'text', text: promptText }] },
    ],
  });

  const toolUse = message.content.find((block) => block.type === 'tool_use');
  if (!toolUse || !validateShots(toolUse.input?.shots, shotCount)) return null;
  return toolUse.input;
}

// shotImagePaths: resolveShotImagePaths()が決めた「ショットごとの元画像パス」(1枚の写真から
// 複数ショットを作る場合は同じパスが重複する)。重複は除いて画像はAPIに1回だけ送り、
// テキストで「同じ写真が複数ショットに使われる」ことを伝えることでトークンコストを抑える。
//
// GEMINI_API_KEY→ANTHROPIC_API_KEYの順で使う(Geminiは無料枠があるため優先)。
// どちらも無い、またはAPI呼び出しに失敗した場合はデフォルトスタイルにフォールバックし、
// 動画生成自体は止まらないようにする。
export async function selectStyle(shotImagePaths) {
  const shotCount = shotImagePaths.length;
  const uniquePaths = [...new Set(shotImagePaths)];
  const isSinglePhotoFallback = uniquePaths.length === 1 && shotCount > 1;
  const promptText = buildPromptText(shotCount, isSinglePhotoFallback);

  if (getGeminiClient()) {
    try {
      const result = await selectStyleWithGemini(uniquePaths, promptText, shotCount);
      if (result) return { ...result, ai_used: true, ai_provider: 'gemini' };
      console.warn('[selectStyle] Geminiが想定と異なるレスポンスを返したためデフォルトスタイルを使用');
    } catch (err) {
      console.error('[selectStyle] Gemini呼び出しに失敗:', err.message ?? err);
    }
  }

  if (getAnthropicClient()) {
    try {
      const result = await selectStyleWithClaude(uniquePaths, promptText, shotCount);
      if (result) return { ...result, ai_used: true, ai_provider: 'claude' };
      console.warn('[selectStyle] Claudeが想定と異なるレスポンスを返したためデフォルトスタイルを使用');
    } catch (err) {
      console.error('[selectStyle] Claude呼び出しに失敗:', err.message ?? err);
    }
  }

  console.warn('[selectStyle] AIが使えないためデフォルトスタイルを使用');
  return buildDefaultStyle(shotCount);
}
