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

async function canReceiveAttendance(uid) {
  try {
    const user = await admin.auth().getUser(uid);

    if (user.disabled || !user.emailVerified) {
      return false;
    }

    const adminSnap = await admin.database()
      .ref(`admins/${uid}`)
      .get();

    if (adminSnap.val() === true) {
      return true;
    }

    const employeeIdSnap = await admin.database()
      .ref(`usersByUid/${uid}/employeeId`)
      .get();

    const employeeId = employeeIdSnap.val();

    if (
      typeof employeeId !== 'string' ||
      !employeeId ||
      /[.#$\[\]\/]/.test(employeeId)
    ) {
      return false;
    }

    const employeeSnap = await admin.database()
      .ref(`employees/${employeeId}`)
      .get();

    return employeeSnap.exists();
  } catch (error) {
    // 確認できないユーザーには配信しない。
    functions.logger.warn(
      'Notification authorization check failed.',
      {
        uid,
        code: error.code || 'unknown'
      }
    );

    return false;
  }
}

async function sendToAllActive(kind, v) {
  const snap = await admin.database().ref('fcmTokens').get();
  if (!snap.exists()) {
    functions.logger.info('No tokens to send.');
    return;
  }
  const all = snap.val() || {};
  const tokens = [];
  const tokenOwners = new Map();

  for (const [uid, devices] of Object.entries(all)) {
    if (
      !devices ||
      typeof devices !== 'object' ||
      Array.isArray(devices)
    ) {
      continue;
    }

    if (!(await canReceiveAttendance(uid))) {
      continue;
    }

    for (const [token, device] of Object.entries(devices)) {
      if (
        !device ||
        typeof device !== 'object' ||
        device.active !== true
      ) {
        continue;
      }

      // 同じトークンが複数UIDに登録されていても送信は1回。
      if (!tokenOwners.has(token)) {
        tokens.push(token);
        tokenOwners.set(token, []);
      }

      tokenOwners.get(token).push(uid);
    }
  }
  if (!tokens.length) {
    functions.logger.info('No active tokens.');
    return;
  }

  const title = '勤怠予定が変更されました';
  const body = '詳細はアプリにログインして確認してください。';

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
    const updates = {};

    for (const token of invalids) {
      for (const uid of tokenOwners.get(token) || []) {
        updates[`fcmTokens/${uid}/${token}`] = null;
      }
    }

    if (Object.keys(updates).length) {
      await admin.database().ref().update(updates);
    }
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
