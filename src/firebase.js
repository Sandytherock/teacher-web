import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Public Firebase config (same as mobile app)
const firebaseConfig = {
  apiKey: "AIzaSyB4AEEI215rFjys0gJaelaF-WTyGpJkhNE",
  authDomain: "test-yodha-01.firebaseapp.com",
  projectId: "test-yodha-01",
  storageBucket: "test-yodha-01.firebasestorage.app",
  messagingSenderId: "73266695919",
  appId: "1:73266695919:web:c1549231a631bbcf39d51a",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
const db = getFirestore(app);

export { auth, provider, db };
