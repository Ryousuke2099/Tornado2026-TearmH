import type { MetadataRoute } from "next";

// PWA としてホーム画面に追加できるようにする最小マニフェスト。
// インストールされていると iOS でも Web Push が使えるようになる(16.4+)ので、
// 撮影nudge を将来 Web Push 化するときの前提としてここで用意しておく。
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Woolink 交換日記",
    short_name: "Woolink",
    description: "その日の写真を予告編風の動画にして交換する日記アプリ",
    start_url: "/",
    display: "standalone",
    background_color: "#14131c",
    theme_color: "#14131c",
    icons: [
      { src: "/nudge-icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
