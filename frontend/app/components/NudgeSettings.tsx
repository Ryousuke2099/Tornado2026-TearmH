"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NUDGE_PROMPTS, pickPrompt, slotForHour } from "@/lib/nudgePrompts";
import {
  MAX_TIMES,
  appendCapture,
  buildScheduleItems,
  computeStreak,
  loadLog,
  loadRecent,
  loadSettings,
  pushRecent,
  saveSettings,
  todayCaptureCount,
} from "@/lib/nudgeSchedule";

type Perm = NotificationPermission | "unsupported";

function readPerm(): Perm {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

export default function NudgeSettings() {
  // SSR では localStorage が無いので loadX() は既定値を返す。クライアントの初回レンダーで
  // 実際の値に置き換わる(このコンポーネントは ready まで null を返すので mismatch は起きない)。
  const [ready, setReady] = useState(false);
  const [perm, setPerm] = useState<Perm>(() => readPerm());
  const [times, setTimes] = useState<string[]>(() => loadSettings().times);
  const [log, setLog] = useState<number[]>(() => loadLog());
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [schedMsg, setSchedMsg] = useState<string>("");
  const pageTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const streak = useMemo(() => computeStreak(log), [log]);
  const today = useMemo(() => todayCaptureCount(log), [log]);

  const showLocal = useCallback((title: string, body: string) => {
    if (readPerm() !== "granted") return;
    navigator.serviceWorker?.ready
      .then((reg) =>
        reg.showNotification(title, { body, tag: "woolink-nudge", icon: "/nudge-icon.svg" }),
      )
      .catch(() => {
        new Notification(title, { body });
      });
  }, []);

  const schedule = useCallback(
    async (ts: string[]) => {
      const items = buildScheduleItems(ts);

      const reg = await navigator.serviceWorker?.ready.catch(() => null);
      if (reg && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: "SCHEDULE", items });
      }

      // ページが開いている間のフォールバック(SW が寝てもこのタブが生きていれば出る)
      pageTimers.current.forEach(clearTimeout);
      pageTimers.current = items
        .map((it) => {
          const delay = it.at - Date.now();
          if (delay <= 0 || delay > 24 * 3600 * 1000) return null;
          return setTimeout(() => showLocal(it.title, it.body), delay);
        })
        .filter((x): x is ReturnType<typeof setTimeout> => x !== null);

      // periodicSync(対応環境のみ。日次の保険)
      try {
        if (reg && "periodicSync" in reg) {
          const status = await navigator.permissions.query({
            name: "periodic-background-sync" as PermissionName,
          });
          if (status.state === "granted") {
            // @ts-expect-error periodicSync は型定義が未整備のブラウザAPI
            await reg.periodicSync.register("daily-nudge", { minInterval: 12 * 3600 * 1000 });
          }
        }
      } catch {
        /* 非対応環境は無視 */
      }

      items.forEach((i) => pushRecent(i.body));
      const soonest = items.map((i) => i.at).sort((a, b) => a - b)[0] ?? null;
      setNextAt(soonest);
      setSchedMsg(`${items.length}件を予約しました`);
    },
    [showLocal],
  );

  // マウント後: SW 登録 → 表示を有効化 → 許可済みなら予約。
  useEffect(() => {
    let cancelled = false;
    const timers = pageTimers.current;

    (async () => {
      if ("serviceWorker" in navigator) {
        try {
          await navigator.serviceWorker.register("/sw.js");
        } catch (e) {
          console.warn("SW register failed", e);
        }
      }
      if (cancelled) return;
      setPerm(readPerm());
      setReady(true);
      if (readPerm() === "granted") schedule(loadSettings().times);
    })();

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [schedule]);

  async function requestPerm() {
    if (!("Notification" in window)) return;
    const res = await Notification.requestPermission();
    setPerm(res);
    if (res === "granted") schedule(times);
  }

  function sendTest() {
    const slot = slotForHour(new Date().getHours());
    showLocal("Woolink", pickPrompt(slot, loadRecent()));
  }

  function updateTime(i: number, value: string) {
    setTimes((prev) => prev.map((t, idx) => (idx === i ? value : t)));
  }
  function addTime() {
    setTimes((prev) => (prev.length < MAX_TIMES ? [...prev, "21:00"] : prev));
  }
  function removeTime(i: number) {
    setTimes((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));
  }
  function save() {
    const clean = times.filter(Boolean);
    if (clean.length === 0) {
      setSchedMsg("時刻を1つ以上入れてください");
      return;
    }
    setTimes(clean);
    saveSettings({ times: clean });
    if (readPerm() === "granted") schedule(clean);
    else setSchedMsg("保存しました。通知を許可すると予約されます");
  }

  function markCaptured() {
    setLog([...appendCapture()]);
  }

  if (!ready) return null;

  const permLabel: Record<Perm, string> = {
    granted: "許可済み",
    denied: "ブロック中（ブラウザ設定から解除が必要）",
    default: "未設定",
    unsupported: "この環境では通知を使えません",
  };

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">撮影nudge</h2>
      <p className="mt-1 text-zinc-600 dark:text-zinc-400">
        「こういう場面で撮ろう」を日に数回そっと通知して、写真を撮る習慣をつくります。
      </p>

      {/* 通知の許可 */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={requestPerm}
          disabled={perm === "granted" || perm === "unsupported"}
          className="rounded-full bg-zinc-950 px-4 py-2 text-xs font-medium text-white disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-950"
        >
          通知を許可する
        </button>
        <button
          type="button"
          onClick={sendTest}
          disabled={perm !== "granted"}
          className="rounded-full border border-zinc-300 px-4 py-2 text-xs font-medium disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-100"
        >
          テスト通知
        </button>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">通知: {permLabel[perm]}</span>
      </div>

      {/* 時刻 */}
      <div className="mt-5">
        <p className="font-medium text-zinc-950 dark:text-zinc-50">時刻（1日 最大{MAX_TIMES}回）</p>
        <div className="mt-2 flex flex-col gap-2">
          {times.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="time"
                value={t}
                onChange={(e) => updateTime(i, e.target.value)}
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
              {times.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeTime(i)}
                  className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                >
                  削除
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={addTime}
            disabled={times.length >= MAX_TIMES}
            className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-100"
          >
            ＋ 時刻を追加
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded-full bg-zinc-950 px-4 py-1.5 text-xs font-medium text-white dark:bg-zinc-50 dark:text-zinc-950"
          >
            保存してスケジュール
          </button>
          {schedMsg && <span className="text-xs text-zinc-500 dark:text-zinc-400">{schedMsg}</span>}
        </div>
        {nextAt && (
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            次の通知:{" "}
            {new Date(nextAt).toLocaleString("ja-JP", {
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        )}
        <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
          タブを開いている間、および直前まで開いていた場合に届きます。完全に閉じた状態での定時配信は
          Web Push か PWA 化が必要（README 参照）。
        </p>
      </div>

      {/* 今日のかけら */}
      <div className="mt-5">
        <p className="font-medium text-zinc-950 dark:text-zinc-50">今日のかけら</p>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-bold text-zinc-950 dark:text-zinc-50">{streak}</span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            日連続 / 今日 <b>{today}</b> 枚
          </span>
        </div>
        <button
          type="button"
          onClick={markCaptured}
          className="mt-2 rounded-full bg-zinc-950 px-4 py-1.5 text-xs font-medium text-white dark:bg-zinc-50 dark:text-zinc-950"
        >
          撮った
        </button>
      </div>

      {/* prompt の候補 */}
      <details className="mt-5">
        <summary className="cursor-pointer text-xs font-medium text-zinc-600 dark:text-zinc-400">
          promptの候補（{NUDGE_PROMPTS.length}件）
        </summary>
        <ul className="mt-2 flex flex-col gap-1">
          {NUDGE_PROMPTS.map((p) => (
            <li key={p.text} className="text-xs text-zinc-500 dark:text-zinc-400">
              ・{p.text}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
