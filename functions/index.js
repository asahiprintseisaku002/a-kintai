// functions/index.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

// 近いリージョン（東京）
const REGION = 'asia-northeast1';

// クリック先URL（環境変数があればそちら優先）
const WEB_URL = (functions.config().app && functions.config().app.web_url) || 'https://example.com/';

function typeJa(t) {
  return { paid:'有給', overtime:'残業', special:'特別休暇', holiday:'休日出勤' }[t] || t;
}

function chunk(arr, size=500) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isInvalidTokenError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('registration-token-not-registered') ||
         msg.includes('mismatch') ||
         msg.includes('invalid-argument') ||
         msg.includes('sender');
}

async function sendToAllActive(kind, v) {
  const snap = await admin.database().ref('fcmTokens').get();
  if (!snap.exists()) {
    functions.logger.info('No tokens to send.');
    return;
  }
  const all = snap.val() || {};
  const tokens = Object.keys(all).filter(t => all[t]?.active !== false);
  if (!tokens.length) {
    functions.logger.info('No active tokens.');
    return;
  }

  const title =
      kind === 'created' ? `新しい予定: ${v.employeeName || '社員'}`
    : kind === 'updated' ? `予定を更新: ${v.employeeName || '社員'}`
    : kind === 'deleted' ? `予定を削除: ${v.employeeName || '社員'}`
    : '勤怠通知';

  const body = `${v.date} ${typeJa(v.type)} ${v.hours || 0}h${v.note ? ` – ${v.note}` : ''}`;

  let success = 0, failure = 0;
  const invalids = [];
  for (const batch of chunk(tokens, 500)) {
    const message = {
      notification: { title, body },
      webpush: {
        fcmOptions: { link: WEB_URL },
        headers: { TTL: '300' }
      },
      tokens: batch
    };
    const res = await admin.messaging().sendEachForMulticast(message);
    success += res.successCount;
    failure += res.failureCount;
    res.responses.forEach((r, i) => {
      if (!r.success && isInvalidTokenError(r.error)) invalids.push(batch[i]);
    });
  }
  functions.logger.info(`FCM sent: success=${success}, failure=${failure}, invalids=${invalids.length}`);
  if (invalids.length) {
    await Promise.all(invalids.map(t => admin.database().ref(`fcmTokens/${t}`).remove().catch(() => {})));
  }
}

exports.onKintaiCreated = functions
  .region(REGION)
  .database.ref('/kintai/{id}')
  .onCreate((snap) => sendToAllActive('created', snap.val() || {}));

exports.onKintaiUpdated = functions
  .region(REGION)
  .database.ref('/kintai/{id}')
  .onUpdate((change) => sendToAllActive('updated', change.after.val() || {}));

exports.onKintaiDeleted = functions
  .region(REGION)
  .database.ref('/kintai/{id}')
  .onDelete((snap) => sendToAllActive('deleted', snap.val() || {}));
