import {
  db,
  auth,
  firebaseConfig,
  getSupportedMessaging
} from './firebase';
import {
  ref,
  push,
  onValue,
  remove,
  get,
  set,
  update,
  query,
  orderByChild,
  startAt,
  endAt,
  equalTo,
  limitToFirst
} from 'firebase/database';
import {
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence,
} from 'firebase/auth';
import { getToken, onMessage } from 'firebase/messaging';
import { 
  createUserWithEmailAndPassword, 
  sendEmailVerification, 
  sendPasswordResetEmail 
} from "firebase/auth";

// --- 新規登録（サインアップ） ---
async function signupEmail(email, pw) {
  const cred = await createUserWithEmailAndPassword(auth, email, pw);

  // 初回プロフィールの雛形を自分の領域に保存（任意）
  await set(ref(db, `usersByUid/${cred.user.uid}`), {
    email: cred.user.email || '',
    createdAt: Date.now()
  });

  // メール確認を送る（推奨）
  try {
    await sendEmailVerification(cred.user);
    alert('確認メールを送信しました。受信ボックスをご確認ください。');
  } catch (e) {
    console.error('[signupEmail]', e);

    const messages = {
      'auth/operation-not-allowed':
        'Firebaseでメール/パスワード認証が有効になっていません。',
      'auth/email-already-in-use':
        'このメールアドレスはすでに登録されています。',
      'auth/invalid-email':
        'メールアドレスの形式が正しくありません。',
      'auth/weak-password':
        'パスワードが短すぎます。6文字以上で入力してください。'
    };

    alert(messages[e.code] || `登録に失敗しました: ${e.message}`);
  }
  return cred.user;
}

// --- パスワード再設定 ---
async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email);
  alert('パスワード再設定メールを送信しました');
}

// --- モーダルとボタン連携 ---
const loginModal   = document.getElementById('login-modal');
const btnOpen = document.getElementById('btn-login');
const btnClose= document.getElementById('btn-close-modal');
const btnLE   = document.getElementById('btn-login-email');
const btnSE   = document.getElementById('btn-signup-email');
const btnLG   = document.getElementById('btn-login-google');
const btnReset= document.getElementById('btn-reset');
const btnOut  = document.getElementById('btn-logout');

btnOpen?.addEventListener('click', () => loginModal.classList.remove('hidden'));
btnClose?.addEventListener('click', () => loginModal.classList.add('hidden'));

btnLE?.addEventListener('click', async () => {
  const email = document.getElementById('auth-email').value.trim();
  const pass  = document.getElementById('auth-pass').value;
  try {
    await window.loginEmail(email, pass);
    loginModal.classList.add('hidden');
  } catch (e) {
    console.error('[loginEmail]', e);

    const messages = {
      'auth/operation-not-allowed':
        'Firebaseでメール/パスワード認証が有効になっていません。',
      'auth/invalid-email':
        'メールアドレスの形式が正しくありません。',
      'auth/invalid-credential':
        'メールアドレスまたはパスワードが正しくありません。',
      'auth/user-disabled':
        'このアカウントは無効になっています。',
      'auth/too-many-requests':
        'ログイン試行が多すぎます。しばらく待ってから再試行してください。'
    };

    alert(messages[e.code] || `ログインに失敗しました: ${e.message}`);
  }
});

btnSE?.addEventListener('click', async () => {
  const email = document.getElementById('auth-email').value.trim();
  const pass  = document.getElementById('auth-pass').value;
  try {
    await signupEmail(email, pass);
    loginModal.classList.add('hidden');
  } catch (e) {
    alert('登録失敗: ' + e.message);
  }
});

btnLG?.addEventListener('click', async () => {
  try {
    await window.loginGoogle();
    loginModal.classList.add('hidden');
  } catch (e) {
    alert('Googleログイン失敗: ' + e.message);
  }
});

btnReset?.addEventListener('click', async () => {
  const email = document.getElementById('auth-email').value.trim();
  if (!email) return alert('先にメールアドレスを入力してください');
  try {
    await resetPassword(email);
  } catch (e) {
    alert('送信失敗: ' + e.message);
  }
});

btnOut?.addEventListener('click', async () => {
  try { await window.logout(); } catch {}
});

function closeLoginModal(){ loginModal.classList.add('hidden'); }
window.closeLoginModal = closeLoginModal;

// モーダル外をクリック/タップしたら閉じる
loginModal.addEventListener('click', (e) => {
  // クリック／タップした対象が「背景部分（＝modal自身）」なら閉じる
  if (e.target === loginModal) {
    closeLoginModal();
  }
});
// ===============================
//  ログインUI（任意：ボタンがある場合）
// ===============================
window.loginEmail  = async (email, pw) => { await signInWithEmailAndPassword(auth, email, pw); };
window.loginGoogle = async () => { await signInWithPopup(auth, new GoogleAuthProvider()); };
window.logout      = async () => { await signOut(auth); };

// ブラウザ再訪でもログイン維持
await setPersistence(auth, browserLocalPersistence);

document.getElementById('btn-logout')?.addEventListener('click', () => signOut(auth));

// ===============================
//  FCM 初期化（未対応環境に配慮）
// ===============================
let messaging = null;
let stopOnMessage = null;
const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;
const FCM_ENABLED = import.meta.env.VITE_FCM_ENABLED === 'true';

// サービスワーカー登録（存在しなければ登録）
async function ensureServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;

  const params = new URLSearchParams({
    config: JSON.stringify(firebaseConfig)
  });

  const registration = await navigator.serviceWorker.register(
    `/firebase-messaging-sw.js?${params.toString()}`,
    {
      scope: '/firebase-cloud-messaging-push-scope/',
      updateViaCache: 'none'
    }
  );

  if (registration.active?.state === 'activated') {
    return registration;
  }

  const worker =
    registration.installing ||
    registration.waiting ||
    registration.active;

  if (!worker) {
    throw new Error('FCM用Service Workerが見つかりません。');
  }

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', checkState);
    };

    const checkState = () => {
      if (worker.state === 'activated') {
        cleanup();
        resolve();
      } else if (worker.state === 'redundant') {
        cleanup();
        reject(new Error('FCM用Service Workerの有効化に失敗しました。'));
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('FCM用Service Workerの有効化がタイムアウトしました。'));
    }, 30000);

    worker.addEventListener('statechange', checkState);
    checkState();
  });

  return registration;
}

async function initMessaging() {
  messaging = await getSupportedMessaging();

  if (messaging) {
    console.log('[FCM] Messaging 初期化 OK');
  } else {
    console.log('[FCM] この環境ではWeb Push非対応');
  }
}

async function requestPermissionAndGetToken() {
  if (!messaging) return null;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    console.log('[FCM] 通知が許可されませんでした:', permission);
    return null;
  }
  const registration = await ensureServiceWorker();
  const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
  if (!token) return null;

  try {
        const user = auth.currentUser;
        // 通知許可・トークン取得中にログアウトや切替があった場合は保存しない。
        if (auth.currentUser !== user) return null;

        await set(
          ref(db, `fcmTokens/${user.uid}/${token}`),
          {
            active: true,
            ua: navigator.userAgent,
            updatedAt: Date.now()
          }
        );
    console.log('[FCM] token saved');
  } catch (e) {
    console.warn('[FCM] failed to save token:', e);
  }
  //console.log('FCMトークン:', token);
  return token;
}

function setupOnMessage() {
  if (!messaging || stopOnMessage) return;
  stopOnMessage = onMessage(messaging, (payload) => {
    const title = payload.notification?.title || payload.data?.title || '通知';
    const body  = payload.notification?.body  || payload.data?.body  || '';

    const toast = document.createElement('div');
    toast.textContent = `${title}：${body}`;
    Object.assign(toast.style, {
      position: 'fixed', right: '16px', bottom: '16px',
      background: '#333', color: '#fff', padding: '12px 16px',
      borderRadius: '10px', zIndex: 9999, maxWidth: '70vw',
      boxShadow: '0 6px 24px rgba(0,0,0,.2)'
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  });
}

// ===============================
//  認証状態に応じて DB 購読の開始/停止
// ===============================
// ---- 購読のハンドル ----
let stopPrivate = null;
let stopKintai = null;
let lastWeeklyRulesSnap = null;
let currentKintaiRangeKey = '';
let calendar = null;

// プライベート購読（ログイン後に開始・ログアウトで停止）
function startPrivateSubscriptions() {
  if (stopPrivate) return;
  const unsubs = [];

  // 要認証のパス（employees）
  const q = query(ref(db, 'employees'), orderByChild('order'));
    unsubs.push(onValue(q, (snap) => {
    empMap = {};
    empInfoMap = {};

    if (snap.exists()) {
      snap.forEach(c => {
        const v = c.val() || {};

        empMap[c.key] = v.name;
        empInfoMap[c.key] = {
          name: v.name || '',
          email: v.email || '',
          sms: v.sms || '',
          isAdmin: !!v.isAdmin
        };
      });
    }

    employeesLoaded = true;
    refreshEmployeesUI(snap);

    if (lastWeeklyRulesSnap) {
      renderWeeklyRules(lastWeeklyRulesSnap);
    }

    if (lastKintaiSnap) {
      renderFromKintai(lastKintaiSnap);
    }
  }));

  unsubs.push(onValue(ref(db, 'weeklyRules'), (snap) => {
    lastWeeklyRulesSnap = snap;
    renderWeeklyRules(snap);
  }, (error) => {
    lastWeeklyRulesSnap = null;
    document.getElementById('rule-list')?.replaceChildren();
    console.error('[weeklyRules] 取得に失敗しました:', error);
  }));

  if (calendar?.view) {
    const currentView = calendar.view;

    subscribeKintaiForRange(
      currentView.activeStart,
      currentView.activeEnd
    );
  }

  stopPrivate = () => {
    unsubs.forEach(fn => fn());

    if (stopKintai) {
      stopKintai();
      stopKintai = null;
    }

    currentKintaiRangeKey = '';
    lastKintaiSnap = null;
    stopPrivate = null;
  };
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function subscribeKintaiForRange(start, endExclusive) {
  if (!start || !endExclusive) return;

  // FullCalendarの終了日は範囲外なので、1日前を最終日にする
  const endInclusive = new Date(endExclusive);
  endInclusive.setDate(endInclusive.getDate() - 1);

  const startDate = formatLocalDate(start);
  const endDate = formatLocalDate(endInclusive);
  const rangeKey = `${startDate}_${endDate}`;

  // 同じ期間を重複購読しない
  if (stopKintai && currentKintaiRangeKey === rangeKey) {
    return;
  }

  // 前の月・期間の購読を解除
  if (stopKintai) {
    stopKintai();
    stopKintai = null;
  }

  currentKintaiRangeKey = rangeKey;

  const kintaiQuery = query(
    ref(db, 'kintai'),
    orderByChild('date'),
    startAt(startDate),
    endAt(endDate)
  );

  console.log(`[kintai] 購読期間: ${startDate} ～ ${endDate}`);

  stopKintai = onValue(
    kintaiQuery,
    (snap) => {
      lastKintaiSnap = snap;

      if (employeesLoaded) {
        renderFromKintai(snap);
      }
    },
    (error) => {
      console.error(
        `[kintai] ${startDate} ～ ${endDate} の取得に失敗しました:`,
        error
      );
    }
  );
}

// ===== 認証状態 =====
onAuthStateChanged(auth, async (user) => {
  const s = document.getElementById('login-status');

  document.getElementById('btn-login').style.display =
    user ? 'none' : 'inline-block';

  document.getElementById('btn-logout').style.display =
    user ? 'inline-block' : 'none';

  togglePrivateUI(!!user);
  setWriteEnabled(!!user);

  // 前のユーザーの購読と通知リスナーを停止する。
  stopPrivate?.();
  stopOnMessage?.();
  stopOnMessage = null;

  clearPrivateDisplay();

  if (!user) {
    if (s) s.textContent = '未ログイン';
    return;
  }

  const isVerified = !!user.emailVerified;

  if (s) {
    s.textContent =
      `ログイン中: ${user.email || user.uid}` +
      (isVerified ? '' : '（メール未確認）');
  }

  startPrivateSubscriptions();

  if (!FCM_ENABLED) {
    console.info('[FCM] この環境ではプッシュ通知登録を無効にしています。');
    return;
  }

  try {
    await initMessaging();

    // 初期化中にログアウト・ユーザー切替があった場合は終了。
    if (auth.currentUser !== user) return;

    setupOnMessage();

    if (isVerified) {
      await requestPermissionAndGetToken();
    } else {
      console.info('[FCM] メール未確認のため通知登録を見送ります。');
    }
  } catch (error) {
    console.warn(
      '[FCM] プッシュ通知の初期化に失敗しました。通知なしで続行します。',
      error
    );
  }
});

// 例：書き込み系ボタンや入力をまとめて制御
function setWriteEnabled(enabled){
  for (const sel of ['#btn-modal-delete','#btn-apply-edit','button.addEmployee','button.addrule','#btn-export-xlsx']) {
    document.querySelectorAll(sel).forEach(el => el.disabled = !enabled);
  }
}

// ログイン/未ログインに応じて切り替え
function togglePrivateUI(isLoggedIn) {
  document.querySelectorAll('.private-only').forEach(el => {
    el.classList.toggle('hidden', !isLoggedIn);
  });
}

function clearPrivateDisplay() {
  lastWeeklyRulesSnap = null;
  lastKintaiSnap = null;
  latestMonthData = [];
  monthListSorted = [];
  currentPage = 1;
  lastViewYmKey = '';

  empMap = {};
  empInfoMap = {};
  employeesLoaded = false;

  renderListPaged();

  // 勤怠予定だけを消し、祝日は残す。
  calendar?.getEvents()
    .filter(event => event.classNames?.includes('kintai-event'))
    .forEach(event => event.remove());

  for (const id of ['employees', 'rule-list', 'summary']) {
    document.getElementById(id)?.replaceChildren();
  }

  for (const id of ['employee', 'rule-employee', 'edit-employee']) {
    document.getElementById(id)?.replaceChildren();
  }

  closeModal();
  closeEmpModal();
}

const SHOULD_RELOAD_KEY = 'akintai_reload_once';
// ===== タブ切替 =====
const tabMain = document.getElementById('tab-main');
const tabSettings = document.getElementById('tab-settings');
const secMain = document.getElementById('main');
const secSettings = document.getElementById('settings');

// 既存のクリックハンドラを書き換え（中身のtoggleはそのまま）
tabSettings.addEventListener('click', ()=>{
  tabSettings.classList.add('active');
  tabMain.classList.remove('active');
  secSettings.classList.remove('hidden');
  secMain.classList.add('hidden');

  // 次にメインへ戻ったら一度だけリロードするフラグを立てる
  sessionStorage.setItem(SHOULD_RELOAD_KEY, '1');
});

tabMain.addEventListener('click', ()=>{
  tabMain.classList.add('active');
  tabSettings.classList.remove('active');
  secMain.classList.remove('hidden');
  secSettings.classList.add('hidden');

  // フラグが立っていたら一度だけリロード
  if (sessionStorage.getItem(SHOULD_RELOAD_KEY) === '1') {
    sessionStorage.removeItem(SHOULD_RELOAD_KEY);
    location.reload(); // ← フルリロード
  }
});

// ===== 一覧の月内ソート＆ページング =====
const PAGE_SIZE = 10;        // 1ページ10件
let currentPage = 1;         // 現在ページ
let monthListSorted = [];    // 当月の並べ替え済みリスト
let lastViewYmKey = '';   // 直近の表示月 "YYYY-MM"

function parseDateLocal(ymd){
  const [y,m,d] = String(ymd).split('-').map(Number);
  return new Date(y, (m||1)-1, d||1);
}
function compareByDateTime(a, b){
  const ad = parseDateLocal(a.date).getTime();
  const bd = parseDateLocal(b.date).getTime();
  if (ad !== bd) return ad - bd;
  const as = a.start ? a.start : '99:99';
  const bs = b.start ? b.start : '99:99';
  return as.localeCompare(bs);
}
function totalPages(){
  return Math.max(1, Math.ceil(monthListSorted.length / PAGE_SIZE));
}
function sliceByPage(page){
  const start = (page - 1) * PAGE_SIZE;
  return monthListSorted.slice(start, start + PAGE_SIZE);
}
function renderListPaged(){
  const ul = document.getElementById('list');
  ul.innerHTML = '';

  const pageItems = sliceByPage(currentPage);
  const fmt = new Intl.DateTimeFormat('ja-JP', { year:'numeric', month:'2-digit', day:'2-digit', weekday:'short' });

  pageItems.forEach(v => {
    const dateLabel = fmt.format(parseDateLocal(v.date));
    const empName = v.employee || (empMap[v.employeeId] || '社員');
    const label   = typeLabel(v.type);
    const showHoursText = (v.type === 'closed') ? '0h' : `${v.hours || 0}h`;
    const title = `${empName}：${label} ${showHoursText}` + (v.note?.trim() ? ` – ${v.note}` : '');

    const li = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = `${dateLabel} ${v.start || ''} ${title}`;

    const actions = document.createElement('span');
    actions.className = 'item-actions';

    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.textContent = '編集';
    editButton.addEventListener('click', () => {
      openModal({
        employeeId: v.employeeId,
        employeeName: empName,
        date: v.date,
        start: v.start,
        hours: v.hours,
        type: v.type,
        note: v.note
      }, v.id);
    });

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'danger';
    deleteButton.textContent = '削除';
    deleteButton.addEventListener('click', () => {
      deleteEntry(v.id);
    });

    actions.append(editButton, deleteButton);
    li.append(text, actions);
    ul.appendChild(li);
  });

  // 直結ハンドラ（デバッグログ付き）
window.goNextPage = function() {
  if (currentPage < totalPages()) {
    currentPage++;
    //console.debug('[pager click] next ->', currentPage);
    renderListPaged();
  } else {
    //console.debug('[pager click] next (at last page)', { currentPage, total: totalPages() });
  }
};
window.goPrevPage = function() {
  if (currentPage > 1) {
    currentPage--;
    //console.debug('[pager click] prev ->', currentPage);
    renderListPaged();
  } else {
    //console.debug('[pager click] prev (at first page)', { currentPage, total: totalPages() });
  }
};


  const info = document.getElementById('page-info');
  if (info) info.textContent = `${currentPage} / ${totalPages()}（全${monthListSorted.length}件）`;

  const prev = document.getElementById('page-prev');
  const next = document.getElementById('page-next');
  if (prev) prev.disabled = (currentPage <= 1);
  if (next) next.disabled = (currentPage >= totalPages());

  // ★ デバッグログは関数の一番最後に
  //console.debug('[pager]', { currentPage, total: totalPages(), length: monthListSorted.length });
}


document.addEventListener('DOMContentLoaded', () => {
  const prev = document.getElementById('page-prev');
  const next = document.getElementById('page-next');
  if (prev) prev.addEventListener('click', () => {
    if (currentPage > 1){ currentPage--; renderListPaged(); }
  });
  if (next) next.addEventListener('click', () => {
    if (currentPage < totalPages()){ currentPage++; renderListPaged(); }
  });
});


// ===== 社員 =====
/** 社員追加：name / email / sms / isAdmin を保存 */
function addEmployee(){
  const name   = document.getElementById('emp-name').value.trim();
  const email  = document.getElementById('emp-email').value.trim();
  const sms    = document.getElementById('emp-sms').value.trim();
  const isAdmin= document.getElementById('emp-admin').checked;

  if(!name) return alert('名前を入力してください');

  const now = Date.now();
  push(ref(db,'employees'), { name, email, sms, isAdmin: !!isAdmin, createdAt: now, order: now });

  document.getElementById('emp-name').value = '';
  document.getElementById('emp-email').value= '';
  document.getElementById('emp-sms').value  = '';
  document.getElementById('emp-admin').checked = false;
}
window.addEmployee = addEmployee;

const empEditModal = document.getElementById('emp-modal');

/** 社員編集モーダルを開く */
function openEmpModal(id){
  const v = empInfoMap[id] || {};
  document.getElementById('edit-emp-id').value    = id;
  document.getElementById('edit-emp-name').value  = v.name || '';
  document.getElementById('edit-emp-email').value = v.email || '';
  document.getElementById('edit-emp-sms').value   = v.sms || '';
  document.getElementById('edit-emp-admin').checked = !!v.isAdmin;
  empEditModal.classList.remove('hidden');
}
window.openEmpModal = openEmpModal;

function closeEmpModal(){ empEditModal.classList.add('hidden'); }
window.closeEmpModal = closeEmpModal;

// モーダル外をクリック/タップしたら閉じる
empEditModal.addEventListener('click', (e) => {
  // クリック／タップした対象が「背景部分（＝modal自身）」なら閉じる
  if (e.target === empEditModal) {
    closeEmpModal();
  }
});

/** 社員更新 */
async function applyEmpEdit(){
  const id     = document.getElementById('edit-emp-id').value;
  const name   = document.getElementById('edit-emp-name').value.trim();
  const email  = document.getElementById('edit-emp-email').value.trim();
  const sms    = document.getElementById('edit-emp-sms').value.trim();
  const isAdmin= document.getElementById('edit-emp-admin').checked;

  if(!id || !name) return alert('名前は必須です');

  await set(ref(db,'employees/'+id), {
    name, email, sms, isAdmin: !!isAdmin,
    updatedAt: Date.now()
  });
  closeEmpModal();
}
window.applyEmpEdit = applyEmpEdit;

/** 社員削除（紐付く予定があれば不可） */
async function deleteEmployee(empId){
  const employeeKintaiQuery = query(
    ref(db, 'kintai'),
    orderByChild('employeeId'),
    equalTo(empId),
    limitToFirst(1)
  );

  const kSnap = await get(employeeKintaiQuery);
  const used = kSnap.exists();

  if(used){
    alert('この社員に紐づく予定が存在するため削除できません。先に予定を削除してください。');
    return;
  }
  if(!confirm('この社員を削除しますか？')) return;
  remove(ref(db,'employees/'+empId));
}
window.deleteEmployee = deleteEmployee;

/** 社員一覧UI再描画（セレクトも更新） */
function refreshEmployeesUI(snapshot){
  const employeesSel = document.getElementById('employee');
  const ruleEmpSel  = document.getElementById('rule-employee');
  const list        = document.getElementById('employees');
  const editEmpSel  = document.getElementById('edit-employee');

  employeesSel.innerHTML = '';
  ruleEmpSel.innerHTML   = '';
  list.innerHTML         = '';
  editEmpSel.innerHTML   = '';

  const placeholder = '<option value="" disabled selected>社員名を選択してください</option>';
  employeesSel.innerHTML = placeholder;
  ruleEmpSel.innerHTML   = placeholder;
  editEmpSel.innerHTML   = placeholder;

  snapshot.forEach(childSnap=>{
    const id = childSnap.key;
    const { name, email='', sms='', isAdmin=false, order=0 } = childSnap.val();

    // セレクト
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;
    employeesSel.appendChild(opt);
    ruleEmpSel.appendChild(opt.cloneNode(true));
    editEmpSel.appendChild(opt.cloneNode(true));

  // 一覧
  const li = document.createElement('li');
  li.dataset.id = id;
  li.classList.add('emp-item');

  const line = document.createElement('span');
  line.className = 'emp-line';

  const drag = document.createElement('span');
  drag.className = 'drag';
  drag.title = 'ドラッグで並び替え';
  drag.textContent = '⠿';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'emp-name';
  nameSpan.textContent = name ?? '';

  line.append(drag, nameSpan);

  if (isAdmin) {
    const badge = document.createElement('span');
    badge.className = 'badge-admin';
    badge.textContent = '管理者';
    line.appendChild(badge);
  }

  if (email) {
    const emailSpan = document.createElement('span');
    emailSpan.className = 'emp-contact';
    emailSpan.textContent = `📧 ${email}`;
    line.appendChild(emailSpan);
  }

  if (sms) {
    const smsSpan = document.createElement('span');
    smsSpan.className = 'emp-contact';
    smsSpan.textContent = `📱 ${sms}`;
    line.appendChild(smsSpan);
  }

  const actions = document.createElement('span');

  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.textContent = '編集';
  editButton.addEventListener('click', () => openEmpModal(id));

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'danger';
  deleteButton.textContent = '削除';
  deleteButton.addEventListener('click', () => deleteEmployee(id));

  actions.append(editButton, deleteButton);
  li.append(line, actions);
  list.appendChild(li);
  });

  initEmployeeSortable();
}

let employeeSortable = null;
let lastEmployeesSnap = null; // 既に使っていればそれを流用

// employees は order で購読（未導入なら変更）
onValue(query(ref(db,'employees'), orderByChild('order')), (snap) => {
  lastEmployeesSnap = snap;
  empMap = {};
  empInfoMap = {};
  if (snap.exists()) snap.forEach(c => {
    const v = c.val() || {};
    empMap[c.key] = v.name;
    empInfoMap[c.key] = { name: v.name || '', email: v.email || '', sms: v.sms || '', isAdmin: !!v.isAdmin };
  });
  employeesLoaded = true;
  refreshEmployeesUI(snap);
  if (lastKintaiSnap) renderFromKintai(lastKintaiSnap);
});

// D&D 初期化（毎回呼ばれても二重初期化しない）
function initEmployeeSortable(){
  const ul = document.getElementById('employees');
  if (!ul) return;

  if (employeeSortable) {
    employeeSortable.destroy();
    employeeSortable = null;
  }

  employeeSortable = Sortable.create(ul, {
    handle: '.drag',
    animation: 150,
    fallbackOnBody: true,
    swapThreshold: 0.65,
    onEnd: saveEmployeeOrderFromDOM
  });
}

// DOM順から order を再計算して一括保存
async function saveEmployeeOrderFromDOM(){
  const ul = document.getElementById('employees');
  if (!ul) return;
  const lis = Array.from(ul.querySelectorAll('li.emp-item'));

  // 10刻みで振る（後から間に挿入しやすい）
  const updates = {};
  let n = 10;
  for (const li of lis) {
    const id = li.dataset.id;
    if (!id) continue;
    updates[`employees/${id}/order`] = n;
    n += 10;
  }

  try {
    await update(ref(db), updates);
    // onValue が再発火して正しい順で再描画されます
    // console.log('[D&D] order saved', updates);
  } catch (e) {
    console.error('[D&D] save order failed', e);
    alert('並びの保存に失敗しました');
  }
}

//DOMContentLoaded のどこかで一度走らせるユーティリティ。既に order がある人はスキップ
async function backfillEmployeeOrder(){
  const snap = await get(ref(db,'employees'));
  if (!snap.exists()) return;
  const rows = [];
  snap.forEach(c => rows.push({ id: c.key, ...c.val() }));
  // 既に order が付いているか確認
  const need = rows.filter(r => r.order == null);
  if (!need.length) return;

  // 現在の並び（取得順）を基準に 10刻みで振る→後で入れ替えしやすい
  let base = 10;
  const updates = {};
  rows.forEach(r => {
    if (r.order == null) {
      updates[`employees/${r.id}/order`] = base;
    }
    base += 10;
  });
  await update(ref(db), updates);
  console.log('[backfillEmployeeOrder] applied');
}
document.addEventListener('DOMContentLoaded', backfillEmployeeOrder);


async function submitKintai(){
  const user = auth.currentUser;
  const employeeId = document.getElementById('employee').value;
  const date  = document.getElementById('date').value;
  const start = document.getElementById('start').value;
  const hours = parseFloat(document.getElementById('hours').value || '0');
  const type  = document.getElementById('type').value;
  const note  = (document.getElementById('note').value || '').trim();

  if (!user) {
    alert('予定を登録するにはログインが必要です');
    return;
  }

  if (!employeeId || !date || !type) return alert('項目を入力してください');

  const employeeName =
    empMap[employeeId] ||
    document.querySelector(`#employee option[value="${employeeId}"]`)?.textContent ||
    '';

  const payload = {
    employeeId,
    employeeName,
    date,
    start,
    hours,
    type,
    note,
    createdByUid: user.uid,
    createdAt: Date.now()
  };

  try {
    console.log('[submitKintai]', {
      uid: user.uid,
      employeeId,
      createdByUid: payload.createdByUid
    });

    await push(ref(db, 'kintai'), payload);

    alert('登録しました');
  } catch (error) {
    console.error('[submitKintai] 登録失敗:', error);

    if (error?.code === 'PERMISSION_DENIED') {
      alert(
        '予定を登録できませんでした。ログインユーザーと選択した社員の紐付けを確認してください。'
      );
    } else {
      alert(`予定の登録に失敗しました: ${error.message}`);
    }

    return;
  }

  // 入力リセット
  const sel = document.getElementById('employee');
  sel.value = '';
  if (sel.value !== '') sel.selectedIndex = 0;
  document.getElementById('date').value  = '';
  document.getElementById('start').value = '09:00';
  document.getElementById('hours').value = '8';
  document.getElementById('type').value  = 'paid';
  document.getElementById('note').value  = '';
}
window.submitKintai = submitKintai;

async function deleteEntry(id){
  if (!confirm('この予定を削除しますか？')) return;

  try {
    const entryRef = ref(db, 'kintai/' + id);

    // 1) 削除前に old を取得
    const s = await get(entryRef);
    const old = s.exists() ? s.val() : null;

    // 2) まず通知URLを作ってみる（デバッグ）
    console.log('[deleteEntry] old=', old);

    // 3) 実データ削除
    await remove(entryRef);

    alert('削除しました');
  } catch (e) {
    console.error('[deleteEntry] error', e);
    alert('削除時にエラーが発生しました。もう一度お試しください。');
  }
}
window.deleteEntry = deleteEntry;


// ===== 編集モーダル =====
const modal = document.getElementById('modal');
function openModal(v, id){
  document.getElementById('edit-id').value = id;
  document.getElementById('edit-employee').value = v.employeeId || '';
  document.getElementById('edit-date').value = v.date || '';
  document.getElementById('edit-start').value = v.start || '';
   document.getElementById('edit-hours').value = v.type === 'closed' ? 0 : (v.hours || 0);
  document.getElementById('edit-type').value = v.type || 'paid';
  document.getElementById('edit-note').value = v.note || '';

  // 「休業」は編集項目をロック（任意。不要なら下3行を削除）
  const startEl = document.getElementById('edit-start');
  const hoursEl = document.getElementById('edit-hours');
  const typeEl  = document.getElementById('edit-type');
  const isClosed = (v.type === 'closed');
  startEl.disabled = isClosed;
  hoursEl.disabled = isClosed;
  // type自体は変更可にしたい場合は下行をコメントアウト
  // typeEl.disabled  = isClosed;

  // ★ 削除ボタンの設定（モーダル内の削除ボタンを取得してイベントをセット）
  const delBtn = document.getElementById('btn-modal-delete');
  if (delBtn) {
    delBtn.onclick = () => {
        deleteEntry(id);
        closeModal();
    };
  }

  modal.classList.remove('hidden');
}
function closeModal(){ 
  // ロック解除（openで無効化した場合の戻し）
  document.getElementById('edit-start').disabled = false;
  document.getElementById('edit-hours').disabled = false;
  // document.getElementById('edit-type').disabled  = false;
  modal.classList.add('hidden'); 
}
window.closeModal = closeModal;

// モーダル外をクリック/タップしたら閉じる
modal.addEventListener('click', (e) => {
  // クリック／タップした対象が「背景部分（＝modal自身）」なら閉じる
  if (e.target === modal) {
    closeModal();
  }
});

async function applyEdit(){
  try {
    const id   = document.getElementById('edit-id').value;
    const employeeId = document.getElementById('edit-employee').value;
    const date = document.getElementById('edit-date').value;
    const start= document.getElementById('edit-start').value;
    //const hours= parseFloat(document.getElementById('edit-hours').value || '0');
    const type = document.getElementById('edit-type').value;
    const note = (document.getElementById('edit-note').value || '').trim();

    // “休業”は 0h に固定。それ以外は入力値を使用
    const hoursInput = document.getElementById('edit-hours').value;
    const hoursNum   = parseFloat(hoursInput === '' ? 'NaN' : hoursInput);
    const hours      = (type === 'closed') ? 0 : (isNaN(hoursNum) ? 0 : hoursNum);


    if(!employeeId || !date || !type) return alert('項目を入力してください');

    const employeeName =
      empMap[employeeId] ||
      document.querySelector(`#edit-employee option[value="${employeeId}"]`)?.textContent || '';

    const payloadNew = {   // ← ここを payloadNew に統一
      employeeId, employeeName,
      date, start, hours, type, note,
      updatedAt: Date.now()
    };

    // 変更前データを取得 → 保存 → old/new 両方を通知
    const entryRef = ref(db, 'kintai/'+id);
    const snap = await get(entryRef);
    const old = snap.exists() ? snap.val() : null;

    await update(entryRef, payloadNew);

    closeModal();
  } catch (e) {
    console.error('[applyEdit] error', e);
    alert('更新時にエラーが発生しました。もう一度お試しください。');
  }
}
window.applyEdit = applyEdit;


// ===== カレンダー & 一覧 =====
const listEl = document.getElementById('list');
let lastKintaiSnap = null;

// --- 祝日読み込み用（年ごとに1回だけFetchしてキャッシュ） ---
const HOLIDAY_CLASS = 'holiday-event';
const _holidayYearsLoaded = new Set();     // 読み込んだ年
const _holidayCache = new Map();           // "YYYY-MM-DD" -> "祝日名"

async function loadHolidayYear(year){
  if (_holidayYearsLoaded.has(year)) return;

  const yearUrl = `https://holidays-jp.github.io/api/v1/${year}/date.json`;
  const allUrl  = `https://holidays-jp.github.io/api/v1/date.json`;
  try {
    // 1) 年別（推奨）
    let res = await fetch(yearUrl);
    if (!res.ok) {
      // 2) 年別が無い/エラー時は全体→該当年のみ抽出
      res = await fetch(allUrl);
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const all = await res.json(); // { "YYYY-MM-DD": "祝日名", ... }
      Object.entries(all).forEach(([dateStr, name]) => {
        if (dateStr.startsWith(`${year}-`)) _holidayCache.set(dateStr, name);
      });
    } else {
      const data = await res.json(); // { "YYYY-MM-DD": "祝日名", ... }（年別）
      Object.entries(data).forEach(([dateStr, name]) => {
        _holidayCache.set(dateStr, name);
      });
    }
    _holidayYearsLoaded.add(year);
  } catch(e){
    console.warn('祝日読み込み失敗:', year, e);
  }
}

// 表示範囲に入る祝日をイベント化
function buildHolidayEventsInRange(start, end){
  const evs = [];
  // start/end はDate。比較用にYYYY-MM-DDへ
  const pad = n => String(n).padStart(2,'0');
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

  // 祝日キャッシュを走査して、範囲内のみ追加
  for (const [dateStr, title] of _holidayCache.entries()){
    const [Y,M,D] = dateStr.split('-').map(Number);
    const dt = new Date(Y, M-1, D);
    if (dt >= start && dt < end){
      evs.push({
        title,
        start: dateStr,
        allDay: true,
        className: HOLIDAY_CLASS,
        color: '#fff3f3',
        textColor: '#d32f2f',
        extendedProps: { prio: 0 } // ★祝日は上側（勤怠より優先が低い=0）
      });
    }
  }
  return evs;
}

// 祝日イベントを一旦クリアして再追加
function refreshHolidayEvents(calendar, info){
  // 既存の祝日イベントを削除
  calendar.getEvents()
    .filter(ev => ev.classNames?.includes(HOLIDAY_CLASS))
    .forEach(ev => ev.remove());

  // 表示範囲の祝日を追加
  const holidayEvents = buildHolidayEventsInRange(info.start, info.end);
  calendar.addEventSource(holidayEvents);
}

// ===== FullCalendar =====
  calendar = new FullCalendar.Calendar(document.getElementById('calendar'), {
  initialView: 'dayGridMonth',
  locale: 'ja',
  height: 'auto',
  aspectRatio: 1.2,
  expandRows: true,
  fixedWeekCount: true,
  dayMaxEventRows: 3,

    //kintai-event を常に下側へ
  eventOrder: (a, b) => {
    const ap = a.extendedProps?.prio ?? 999;
    const bp = b.extendedProps?.prio ?? 999;
    if (ap !== bp) return ap - bp; // ★ 祝日(0)が上、勤怠(1)が下

    // タイブレーク
    if (a.allDay && !b.allDay) return -1;
    if (!a.allDay && b.allDay) return 1;
    const t = (+a.start) - (+b.start);
    if (t !== 0) return t;
    return (a.title || '').localeCompare(b.title || '');
  },

  eventClick(info){
    const id = info.event.id;
    const v  = info.event.extendedProps.raw;
    openModal(v, id);
  },

  // 月移動/初期表示のたびに祝日を読み込み→反映＆既存データ再描画
  datesSet: async (info) => {
    if (stopPrivate) {
      subscribeKintaiForRange(info.start, info.end);
    }

    // この表示範囲に跨る可能性がある年を読み込み（前後も保険で）
    const years = new Set([info.start.getFullYear(), info.end.getFullYear()]);
    years.add(info.start.getFullYear() - 1);
    years.add(info.end.getFullYear() + 1);

    // 必要な年だけ非同期でロード
    await Promise.all([...years].map(y => loadHolidayYear(y)));

    
    // 勤怠の既存イベント再描画（元の処理を維持）
    if (lastKintaiSnap) renderFromKintai(lastKintaiSnap);

    // 祝日イベントを刷新
    refreshHolidayEvents(calendar, info);
  },

  // 祝日のセル背景も薄く色付け（任意）
  eventDidMount(arg){
    if (arg.event.allDay && arg.event.classNames?.includes(HOLIDAY_CLASS)) {
      const cell = arg.el.closest('.fc-daygrid-day');
      if (cell) cell.classList.add('is-holiday');
    }
  }
});

calendar.render();

window.openModal = openModal;

function typeLabel(t){
  if (t === 'work')     return '勤務';
  if (t === 'off')      return '休暇';
  if (t === 'remote')   return '在宅';
  if (t === 'closed')   return '休業';
  if (t === 'paid')     return '有給';
  if (t === 'overtime') return '残業';
  if (t === 'special')  return '特別休暇';
  if (t === 'holiday')  return '休日出勤';
  return t || '';
}
function typeClass(t){
  if (t === 'work')     return 'work';
  if (t === 'off')      return 'off';
  if (t === 'remote')   return 'remote';
  if (t === 'closed')   return 'closed';
  if (t === 'paid')     return 'paid';
  if (t === 'overtime') return 'overtime';
  if (t === 'special')  return 'special';
  if (t === 'holiday')  return 'holiday';
  return '';
}

let latestMonthData = [];
let empMap = {};       // { empId: name }
let empInfoMap = {};   // { empId: { name, email, sms, isAdmin } }
let employeesLoaded = false;

function renderFromKintai(snap){
  const events = [];
  listEl.innerHTML = '';         // ← ここでは直接描画しない
  const sums = {};
  latestMonthData = [];

  const cur = calendar.getDate ? calendar.getDate() : new Date();
  const viewYm = { y: cur.getFullYear(), m: cur.getMonth() };

  const monthRaw = [];           // 当月分の生配列（このあとソート→ページ描画）

  snap.forEach(childSnap => {
    const id = childSnap.key;
    const v  = childSnap.val();
    const empName = v.employeeName || empMap[v.employeeId] || '(社員)';

    const h = parseFloat(v.hours||0) || 0;
    const label = typeLabel(v.type);
    const showHoursText = (v.type === 'closed') ? '0h' : `${h}h`;
    const title = `${empName}：${label} ${showHoursText}` + (v.note?.trim() ? ` – ${v.note}` : '');

    events.push({
      id,
      title,
      start: v.date,
      allDay: true,
      classNames: ['kintai-event', typeClass(v.type)], // ★ 勤怠の識別クラスを必ず付与
      extendedProps: { raw: v, prio: 1 }               // ★ 勤怠=1（下側に来る）
    });

    const d = parseDateLocal(v.date);
    if (d.getFullYear() === viewYm.y && d.getMonth() === viewYm.m) {
      const row = {
        id,
        date: v.date,
        employeeId: v.employeeId,
        employee: empName,
        start: v.start || '',
        hours: h,
        type: v.type,
        note: v.note || ''
      };
      monthRaw.push(row);              // 表示用
      latestMonthData.push({...row});  // 既存のエクスポート/集計用

      const e = v.employeeId;
      if (!sums[e]) sums[e] = {
        name: empName,
        total:0,
        work:0, off:0, remote:0, closed:0,
        paid:0, overtime:0, special:0, holiday:0
      };
      sums[e].total += h;
      if (v.type==='work') sums[e].work += h;
      else if (v.type==='off') sums[e].off += h;
      else if (v.type==='remote') sums[e].remote += h;
      else if (v.type==='closed') sums[e].closed += h;
      else if (v.type==='paid') sums[e].paid += h;
      else if (v.type==='overtime') sums[e].overtime += h;
      else if (v.type==='special') sums[e].special += h;
      else if (v.type==='holiday') sums[e].holiday += h;
    }
  });

    // ★ 勤怠イベントだけを削除（祝日は消さない）
  calendar.getEvents()
    .filter(ev => ev.classNames?.includes('kintai-event'))
    .forEach(ev => ev.remove());

  // 勤怠イベントを追加
  calendar.addEventSource(events);

    // ★ 勤怠描画後に祝日を差し直し（初回含め順序を安定させる）
  const vview = calendar.view;
  refreshHolidayEvents(calendar, { start: vview.activeStart, end: vview.activeEnd });

  renderSummary(sums);

  monthListSorted = monthRaw.sort(compareByDateTime);

  // ★ カレンダーの現在月をキー化
  const key = `${viewYm.y}-${String(viewYm.m+1).padStart(2,'0')}`;
  // 月が変わった場合のみ 1ページ目に戻す（同月内の再描画ではページ維持）
  if (lastViewYmKey !== key) {
    currentPage = 1;
    lastViewYmKey = key;
  }
  renderListPaged();
  
}


document.addEventListener('DOMContentLoaded', () => {
  const prev = document.getElementById('page-prev');
  const next = document.getElementById('page-next');

  if (prev) prev.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      renderListPaged();   // ← ページを描画
    }
  });

  if (next) next.addEventListener('click', () => {
    if (currentPage < totalPages()) {
      currentPage++;
      renderListPaged();   // ← ページを描画
    }
  });
  
});
//クリック時の念押し（誤送信防止 & 即時再描画）
document.addEventListener('DOMContentLoaded', () => {
  const prev = document.getElementById('page-prev');
  const next = document.getElementById('page-next');

  if (prev) prev.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (currentPage > 1) {
      currentPage--;
      renderListPaged();
    }
  });

  if (next) next.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (currentPage < totalPages()) {
      currentPage++;
      renderListPaged();
    }
  });
});

function renderSummary(sums) {
  const box = document.getElementById('summary');
  box.replaceChildren();

  if (!sums || Object.keys(sums).length === 0) {
    const message = document.createElement('p');
    message.textContent = '今月のデータはまだありません。';
    box.appendChild(message);
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  for (const label of [
    '社員',
    '合計h',
    '有給h',
    '残業h',
    '特別h',
    '休日出勤h'
  ]) {
    const th = document.createElement('th');
    th.textContent = label;
    headerRow.appendChild(th);
  }

  thead.appendChild(headerRow);

  const tbody = document.createElement('tbody');
  const fmt = n => (Math.round(n * 10) / 10).toFixed(1);

  for (const s of Object.values(sums)) {
    const row = document.createElement('tr');

    const values = [
      s.name ?? '',
      fmt(s.total),
      fmt(s.paid),
      fmt(s.overtime),
      fmt(s.special),
      fmt(s.holiday)
    ];

    for (const value of values) {
      const td = document.createElement('td');
      td.textContent = value;
      row.appendChild(td);
    }

    tbody.appendChild(row);
  }

  table.append(thead, tbody);
  box.appendChild(table);
}

// ユーティリティ：チェックされた曜日配列を取得（0=日,1=月,...6=土）
function getSelectedWeekdays() {
  const nodes = document.querySelectorAll('input[name="rule-weekdays"]:checked');
  return Array.from(nodes).map(n => parseInt(n.value, 10));
}

// ユーティリティ：曜日チェックを全解除（リセット用）
function resetSelectedWeekdays() {
  document.querySelectorAll('input[name="rule-weekdays"]:checked').forEach(n => n.checked = false);
}

// ===== 毎週ルール =====
// 重要ポイント：weekday→weekdays（配列）/ “休業(closed)”はhoursを0に寄せる
async function addWeeklyRule(){
  const user = auth.currentUser;
  const ruleEmpEl   = document.getElementById('rule-employee');
  const employeeId  = ruleEmpEl.value;
  const weekdays    = getSelectedWeekdays();               // ← 複数
  const startDate   = document.getElementById('rule-start').value;
  const endDate     = document.getElementById('rule-end').value;
  const hoursRaw    = document.getElementById('rule-hours').value;
  const hoursNum    = parseFloat(hoursRaw === '' ? 'NaN' : hoursRaw);
  const type        = document.getElementById('rule-type').value; // 'work'|'off'|'remote'|'closed'
  const note        = (document.getElementById('rule-note').value || '').trim();

  if (!user) {
    alert('ルールを登録するにはログインが必要です');
    return;
  }

  if(!employeeId || !startDate || !endDate){
    alert('社員・期間を入力してください');
    return;
  }
  if(weekdays.length === 0){
    alert('曜日を1つ以上選択してください');
    return;
  }

  const s = new Date(startDate);
  const e = new Date(endDate);
  if (isNaN(s) || isNaN(e) || s > e) {
    alert('開始日/終了日が不正です');
    return;
  }

  const employeeName =
    (empMap && empMap[employeeId]) ||
    document.querySelector(`#rule-employee option[value="${employeeId}"]`)?.textContent ||
    '';

  // “休業”は自然に0h、未入力なら0に寄せる。明示入力があればそれを使う
  const normalizedHours =
    (type === 'closed')
      ? 0
      : (isNaN(hoursNum) ? 0 : hoursNum);

  // ルール自体の保存（新スキーマ：weekdays 配列）
  const rule = {
    employeeId,
    employeeName,
    weekdays,                    // ← 配列で保持 [1,2,3] 等
    // 旧: weekday は保存しない（読み側で互換レイヤを用意している前提）
    startDate,                   // 'YYYY-MM-DD'
    endDate,
    hours: normalizedHours,
    type,                        // 'work' | 'off' | 'remote' | 'closed'
    note,
    createdByUid: user.uid,
    createdAt: Date.now()
  };

  const newRuleRef = await push(ref(db,'weeklyRules'), rule);
  const ruleId = newRuleRef.key;

  // 既存エントリ重複チェック用セット（employeeId_date_type）
  const existing = new Set();

  const existingRangeQuery = query(
    ref(db, 'kintai'),
    orderByChild('date'),
    startAt(startDate),
    endAt(endDate)
  );

  const kintaiSnap = await get(existingRangeQuery);

  if (kintaiSnap.exists()) {
    kintaiSnap.forEach(cs => {
      const v = cs.val();
      existing.add(`${v.employeeId}_${v.date}_${v.type}`);
    });
  }

  const fmt = d => {
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const dd= String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${dd}`;
  };

  const entriesRef = ref(db,'kintai');
  let added = 0;

  // 展開：全期間を1日ずつ進め、選択曜日に一致する日だけ追加
  const walk = new Date(s);
  while (walk <= e) {
    const dow = walk.getDay();              // 0=日
    if (weekdays.includes(dow)) {
      const ymd = fmt(walk);
      const key = `${employeeId}_${ymd}_${type}`;
      if (!existing.has(key)) {
        await push(entriesRef, {
          employeeId, 
          employeeName,
          date: ymd,
          start: '',
          hours: normalizedHours,          // “休業”は0
          type, 
          note,
          viaRule: true,
          sourceRuleId: ruleId,
          createdByUid: user.uid,
          createdAt: Date.now()
        });
        existing.add(key);
        added++;
      }
    }
    walk.setDate(walk.getDate()+1);
  }

  alert(`ルールを追加し、${startDate}〜${endDate} に ${added} 件展開しました。`);

  // 入力リセット
  ruleEmpEl.value = '';
  if (ruleEmpEl.value !== '') ruleEmpEl.selectedIndex = 0;
  resetSelectedWeekdays();                   // ← 単一 select の代わりに複数チェックを解除
  document.getElementById('rule-start').value   = '';
  document.getElementById('rule-end').value     = '';
  document.getElementById('rule-hours').value   = (type === 'closed' ? '0' : '8');
  document.getElementById('rule-type').value    = 'work'; // 既定値
  document.getElementById('rule-note').value    = '';
}
window.addWeeklyRule = addWeeklyRule;


const deletingRuleIds = new Set();

async function deleteRuleAndEntries(ruleId) {
  if (!ruleId || deletingRuleIds.has(ruleId)) return;

  if (!auth.currentUser) {
    alert('ログインしてください');
    return;
  }

  deletingRuleIds.add(ruleId);

  try {
    const ruleRef = ref(db, 'weeklyRules/' + ruleId);
    const ruleSnap = await get(ruleRef);

    if (!ruleSnap.exists()) {
      alert('ルールが見つかりません。画面を再読み込みしてください。');
      return;
    }

    const entriesQuery = query(
      ref(db, 'kintai'),
      orderByChild('sourceRuleId'),
      equalTo(ruleId)
    );

    const entriesSnap = await get(entriesQuery);
    const count = entriesSnap.size;

    if (!confirm(
      `このルールと、このルールから作成された予定 ${count} 件を削除します。\n` +
      '過去・未来の予定を含みます。よろしいですか？'
    )) {
      return;
    }

    const updates = {
      [`weeklyRules/${ruleId}`]: null
    };

    entriesSnap.forEach(child => {
      updates[`kintai/${child.key}`] = null;
    });

    // 予定とルールを1回の更新で削除する。
    await update(ref(db), updates);

    alert(`ルールと予定 ${count} 件を削除しました。`);
  } catch (error) {
    console.error('[deleteRuleAndEntries]', error);

    alert(
      '削除できませんでした。\n' +
      '一括削除は確定していません。権限や通信状態を確認してください。'
    );
  } finally {
    deletingRuleIds.delete(ruleId);
  }
}

// 週の日本語表記ヘルパ
function formatWeekdays(v){
  const names = ['日','月','火','水','木','金','土'];
  if (Array.isArray(v.weekdays) && v.weekdays.length){
    // 数値昇順＆重複排除
    const uniq = Array.from(new Set(v.weekdays.map(n => Number(n)))).sort((a,b)=>a-b);
    return uniq.map(n => names[n] ?? '').join(',');
  }
  // 後方互換（旧: 単一 weekday）
  if (typeof v.weekday === 'number') return names[Number(v.weekday)] || '日';
  return '-';
}

// 種別ラベル（既存の typeLabel を差し替え or これを使う）
function typeLabelJP(t){
  return t === 'work'   ? '勤務' :
         t === 'off'    ? '休暇' :
         t === 'remote' ? '在宅' :
         t === 'closed' ? '休業' :
         t === 'paid'   ? '有給' :
         t === 'overtime' ? '残業' :
         t === 'special'  ? '特別休暇' :
         t === 'holiday'  ? '休日出勤' : (t || '');
}

function renderWeeklyRules(snap) {
  const ruleList = document.getElementById('rule-list');
  ruleList.replaceChildren();

  snap.forEach(c => {
    const id = c.key;
    const v = c.val();
    const name = v.employeeName || empMap[v.employeeId] || '社員';

    const wkStr = formatWeekdays(v);
    const typeJa = typeLabelJP(v.type);
    const hoursText =
      v.type === 'closed' ? '0h' : `${v.hours || 0}h`;

    const li = document.createElement('li');

    const text = document.createElement('span');
    text.textContent =
      `社員: ${name}（ID:${v.employeeId}） 週:${wkStr} ` +
      `期間:${v.startDate}〜${v.endDate} ` +
      `種別:${typeJa} ${hoursText}` +
      (v.note ? ` ※${v.note}` : '');

    const actions = document.createElement('span');

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'danger';
    deleteButton.textContent = 'ルールと予定の削除';

    deleteButton.addEventListener('click', async () => {
      deleteButton.disabled = true;

      try {
        await deleteRuleAndEntries(id);
      } finally {
        deleteButton.disabled = false;
      }
    });

    actions.appendChild(deleteButton);
    li.append(text, actions);
    ruleList.appendChild(li);
  });
}

// ===== Excel エクスポート（今月・社員別シート） =====
document.getElementById('btn-export-xlsx').addEventListener('click', () => {
  if (!latestMonthData.length) {
    alert('今月のデータがありません');
    return;
  }
  const XLSX = window.XLSX;

  const agg = {};
  const details = {};

  const typeJa = (t) =>
    t === 'work'     ? '勤務' :
    t === 'off'      ? '休暇' :
    t === 'remote'   ? '在宅' :
    t === 'closed'   ? '休業' :
    t === 'paid'     ? '有給' :
    t === 'overtime' ? '残業' :
    t === 'special'  ? '特別休暇' :
    t === 'holiday'  ? '休日出勤' : (t || '');

  for (const r of latestMonthData) {
    const id = r.employeeId || '';
    const name = r.employee || '';
    if (!agg[id]) {
      agg[id] = {
        id, name,
        // 週ルール系
        work:0, off:0, remote:0, closed:0,
        // 既存の種別
        paid:0, overtime:0, special:0, holiday:0,
        total:0
      };
    }
    if (!details[id]) details[id] = [];

    // 時間。欠損や文字にも強く
    const h = parseFloat(r.hours || 0) || 0;

    // 種別ごとの加算
    if (r.type === 'work')       agg[id].work     += h;
    else if (r.type === 'off')   agg[id].off      += h;     // 0h運用なら影響なし
    else if (r.type === 'remote')agg[id].remote   += h;
    else if (r.type === 'closed')agg[id].closed   += h;     // “休業”は通常0h
    else if (r.type === 'paid')  agg[id].paid     += h;
    else if (r.type === 'overtime') agg[id].overtime += h;
    else if (r.type === 'special')  agg[id].special  += h;
    else if (r.type === 'holiday')  agg[id].holiday  += h;

    // 合計（時間に応じて集計。0hは自然に合計へ影響なし）
    agg[id].total += h;

    details[id].push({
      'ID': r.id,
      '日付': r.date,
      '社員ID': r.employeeId,
      '社員名': r.employee,
      '開始時刻': r.start || '',
      '時間(h)': h,
      '種別': typeJa(r.type),
      '備考': r.note || ''
    });
  }

  const wb = XLSX.utils.book_new();

  const fmt = (n) => (Math.round((n || 0) * 10) / 10);

  // 集計行（列を追加）
  const sumRows = [['社員ID','社員名','勤務(h)','休暇(h)','在宅(h)','休業(h)','有給(h)','残業(h)','特別休暇(h)','休日出勤(h)','合計(h)']];
  Object.values(agg)
    .sort((a,b) => (a.name || '').localeCompare(b.name || '', 'ja'))
    .forEach(s => {
      sumRows.push([
        s.id, s.name,
        fmt(s.work), fmt(s.off), fmt(s.remote), fmt(s.closed),
        fmt(s.paid), fmt(s.overtime), fmt(s.special), fmt(s.holiday),
        fmt(s.total)
      ]);
    });
  const sumWs = XLSX.utils.aoa_to_sheet(sumRows);
  XLSX.utils.book_append_sheet(wb, sumWs, '社員別集計');

  // 明細シート（各社員1枚）
  Object.entries(details).forEach(([empId, rows]) => {
    const headers = ['ID','日付','社員ID','社員名','開始時刻','時間(h)','種別','備考'];
    const data = [headers, ...rows.map(r => headers.map(h => r[h]))];
    const ws = XLSX.utils.aoa_to_sheet(data);

    const rawName = (agg[empId]?.name || '社員');
    const safe = (rawName + `(${empId})`).replace(/[\\/?*\[\]:]/g, '').slice(0,31);
    XLSX.utils.book_append_sheet(wb, ws, safe || '明細');
  });

  const now = calendar.getDate();
  const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  XLSX.writeFile(wb, `勤怠_社員別_${ym}.xlsx`);
});

// ===== Service Worker 更新検知 =====
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // 新しいSWがアクティブ化されたらリロード
    window.location.reload();
  });

  navigator.serviceWorker.register('/service-worker.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      newWorker?.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          // ここで「更新があります」通知を出してもよい
          console.log('[SW] 新しいバージョンがインストールされました');
          // 即適用する場合は↓を送る
          if (confirm('新しいバージョンがあります。更新しますか？')) {
            newWorker.postMessage({ type: 'SKIP_WAITING' });
          }
        }
      });
    });
  });
}
