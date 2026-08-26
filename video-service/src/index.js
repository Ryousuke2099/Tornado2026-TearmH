import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { generateVideo } from './pipeline/buildVideo.js';
import { selectStyle } from './pipeline/selectStyle.js';
import { ensureSeAssets } from './pipeline/ensureSe.js';
import { resolveShotImagePaths } from './pipeline/planShots.js';
import { resizePhotosInPlace } from './pipeline/resizePhotos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

// gitは空ディレクトリを追跡しないため、ローカルでは手動で作っていたuploads/output/が
// Render等の本番環境には存在しない状態でデプロイされる。起動時に必ず作成する。
mkdirSync(UPLOAD_DIR, { recursive: true });
mkdirSync(OUTPUT_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use('/output', express.static(OUTPUT_DIR));

const upload = multer({ dest: UPLOAD_DIR });

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/generate', upload.array('photos', 20), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    res.status(400).json({ error: '写真が1枚も届いていません(multipart/form-dataの photos フィールドで送ってください)' });
    return;
  }

  const jobId = randomUUID();
  const outPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);
  const photoPaths = req.files.map((f) => f.path);

  try {
    // 高解像度のスマホ写真をそのまま扱うとOOMの原因になるため、先に上限サイズへ縮小する。
    await resizePhotosInPlace(photoPaths);
    // 「どの写真をどのショットに使うか」を先に決めてから、AIにショットごとの演出を判断させる。
    // AIはFFmpegに渡すスタイルパラメータ(JSON)を選ぶだけで、動画そのものは生成しない。
    const shotImagePaths = resolveShotImagePaths(photoPaths);
    const styleResult = await selectStyle(shotImagePaths);
    await generateVideo({ shotImagePaths, outPath, styleResult });
    res.json({ jobId, videoUrl: `/output/${jobId}.mp4`, style: styleResult });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '動画生成に失敗しました', detail: String(err) });
  }
});

const PORT = process.env.PORT || 4000;
ensureSeAssets()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`video-service listening on :${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[ensureSeAssets] SE合成に失敗、無音のまま起動します:', err.message ?? err);
    app.listen(PORT, () => {
      console.log(`video-service listening on :${PORT}`);
    });
  });
