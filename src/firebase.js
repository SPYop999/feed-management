// src/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDy-sx4FF_hRwqWSKZky5bweO-KmLi3dDo",
  authDomain: "godown-cfeb1.firebaseapp.com",
  projectId: "godown-cfeb1",
  storageBucket: "godown-cfeb1.appspot.com",
  messagingSenderId: "1047339450121",
  appId: "1:1047339450121:web:fc4902ce0a6d8f077b5dd8"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
