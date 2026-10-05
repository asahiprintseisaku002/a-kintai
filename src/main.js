import { db, auth } from './firebase';
import {
  ref, push, onValue, remove, get, set, update, query, orderByChild
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
import {
  getMessaging, getToken, onMessage, isSupported
} from 'firebase/messaging';
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
    console.warn('メール確認送信失敗:', e);
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
    alert('ログイン失敗: ' + e.message);
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

onAuthStateChanged(auth, (user)=> {
  document.getElementById('btn-login').style.display  = user ? 'none' : 'inline-block';
  document.getElementById('btn-logout').style.display = user ? 'inline-block' : 'none';
});

// ===============================
//  FCM 初期化（未対応環境に配慮）
// ===============================
let messaging = null;
const VAPID_KEY = 'BB-1ckiTojBNB4f5RvrTgUSL75jP3K50GzjU9FdiLmTw7WkskKqhTFxfXCfSB3j2F-q9IKXpX6Ib5YTOGckS7AI';

// サービスワーカー登録（存在しなければ登録）
async function ensureServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;

  // FCM 専用の SW を使う場合は firebase-messaging-sw.js を登録
  // すでに PWA の service-worker.js を使う場合はそちらでも可
  try {
    return await navigator.serviceWorker.register('/firebase-messaging-sw.js');
  } catch {
    // フォールバック：PWA側を登録
    return await navigator.serviceWorker.register('/service-worker.js');
  }
}

async function initMessaging() {
  if (await isSupported()) {
    messaging = getMessaging();
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
    await set(ref(db, 'fcmTokens/' + token), {
      active: true,
      ua: navigator.userAgent,
      updatedAt: Date.now()
    });
    console.log('[FCM] token saved');
  } catch (e) {
    console.warn('[FCM] failed to save token:', e);
  }
  //console.log('FCMトークン:', token);
  return token;
}

function setupOnMessage() {
  if (!messaging) return;
  onMessage(messaging, (payload) => {
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
//  Webhook 設定のロード
// ===============================
async function loadWebhookConfig(){
  const res = await fetch('https://bmsys777.xsrv.jp/a-kintai/config.php', { cache: 'no-store' });
  const cfg = await res.json();
  window.NOTIFY_WEBHOOK_URL   = cfg.webhookUrl;
  window.NOTIFY_WEBHOOK_TOKEN = cfg.webhookToken;
}

try {
  await loadWebhookConfig();
} catch (error) {
  console.warn(
    '[通知設定] config.phpを取得できなかったため、通知なしで続行します。',
    error
  );
}

// ===============================
//  ユーティリティなど（既存）
// ===============================

const GMAIL_ONLY = false;
const isGmail = (email) => /@gmail\.com$|@googlemail\.com$/i.test(String(email||'').trim());

async function getAdminsWithEmail(db){
  const snap = await get(ref(db, 'employees'));
  const admins = [];
  if (snap.exists()) {
    snap.forEach(c => {
      const v = c.val() || {};
      if (v.isAdmin && v.email) {
        if (!GMAIL_ONLY || isGmail(v.email)) {
          admins.push({ id: c.key, name: v.name || '', email: String(v.email).trim() });
        }
      }
    });
  }
  return admins;
}

async function notifyAdmins(kind, payload) {
  if (!window.NOTIFY_WEBHOOK_URL || !window.NOTIFY_WEBHOOK_TOKEN) return;
  const admins = await getAdminsWithEmail(db);
  if (!admins.length) return;

  const buildUrl = (to) => {
    const u = new URL(window.NOTIFY_WEBHOOK_URL);
    u.searchParams.set('token',   String(window.NOTIFY_WEBHOOK_TOKEN || ''));
    u.searchParams.set('kind',    String(kind || 'notify'));
    u.searchParams.set('to',      JSON.stringify(to));
    u.searchParams.set('payload', JSON.stringify(payload || {}));
    u.searchParams.set('src_host', location.host);
    u.searchParams.set('build', 'GET-IMG-2025-08-20');
    u.searchParams.set('v', String(Date.now()));
    return u.toString();
  };

  const tasks = admins.map(a => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.src = buildUrl({ name: a.name, email: a.email });
    window.__lastPing = img;
    return Promise.resolve();
  });
  await Promise.allSettled(tasks);
}

// ===============================
//  認証状態に応じて DB 購読の開始/停止
// ===============================
// ---- 購読のハンドル ----
let stopPublic = null;
let stopPrivate = null;

// 公開購読（起動時に一度だけ開始）
function startPublicSubscriptions() {
  if (stopPublic) return;
  const unsubs = [];

  unsubs.push(onValue(ref(db, 'weeklyRules'), (snap) => {
    // 週ルールの描画があるならここに
    // ruleList を再描画する既存処理を呼ぶ等
  }));

  // 公開の社員情報を持つならここで
  // unsubs.push(onValue(ref(db, 'employees_public'), ...));

  stopPublic = () => { 
    unsubs.forEach(fn => fn()); 
    stopPublic = null; };
}

// プライベート購読（ログイン後に開始・ログアウトで停止）
function startPrivateSubscriptions() {
  if (stopPrivate) return;
  const unsubs = [];

  // 要認証のパス（employees）
  const q = query(ref(db, 'employees'), orderByChild('order'));
  unsubs.push(onValue(q, (snap) => {
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
  }));

    // 勤怠情報の監視
  unsubs.push(onValue(
    ref(db, 'kintai'),
    (snap) => {
      lastKintaiSnap = snap;

      if (employeesLoaded) {
        renderFromKintai(snap);
      }
    },
    (error) => {
      console.error('[kintai] データの取得に失敗しました:', error);
    }
  ));

  stopPrivate = () => { unsubs.forEach(fn => fn()); stopPrivate = null; };
}

// ===== 起動時に公開購読だけ開始 =====
startPublicSubscriptions();

// ===== 認証状態 =====
onAuthStateChanged(auth, async (user) => {
  const s = document.getElementById('login-status');

  if (user) {
    const isVerified = !!user.emailVerified;
    s && (s.textContent = `ログイン中: ${user.email || user.uid}${isVerified ? '' : '（メール未確認）'}`);
    setWriteEnabled(true);

    startPrivateSubscriptions();   // ここで private を開始

    // FCM（必要なら verified で条件付け）
    await initMessaging();
    setupOnMessage();
    if (isVerified) {
      await requestPermissionAndGetToken();
    } else {
      console.log('[FCM] skip: email not verified yet');
    }
  } else {
    s && (s.textContent = '未ログイン');
    setWriteEnabled(false);
    stopPrivate && stopPrivate();  // private 停止（public は維持）
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

onAuthStateChanged(auth, async (user) => {
  togglePrivateUI(!!user);

  if (user) {
    // 書き込み許可
    setWriteEnabled(true);
    startPrivateSubscriptions();
  } else {
    // 書き込み不可
    setWriteEnabled(false);
    stopPrivate && stopPrivate();
  }
});


// ページロード時に一度トークン取得を試す（任意でボタン連携に）
document.addEventListener('DOMContentLoaded', () => {
  requestPermissionAndGetToken();

  const btn = document.getElementById('btn-enable-push');
  if (btn) btn.addEventListener('click', () => requestPermissionAndGetToken());
});


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
    li.innerHTML = `
      <span>${dateLabel} ${v.start || ''} ${title}</span>
      <span class="item-actions">
        <button onclick="openModal(${JSON.stringify({
          employeeId:v.employeeId,
          employeeName: empName,
          date:v.date, start:v.start, hours:v.hours, type:v.type, note:v.note
        }).replace(/"/g,'&quot;')}, '${v.id}')">編集</button>
        <button class="danger" onclick="deleteEntry('${v.id}')">削除</button>
      </span>`;
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
  const kSnap = await get(ref(db,'kintai'));
  let used = false;
  if(kSnap.exists()){
    kSnap.forEach(c=>{ if(c.val().employeeId===empId) used = true; });
  }
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
    li.innerHTML = `
      <span class="emp-line">
        <span class="drag" title="ドラッグで並び替え">⠿</span>
        <span class="emp-name">${name}</span>
        ${isAdmin ? '<span class="badge-admin">管理者</span>' : ''}
        ${email ? `<span class="emp-contact">📧 ${email}</span>` : ''}
        ${sms   ? `<span class="emp-contact">📱 ${sms}</span>`   : ''}
      </span>
      <span>
        <button onclick="openEmpModal('${id}')">編集</button>
        <button class="danger" onclick="deleteEmployee('${id}')">削除</button>
      </span>`;
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


function submitKintai(){
  const employeeId = document.getElementById('employee').value;
  const date  = document.getElementById('date').value;
  const start = document.getElementById('start').value;
  const hours = parseFloat(document.getElementById('hours').value || '0');
  const type  = document.getElementById('type').value;
  const note  = (document.getElementById('note').value || '').trim();

  if (!employeeId || !date || !type) return alert('項目を入力してください');

  const employeeName =
    empMap[employeeId] ||
    document.querySelector(`#employee option[value="${employeeId}"]`)?.textContent ||
    '';

  const payload = {
    employeeId, employeeName,
    date, start, hours, type, note,
    createdAt: Date.now()
  };

  push(ref(db,'kintai'), payload).then(()=>{
    alert('登録しました');
    notifyAdmins('created', payload);
  });

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

    // 4) 通知（GET 画像ピクセル版 notifyAdmins を既に採用している前提）
    await notifyAdmins('deleted', { id, old });

    console.log('[deleteEntry] notified deleted:', { id });
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

    await set(entryRef, payloadNew);
    await notifyAdmins('updated', { id, old, new: payloadNew }); // ← await 推奨

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
const calendar = new FullCalendar.Calendar(document.getElementById('calendar'), {
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

function renderSummary(sums){
  const box = document.getElementById('summary');
  if(!sums || Object.keys(sums).length===0){
    box.innerHTML = '<p>今月のデータはまだありません。</p>';
    return;
  }
  let html = '<table><thead><tr><th>社員</th><th>合計h</th><th>有給h</th><th>残業h</th><th>特別h</th><th>休日出勤h</th></tr></thead><tbody>';
  const fmt = n => (Math.round(n*10)/10).toFixed(1);
  Object.values(sums).forEach(s=>{
    html += `<tr><td>${s.name}</td><td>${fmt(s.total)}</td><td>${fmt(s.paid)}</td><td>${fmt(s.overtime)}</td><td>${fmt(s.special)}</td><td>${fmt(s.holiday)}</td></tr>`;
  });
  html += '</tbody></table>';
  box.innerHTML = html;
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
  const ruleEmpEl   = document.getElementById('rule-employee');
  const employeeId  = ruleEmpEl.value;
  const weekdays    = getSelectedWeekdays();               // ← 複数
  const startDate   = document.getElementById('rule-start').value;
  const endDate     = document.getElementById('rule-end').value;
  const hoursRaw    = document.getElementById('rule-hours').value;
  const hoursNum    = parseFloat(hoursRaw === '' ? 'NaN' : hoursRaw);
  const type        = document.getElementById('rule-type').value; // 'work'|'off'|'remote'|'closed'
  const note        = (document.getElementById('rule-note').value || '').trim();

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
    createdAt: Date.now()
  };

  const newRuleRef = await push(ref(db,'weeklyRules'), rule);
  const ruleId = newRuleRef.key;

  // 既存エントリ重複チェック用セット（employeeId_date_type）
  const existing = new Set();
  const kintaiSnap = await get(ref(db,'kintai'));
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
          employeeId, employeeName,
          date: ymd,
          start: '',
          hours: normalizedHours,          // “休業”は0
          type, note,
          viaRule: true,
          sourceRuleId: ruleId,
          createdAt: Date.now()
        });
        existing.add(key);
        added++;
      }
    }
    walk.setDate(walk.getDate()+1);
  }

  alert(`ルールを追加し、${startDate}〜${endDate} に ${added} 件展開しました。`);

  // 通知（payloadを最新スキーマに）
  notifyAdmins('rule-expanded', {
    ruleId, employeeId, employeeName, startDate, endDate,
    weekdays, hours: normalizedHours, type, note, added
  });

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


async function deleteKintaiByRule(ruleId){
  if (!ruleId) return;
  const snap = await get(ref(db, 'kintai'));
  if (!snap.exists()) { alert('削除対象の予定がありません'); return; }

  const targets = [];
  snap.forEach(cs => {
    const v = cs.val();
    if (v.sourceRuleId === ruleId) targets.push({ id: cs.key, ...v });
  });

  if (!targets.length) {
    alert('このルール由来の予定は見つかりませんでした');
    return;
  }

  if (!confirm(`ルールID: ${ruleId} 由来の予定 ${targets.length} 件を削除します。よろしいですか？`)) return;

  await Promise.all(targets.map(t => remove(ref(db, 'kintai/'+t.id))));
  alert(`予定を ${targets.length} 件削除しました`);
  notifyAdmins('rule-deleted', { ruleId, deletedCount: targets.length });
}
window.deleteKintaiByRule = deleteKintaiByRule;

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

const ruleList = document.getElementById('rule-list');
onValue(ref(db,'weeklyRules'), (snap)=>{
  ruleList.innerHTML='';
  snap.forEach(c=>{
    const id = c.key;
    const v  = c.val();
    const name = v.employeeName || (empMap[v.employeeId] || '社員');

    const wkStr = formatWeekdays(v);
    const typeJa = typeLabelJP(v.type);
    const hoursText = (v.type === 'closed') ? '0h' : `${v.hours || 0}h`;

    const li = document.createElement('li');
    //li.className = 'rule-item compact';
    li.innerHTML = `
      <span>
        社員: ${name}（ID:${v.employeeId}） 週:${wkStr}
        期間:${v.startDate}〜${v.endDate} 種別:${typeJa} ${hoursText}
        ${v.note ? ' ※' + v.note : ''}
      </span>
      <span>
        <button class="danger" onclick="deleteKintaiByRule('${id}')">予定一括削除</button>
        <button class="danger" onclick="removeRule('${id}')">ルール削除</button>
      </span>`;
    ruleList.appendChild(li);
  });
});
function removeRule(id){ if(confirm('このルールを削除しますか？')) remove(ref(db,'weeklyRules/'+id)); }
window.removeRule = removeRule;

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