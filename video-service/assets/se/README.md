# SE素材

- `{mood}-hit.mp3`(calm/nostalgic/upbeat/dramatic): カット切り替え時に鳴る短い衝撃音。
  `ensureSe.js`がサーバー起動時にFFmpegの音声合成だけで自動生成する仮素材(gitignore済み、
  リポジトリには含まれない)。削除しても次回起動時に再生成される。
- `{mood}.mp3`(例: `nostalgic.mp3`): 背景BGMとして流したい場合に手動で置く本番用の実素材。
  Pixabay / freesoundなどロイヤリティフリー素材を想定。未配置でも動作は壊れない
  (`buildVideo.js`が自動検出し、無ければそのSEなしで生成する)。
