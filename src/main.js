// src/main.js
import { auth, db, messaging } from './firebase';
import { onAuthStateChanged } from "firebase/auth";

// 認証状態監視
onAuthStateChanged(auth, (user) => {
  if (user) {
    console.log("ログイン中:", user.uid);
  } else {
    console.log("未ログイン");
  }
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
