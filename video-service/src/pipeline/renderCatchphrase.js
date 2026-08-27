import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_PATH = path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansJP.ttf');

function escapePangoMarkup(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// FFmpegの`drawtext`(freetype同梱ビルドが必要)はRenderのffmpeg-staticバイナリに
// 入っておらず"Filter not found"で失敗した。sharpは自前でPango/freetypeを同梱した
// ビルドを使っており環境に依存せず動くため、ここでテキストを透過PNG画像として描画し、
// buildVideo.js側ではほぼ全ビルドに入っている基本機能の`overlay`フィルタで動画に重ねる。
//
// 戻り値のboxHeightは、呼び出し側がoverlayのy座標(画面のどこに配置するか)を
// 計算するために使う。
export async function renderCatchphraseImage({ text, videoWidth, outPath }) {
  const fontSize = Math.round(videoWidth / 16);
  const textImage = sharp({
    text: {
      text: `<span foreground="white" font="${fontSize}">${escapePangoMarkup(text)}</span>`,
      fontfile: FONT_PATH,
      width: videoWidth - 80,
      rgba: true,
      align: 'center',
    },
  });
  const textBuffer = await textImage.png().toBuffer();
  const textMeta = await sharp(textBuffer).metadata();

  const paddingY = 24;
  const boxHeight = textMeta.height + paddingY * 2;

  await sharp({
    create: {
      width: videoWidth,
      height: boxHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0.45 },
    },
  })
    .composite([{ input: textBuffer, left: Math.round((videoWidth - textMeta.width) / 2), top: paddingY }])
    .png()
    .toFile(outPath);

  return { boxHeight };
}
