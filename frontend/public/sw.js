// Woolink 撮影nudge の Service Worker。
//
// できること:
//  - ページから postMessage された nudge を、指定時刻に showNotification で出す
//    (SW が生きている間のみ。ブラウザは数十秒アイドルで SW を止めるので、
//     「タブを開いている / 直前まで開いていた」状況で動く前提)。
//  - 通知タップで Woolink を前面に出す。
//  - push イベント(Web Push を後で入れる場合)にも対応。
//  - periodicSync が使える環境なら、日次で「今日まだ撮ってない？」を出す保険。
//
// できないこと(=本番で必要なもの): タブを完全に閉じた状態での確実な定時配信。
// これには Web Push(VAPID鍵 + 配信サーバ)か、Capacitor/PWA+OSの通知スケジューラが要る。

const APP_URL = "/";
const ICON = "/nudge-icon.svg";
const timers = new Map(); // id -> timeoutID

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function notify(title, body) {
  return self.registration.showNotification(title || "Woolink", {
    body: body || "写真を1枚撮ってみよう",
    tag: "woolink-nudge",
    renotify: true,
    icon: ICON,
    badge: ICON,
    data: { url: APP_URL },
  });
}

self.addEventListener("message", (event) => {
  const msg = event.data || {};

  if (msg.type === "SCHEDULE") {
    // msg.items: [{ id, at (epoch ms), title, body }]
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    const now = Date.now();
    for (const item of msg.items || []) {
      const delay = item.at - now;
      if (delay <= 0 || delay > 24 * 60 * 60 * 1000) continue;
      const tid = setTimeout(() => {
        notify(item.title, item.body);
        timers.delete(item.id);
      }, delay);
      timers.set(item.id, tid);
    }
  }

  if (msg.type === "SHOW_NOW") {
    notify(msg.title, msg.body);
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || APP_URL;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ("focus" in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

// Web Push を後で入れる場合の受け口(現状は未使用)。
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  event.waitUntil(notify(payload.title, payload.body));
});

// 保険: 1日1回。ページ側が periodicSync.register('daily-nudge') を登録できた環境のみ発火。
self.addEventListener("periodicsync", (event) => {
  if (event.tag !== "daily-nudge") return;
  event.waitUntil(notify("Woolink", "今日のかけら、まだ1枚も残していないみたい"));
});
