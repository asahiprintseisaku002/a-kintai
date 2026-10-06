// 独自通知のクリック処理はFirebase SDKより先に登録する。
self.addEventListener('notificationclick', (event) => {
  // SDKが表示した通知のクリック処理はSDKに任せる。
  if (event.notification.data?.FCM_MSG) return;

  event.notification.close();

  const target = new URL(
    event.notification.data?.url || '/',
    self.location.origin
  );

  if (target.origin !== self.location.origin) return;

  event.waitUntil(clients.openWindow(target.href));
});

importScripts(
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js'
);
importScripts(
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js'
);

const configText = new URL(self.location.href)
  .searchParams.get('config');

if (!configText) {
  throw new Error('FCM用のFirebase設定がありません。');
}

firebase.initializeApp(JSON.parse(configText));

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  // notification付きの通知はSDKが表示するため、二重表示を避ける。
  if (payload.notification) return;

  const title = payload.data?.title || '通知';

  return self.registration.showNotification(title, {
    body: payload.data?.body || '',
    icon: '/icons/icon-192.png',
    data: { url: payload.data?.url || '/' }
  });
});