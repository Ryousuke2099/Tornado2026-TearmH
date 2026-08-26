"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";

const VIDEO_SERVICE_URL =
  process.env.NEXT_PUBLIC_VIDEO_SERVICE_URL ?? "http://localhost:4000";

type ShotStyle = {
  focus_bias: string;
  motion: string;
  pan_direction: string;
  zoom_intensity: string;
  color_grade: string;
  vignette: boolean;
  transition_in: string;
};

type Style = {
  tempo: string;
  music_mood: string;
  reasoning: string;
  ai_used: boolean;
  ai_provider?: string;
  shots: ShotStyle[];
};

type GenerateResponse = {
  jobId: string;
  videoUrl: string;
  style: Style;
};

export default function Home() {
  const [photos, setPhotos] = useState<File[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [style, setStyle] = useState<Style | null>(null);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setPhotos(Array.from(event.target.files ?? []));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (photos.length === 0) return;

    setStatus("loading");
    setErrorMessage(null);
    setVideoUrl(null);
    setStyle(null);

    const formData = new FormData();
    photos.forEach((photo) => formData.append("photos", photo));

    try {
      const res = await fetch(`${VIDEO_SERVICE_URL}/generate`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `動画生成に失敗しました(status ${res.status})`);
      }

      const data: GenerateResponse = await res.json();
      setVideoUrl(`${VIDEO_SERVICE_URL}${data.videoUrl}`);
      setStyle(data.style);
      setStatus("idle");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center bg-zinc-50 px-6 py-16 font-sans dark:bg-black">
      <main className="flex w-full max-w-xl flex-col gap-8">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
            交換日記(写真→動画)プロトタイプ
          </h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            その日撮った写真をアップすると、予告編風のショート動画を生成します。
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileChange}
            className="rounded-lg border border-zinc-300 bg-white p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          {photos.length > 0 && (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {photos.length}枚の写真を選択中
            </p>
          )}
          <button
            type="submit"
            disabled={photos.length === 0 || status === "loading"}
            className="rounded-full bg-zinc-950 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            {status === "loading" ? "生成中..." : "動画を生成する"}
          </button>
        </form>

        {status === "error" && errorMessage && (
          <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
        )}

        {videoUrl && (
          <video
            key={videoUrl}
            src={videoUrl}
            controls
            className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800"
          />
        )}

        {style && (
          <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
            <p className="font-medium text-zinc-950 dark:text-zinc-50">
              {style.ai_used ? `AIが選んだスタイル(${style.ai_provider ?? "AI"})` : "デフォルトスタイル(AI未使用)"}
            </p>
            <p className="mt-1 text-zinc-600 dark:text-zinc-400">{style.reasoning}</p>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-zinc-600 dark:text-zinc-400">
              <dt>テンポ</dt>
              <dd>{style.tempo}</dd>
              <dt>SEの雰囲気</dt>
              <dd>{style.music_mood}</dd>
            </dl>
            <p className="mt-4 font-medium text-zinc-950 dark:text-zinc-50">
              ショットごとの演出({style.shots.length}カット)
            </p>
            <ol className="mt-2 flex flex-col gap-2">
              {style.shots.map((shot, i) => (
                <li
                  key={i}
                  className="rounded border border-zinc-200 p-2 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400"
                >
                  #{i + 1}: {shot.motion} / {shot.focus_bias} / パン{shot.pan_direction} / ズーム
                  {shot.zoom_intensity} / {shot.color_grade} / ヴィネット{shot.vignette ? "あり" : "なし"}
                  {i > 0 && ` / トランジション${shot.transition_in}`}
                </li>
              ))}
            </ol>
          </div>
        )}
      </main>
    </div>
  );
}
