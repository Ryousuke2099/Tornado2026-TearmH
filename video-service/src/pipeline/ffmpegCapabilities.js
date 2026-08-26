import { execFileSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

// ffmpeg-staticが配布するバイナリは、プラットフォームによって同梱されているフィルタが違う
// (例: RenderのLinuxバイナリではdrawtext/freetypeが入っていない、といったことが起こりうる)。
// 存在しないフィルタをfilter_complexに含めると"Filter not found"で動画生成全体が失敗するため、
// 起動時に一度だけ`ffmpeg -filters`を実行し、実際に使えるフィルタ名の集合をキャッシュしておく。
let cachedFilters = null;

const FILTER_LINE = /^\s*\S{1,3}\s+(\S+)\s+\S*->\S*/;

function loadAvailableFilters() {
  try {
    const output = execFileSync(ffmpegPath, ['-filters'], { encoding: 'utf-8' });
    const names = new Set();
    for (const line of output.split('\n')) {
      const match = line.match(FILTER_LINE);
      if (match) names.add(match[1]);
    }
    return names;
  } catch (err) {
    console.error('[ffmpegCapabilities] フィルタ一覧の取得に失敗:', err.message ?? err);
    return new Set();
  }
}

export function hasFilter(name) {
  if (!cachedFilters) cachedFilters = loadAvailableFilters();
  return cachedFilters.has(name);
}
