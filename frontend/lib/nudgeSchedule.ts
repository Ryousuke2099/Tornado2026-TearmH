// 撮影nudge のスケジュール計算と永続化(localStorage)。
// フレームワーク非依存の純関数群にして、コンポーネント(NudgeSettings.tsx)と
// Service Worker の両方から使える形にしている。
//
// 制約: タブ/SW が完全に止まると setTimeout ベースの予約は消える。確実な定時配信には
// Web Push(VAPID + 配信サーバ)か PWA インストール + OS通知が必要。README 参照。

import { pickPrompt, slotForHour } from "./nudgePrompts";

export const SETTINGS_KEY = "woolink_nudge_settings";
export const LOG_KEY = "woolink_nudge_log";
export const RECENT_KEY = "woolink_nudge_recent";

/** 昼・夜・寝る前。杉谷FBの「日に数回」を意識した既定値。 */
export const DEFAULT_TIMES = ["12:30", "19:00", "22:30"];
export const MAX_TIMES = 3;

export interface NudgeSettings {
  times: string[]; // "HH:MM"
}

export interface ScheduleItem {
  id: string;
  at: number; // epoch ms
  title: string;
  body: string;
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---------- settings ----------
export function loadSettings(): NudgeSettings {
  if (typeof localStorage === "undefined") return { times: [...DEFAULT_TIMES] };
  const s = safeParse<NudgeSettings | null>(localStorage.getItem(SETTINGS_KEY), null);
  if (s && Array.isArray(s.times) && s.times.length > 0) return s;
  return { times: [...DEFAULT_TIMES] };
}

export function saveSettings(s: NudgeSettings): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* quota / private mode */
  }
}

// ---------- capture log / streak ----------
export function loadLog(): number[] {
  if (typeof localStorage === "undefined") return [];
  return safeParse<number[]>(localStorage.getItem(LOG_KEY), []);
}

export function saveLog(log: number[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(log));
  } catch {
    /* noop */
  }
}

export function appendCapture(ts: number = Date.now()): number[] {
  const log = loadLog();
  log.push(ts);
  saveLog(log);
  return log;
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 「今日まだでも昨日まで続いていれば維持」= 習慣化の後押しでプレッシャーをかけすぎない。 */
export function computeStreak(log: number[]): number {
  const days = new Set(log.map(dayKey));
  const cur = new Date();
  if (!days.has(dayKey(cur.getTime()))) cur.setDate(cur.getDate() - 1);
  let streak = 0;
  while (days.has(dayKey(cur.getTime()))) {
    streak += 1;
    cur.setDate(cur.getDate() - 1);
  }
  return streak;
}

export function todayCaptureCount(log: number[]): number {
  const k = dayKey(Date.now());
  return log.filter((ts) => dayKey(ts) === k).length;
}

// ---------- recent prompts (avoid repeats) ----------
export function loadRecent(): string[] {
  if (typeof localStorage === "undefined") return [];
  return safeParse<string[]>(localStorage.getItem(RECENT_KEY), []);
}

export function pushRecent(text: string): void {
  if (typeof localStorage === "undefined") return;
  const r = loadRecent();
  r.push(text);
  while (r.length > 8) r.shift();
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(r));
  } catch {
    /* noop */
  }
}

// ---------- scheduling ----------
/** "HH:MM" -> 次にその時刻が来る epoch ms(今日分が過ぎていれば明日)。 */
export function nextOccurrence(hhmm: string, now: number = Date.now()): number {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now + 1000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** 設定時刻から、次回分の通知アイテム一覧(文面込み)を組み立てる。 */
export function buildScheduleItems(times: string[]): ScheduleItem[] {
  const recent = loadRecent();
  const used = [...recent];
  return times.map((t, i) => {
    const at = nextOccurrence(t);
    const slot = slotForHour(new Date(at).getHours());
    const body = pickPrompt(slot, used);
    used.push(body);
    return { id: `nudge-${i}`, at, title: "Woolink", body };
  });
}
