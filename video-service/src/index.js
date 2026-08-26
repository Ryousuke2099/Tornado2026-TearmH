import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { generateVideo } from './pipeline/buildVideo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
// SEを置く場所。ファイルが無い場合は無音で生成する(pipeline/buildVideo.js側でフォールバック済み)。
const DEFAULT_SE_PATH = path.join(__dirname, '..', 'assets', 'se', 'default.mp3');

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
    await generateVideo({ photoPaths, outPath, sePath: DEFAULT_SE_PATH });
    res.json({ jobId, videoUrl: `/output/${jobId}.mp4` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '動画生成に失敗しました', detail: String(err) });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`video-service listening on :${PORT}`);
});
