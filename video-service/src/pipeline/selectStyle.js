import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// video-pipeline-tech-stack.mdの「AIの役割: FFmpegとユーザーの『懸け橋』」案の実装。
// AIは動画そのものを生成せず、その日の写真を見てFFmpeg側に用意した「スタイルの型」の
// どれが合うかをJSONで判断するだけ(力仕事はFFmpegに残す設計)。

const MODEL = 'claude-sonnet-5';
const MAX_PHOTOS_FOR_AI = 5;

export const DEFAULT_STYLE = {
  tempo: 'medium',
  color_grade: 'vivid',
  zoom_intensity: 'moderate',
  focus_bias: 'balanced',
  music_mood: 'nostalgic',
  reasoning: '(AI未使用のデフォルト設定)',
};

const STYLE_TOOL = {
  name: 'select_style',
  description: '写真の内容や雰囲気から、予告編風動画の編集スタイルパラメータを選ぶ',
  input_schema: {
    type: 'object',
    properties: {
      tempo: {
        type: 'string',
        enum: ['slow', 'medium', 'fast'],
        description: 'カット切り替えの速さ。落ち着いた1日ならslow、賑やかで出来事が多い1日ならfast',
      },
      color_grade: {
        type: 'string',
        enum: ['warm', 'cool', 'vintage', 'vivid', 'monochrome'],
        description: '色味の方向性',
      },
      zoom_intensity: {
        type: 'string',
        enum: ['subtle', 'moderate', 'strong'],
        description: 'ズームの強さ',
      },
      focus_bias: {
        type: 'string',
        enum: ['face', 'background', 'balanced'],
        description: '人物(顔)中心の写真が多いか、風景・情景中心の写真が多いか',
      },
      music_mood: {
        type: 'string',
        enum: ['calm', 'nostalgic', 'upbeat', 'dramatic'],
        description: '合わせるSE(効果音)の雰囲気',
      },
      reasoning: {
        type: 'string',
        description: 'この判断をした理由を日本語1文で(ユーザーに見せる用)',
      },
    },
    required: ['tempo', 'color_grade', 'zoom_intensity', 'focus_bias', 'music_mood', 'reasoning'],
  },
};

function toImageBlock(filePath) {
  const buffer = readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mediaType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') },
  };
}

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

// 写真を見てスタイルを判断する。APIキー未設定・呼び出し失敗時はデフォルトスタイルにフォールバックし、
// AIが使えない状態でも動画生成自体は止まらないようにする。
export async function selectStyle(photoPaths) {
  const anthropic = getClient();
  if (!anthropic) {
    console.warn('[selectStyle] ANTHROPIC_API_KEY未設定のためデフォルトスタイルを使用');
    return { ...DEFAULT_STYLE, ai_used: false };
  }

  try {
    const sampled = photoPaths.slice(0, MAX_PHOTOS_FOR_AI);
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      tools: [STYLE_TOOL],
      tool_choice: { type: 'tool', name: 'select_style' },
      messages: [
        {
          role: 'user',
          content: [
            ...sampled.map(toImageBlock),
            {
              type: 'text',
              text:
                'これは交換日記アプリのために、ある人が今日撮った写真です。写真の内容・雰囲気・時間帯・' +
                '被写体(人物中心か景色中心か)から、この日の動画をどんなスタイルの予告編風動画にするのが' +
                '合っているかを判断してください。',
            },
          ],
        },
      ],
    });

    const toolUse = message.content.find((block) => block.type === 'tool_use');
    if (!toolUse) {
      console.warn('[selectStyle] tool_useブロックが返らなかったためデフォルトスタイルを使用');
      return { ...DEFAULT_STYLE, ai_used: false };
    }
    return { ...DEFAULT_STYLE, ...toolUse.input, ai_used: true };
  } catch (err) {
    console.error('[selectStyle] AI呼び出しに失敗、デフォルトスタイルにフォールバック:', err.message ?? err);
    return { ...DEFAULT_STYLE, ai_used: false };
  }
}
