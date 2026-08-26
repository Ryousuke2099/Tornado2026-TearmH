import sharp from 'sharp';
import { writeFile, rename } from 'node:fs/promises';

// スマホ写真(1000万画素超も珍しくない)をそのままFFmpegに渡すと、デコードだけで
// Renderの無料プラン(RAM 512MB)のメモリ上限を超えてOOM Kill(exit 137)を起こす。
// アップロード直後に上限サイズまで縮小しておくことで、AI(Gemini/Claude)に送る
// 画像サイズも小さくなり、FFmpeg側のデコード負荷も下がる。
const MAX_DIMENSION = 1600;

// 1枚ずつ順番に処理する(Promise.allで並列化すると、大きな画像を同時に何枚も
// メモリに載せることになり、縮小前に対策したいOOM問題を悪化させてしまう)。
export async function resizePhotosInPlace(filePaths) {
  for (const filePath of filePaths) {
    const buffer = await sharp(filePath)
      .rotate() // EXIFの回転情報を反映してから縮小する
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    // 読み込み元と同じパスへ直接書き戻すと、Windowsではsharpがまだ保持しているファイル
    // ハンドルと衝突して書き込みに失敗することがある。一時ファイルに書いてからrenameする。
    const tmpPath = `${filePath}.resized`;
    await writeFile(tmpPath, buffer);
    await rename(tmpPath, filePath);
  }
}
