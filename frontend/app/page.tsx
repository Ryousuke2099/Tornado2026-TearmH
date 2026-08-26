"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";

const VIDEO_SERVICE_URL =
  process.env.NEXT_PUBLIC_VIDEO_SERVICE_URL ?? "http://localhost:4000";

type GenerateResponse = {
  jobId: string;
  videoUrl: string;
};

export default function Home() {
  const [photos, setPhotos] = useState<File[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setPhotos(Array.from(event.target.files ?? []));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (photos.length === 0) return;

    setStatus("loading");
    setErrorMessage(null);
    setVideoUrl(null);

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
      </main>
    </div>
  );
}
