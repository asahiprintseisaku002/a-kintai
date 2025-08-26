import { auth } from './firebase';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';

// UI 切替の基点
onAuthStateChanged(auth, (user) => {
  document.body.classList.toggle('authed', !!user);
  document.body.classList.toggle('guest', !user);
});

// ログイン例（メール/パスワード）
export async function loginEmail(email, pw) {
  await signInWithEmailAndPassword(auth, email, pw);
}

// Google ログイン
export async function loginGoogle() {
  await signInWithPopup(auth, new GoogleAuthProvider());
}

// ログアウト
export async function logout() {
  await signOut(auth);
}
