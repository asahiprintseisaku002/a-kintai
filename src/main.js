import { auth } from "./firebase";
import { onAuthStateChanged } from "firebase/auth";

onAuthStateChanged(auth, (user) => {
  console.log("ログイン状態:", user);
});

// ここに app.js のロジックを取り込んでいく
