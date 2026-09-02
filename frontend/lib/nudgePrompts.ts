// 「こういう場面で撮ろう」という撮影のきっかけ(nudge)の候補。
// 交換日記(Woolink)の狙い = 一人暮らしの夜の孤独を、日常のかけらの交換でやわらげる。
// なので "映える瞬間" ではなく "生活のなんでもない一場面" を撮る習慣づけを促す文面にしている。
//
// 由来: 検証フィードバック 2026-08-31 杉谷「日に数回通知がいくとか、こういう場面で写真を
//       撮ろうみたいなサポートがあると写真を撮る習慣がつきそう」。
//   (もともと単体プロトタイプ tornado2026-photo-nudge にあったものを frontend へ統合)

export type NudgeSlot = "morning" | "day" | "evening" | "night" | "any";

export interface NudgePrompt {
  /** この文面をいつ出すか。通知時刻に近いスロットから優先的に選ぶ。 */
  slot: NudgeSlot;
  /** 通知本文。20文字前後、命令ではなく誘い。 */
  text: string;
}

export const NUDGE_PROMPTS: NudgePrompt[] = [
  { slot: "morning", text: "朝いちばんに目に入ったものを1枚" },
  { slot: "morning", text: "今日の空はどんな色？" },
  { slot: "morning", text: "朝ごはん、または飲みものを撮ろう" },
  { slot: "day", text: "今いる場所から見える景色を1枚" },
  { slot: "day", text: "お昼に食べたものを記録しておこう" },
  { slot: "day", text: "今日すれ違った「ちょっといいな」を1枚" },
  { slot: "day", text: "手元にあるものを、そのまま撮ろう" },
  { slot: "evening", text: "帰り道の景色を1枚" },
  { slot: "evening", text: "夕方の光が当たっているものを探して" },
  { slot: "evening", text: "今日いちばん頑張ったことの跡を1枚" },
  { slot: "night", text: "晩ごはんを撮ろう。カップ麺でもいい" },
  { slot: "night", text: "部屋のいちばん好きな一角を1枚" },
  { slot: "night", text: "今日のおつかれの一杯を撮ろう" },
  { slot: "night", text: "窓の外、いま見えているものを1枚" },
  { slot: "night", text: "明かりを1つだけ撮ってみよう" },
  { slot: "night", text: "今日買ったもの、届いたものはある？" },
  { slot: "any", text: "いま手が届くところにある「今日」を1枚" },
  { slot: "any", text: "5秒だけ立ち止まって、目の前を撮ろう" },
  { slot: "any", text: "誰かに見せたくなった瞬間はあった？" },
  { slot: "any", text: "なんでもない1枚を、相手に送ってみよう" },
];

/** 通知時刻(hour)から slot を推定する。 */
export function slotForHour(hour: number): NudgeSlot {
  if (hour < 10) return "morning";
  if (hour < 15) return "day";
  if (hour < 18) return "evening";
  return "night";
}

/**
 * 指定スロットの候補から、直近で使っていないものを1件返す。
 * @param recentTexts 最近出した本文の配列(繰り返し回避用)
 */
export function pickPrompt(slot: NudgeSlot, recentTexts: string[] = []): string {
  const pool = NUDGE_PROMPTS.filter((p) => p.slot === slot || p.slot === "any");
  const fresh = pool.filter((p) => !recentTexts.includes(p.text));
  const candidates = fresh.length > 0 ? fresh : pool;
  return candidates[Math.floor(Math.random() * candidates.length)].text;
}
