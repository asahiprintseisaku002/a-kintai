// --- FCM (Web Push) 追加 ---
// 互換版で最短実装（ESMでなく importScripts を使う）
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDeZBhMuZQGTFdl-BGNQuQpABj7-kuC794",
  authDomain: "kintai-app-76bb7.firebaseapp.com",
  projectId: "kintai-app-76bb7",
  messagingSenderId: "1050791558955",
  appId: "1:805510662959:web:5ce04c4b49e0ec9759efda",
});

const messaging = firebase.messaging();

// バックグラウンド受信 → 通知表示
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || payload.data?.title || '通知';
  const options = {
    body:  payload.notification?.body  || payload.data?.body  || '',
    icon:  '/icons/icon-192.png',         // 任意
    badge: '/icons/badge.png',            // 任意
    data: { url: payload.data?.url || '/' } // クリックで開くURL
  };
  self.registration.showNotification(title, options);
});

// 通知クリック時の遷移
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';
  event.waitUntil(clients.openWindow(url));
});
// --- /FCM 追加ここまで ---