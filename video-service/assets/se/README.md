# SE素材

- `{mood}-hit.mp3`(calm/nostalgic/upbeat/dramatic): カット切り替え時に鳴る短い衝撃音。
  `ensureSe.js`がFFmpegの`lavfi`(sine/anoisesrc)で合成した仮素材。RenderのLinux版
  ffmpeg-staticには`lavfi`自体が入っておらず("Input formats lavfi, lavfi are not available")
  本番環境では合成できないため、ローカル(lavfiが使えるWindows版)で生成した結果をリポジトリに
  コミットして配布している。削除するとRender上では音無しに戻ってしまうので注意。
- `{mood}.mp3`(例: `nostalgic.mp3`): 背景BGMとして流したい場合に手動で置く本番用の実素材。
  Pixabay / freesoundなどロイヤリティフリー素材を想定。未配置でも動作は壊れない
  (`buildVideo.js`が自動検出し、無ければそのSEなしで生成する)。
