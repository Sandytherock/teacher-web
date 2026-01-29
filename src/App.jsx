import React, { useEffect, useMemo, useRef, useState } from "react";
import AgoraRTC from "agora-rtc-sdk-ng";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  doc,
  serverTimestamp,
  addDoc,
  setDoc,
  deleteDoc,
} from "firebase/firestore";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { auth, provider, db } from "./firebase";
import { isTeacherEmail } from "./teacherAccess";

const TOKEN_ENDPOINT = "/api/agoraToken";

export default function App() {
  const [user, setUser] = useState(null);
  const [allowed, setAllowed] = useState(false);
  const [classes, setClasses] = useState([]);
  const [selected, setSelected] = useState(null);
  const [status, setStatus] = useState("Idle");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatText, setChatText] = useState("");
  const [hands, setHands] = useState([]);
  const [joined, setJoined] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const clientRef = useRef(null);
  const localTracksRef = useRef({ audio: null, video: null });
  const screenTrackRef = useRef(null);

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u || null);
      setAllowed(isTeacherEmail(u?.email));
    });
  }, []);

  useEffect(() => {
    const q = query(collection(db, "liveClasses"), orderBy("scheduledAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setClasses(items);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!selected?.id) return;
    const chatRef = collection(db, "liveClasses", selected.id, "chatMessages");
    const handsRef = collection(db, "liveClasses", selected.id, "hands");

    const chatUnsub = onSnapshot(query(chatRef, orderBy("createdAt", "asc")), (snap) => {
      setChatMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    const handsUnsub = onSnapshot(handsRef, (snap) => {
      setHands(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return () => {
      chatUnsub();
      handsUnsub();
    };
  }, [selected?.id]);

  const canUse = useMemo(() => !!user && allowed, [user, allowed]);

  const signIn = async () => {
    await signInWithPopup(auth, provider);
  };

  const signOutNow = async () => {
    await signOut(auth);
  };

  const fetchToken = async (channelName) => {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelName, uid: 0, role: "broadcaster" }),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  };

  const joinClass = async () => {
    if (!selected?.agoraChannelName) return;
    setStatus("Joining...");
    const { token, appId } = await fetchToken(selected.agoraChannelName);
    const client = AgoraRTC.createClient({ mode: "live", codec: "vp8" });
    clientRef.current = client;
    client.setClientRole("host");
    await client.join(appId, selected.agoraChannelName, token, null);
    setJoined(true);
    setStatus("Joined");
    await updateDoc(doc(db, "liveClasses", selected.id), {
      status: "live",
      startedAt: serverTimestamp(),
    });
  };

  const leaveClass = async () => {
    const client = clientRef.current;
    if (!client) return;
    const { audio, video } = localTracksRef.current;
    if (audio) await client.unpublish(audio);
    if (video) await client.unpublish(video);
    if (screenTrackRef.current) await client.unpublish(screenTrackRef.current);

    audio && audio.close();
    video && video.close();
    screenTrackRef.current && screenTrackRef.current.close();
    localTracksRef.current = { audio: null, video: null };
    screenTrackRef.current = null;

    await client.leave();
    clientRef.current = null;
    setJoined(false);
    setPublishing(false);
    setStatus("Left");
  };

  const startCamera = async () => {
    if (!clientRef.current) return;
    const [audio, video] = await AgoraRTC.createMicrophoneAndCameraTracks();
    localTracksRef.current = { audio, video };
    await clientRef.current.publish([audio, video]);
    video.play("local-player");
    setPublishing(true);
    setStatus("Camera live");
  };

  const startScreenShare = async () => {
    if (!clientRef.current) return;
    const track = await AgoraRTC.createScreenVideoTrack({ encoderConfig: "1080p_1" }, "auto");
    screenTrackRef.current = track;
    await clientRef.current.publish(track);
    document.getElementById("local-player").innerHTML = "";
    track.play("local-player");
    setStatus("Screen share live");
  };

  const stopShare = async () => {
    if (!clientRef.current || !screenTrackRef.current) return;
    await clientRef.current.unpublish(screenTrackRef.current);
    screenTrackRef.current.close();
    screenTrackRef.current = null;
    setStatus("Screen share stopped");
    if (localTracksRef.current.video) {
      document.getElementById("local-player").innerHTML = "";
      localTracksRef.current.video.play("local-player");
    }
  };

  const endClass = async () => {
    if (!selected?.id) return;
    await updateDoc(doc(db, "liveClasses", selected.id), {
      status: "completed",
      endedAt: serverTimestamp(),
    });
    await leaveClass();
  };

  const sendChat = async () => {
    if (!selected?.id || !user || !chatText.trim()) return;
    await addDoc(collection(db, "liveClasses", selected.id, "chatMessages"), {
      text: chatText.trim(),
      userId: user.uid,
      userName: user.displayName || user.email,
      createdAt: serverTimestamp(),
    });
    setChatText("");
  };

  const clearHand = async (uid) => {
    if (!selected?.id) return;
    await deleteDoc(doc(db, "liveClasses", selected.id, "hands", uid));
  };

  return (
    <div className="wrap">
      <div className="header">
        <div className="title">Teacher Panel</div>
        <div className="hint">
          {user ? user.email : "Not signed in"}
        </div>
      </div>

      {!user ? (
        <div className="card">
          <button className="btn" onClick={signIn}>Sign in with Google</button>
        </div>
      ) : !allowed ? (
        <div className="card">
          <div>Access denied. Ask admin to add your email.</div>
          <button className="btn secondary" onClick={signOutNow} style={{ marginTop: 10 }}>
            Sign out
          </button>
        </div>
      ) : (
        <div className="grid">
          <div className="card">
            <div className="row">
              <label>Live / Upcoming Classes</label>
              <div className="list">
                {classes.map((c) => (
                  <div
                    key={c.id}
                    className="classItem"
                    onClick={() => setSelected(c)}
                    style={{ borderColor: selected?.id === c.id ? "#2563eb" : "var(--border)" }}
                  >
                    <div className="classTitle">{c.title || "Live Class"}</div>
                    <div className="badge">{c.status || "scheduled"}</div>
                    <div className="hint">{c.teacherName || "Teacher"}</div>
                    <div className="hint">Channel: {c.agoraChannelName}</div>
                  </div>
                ))}
              </div>

              <div className="controls">
                <button className="btn success" onClick={joinClass} disabled={!selected || joined}>
                  Join Class
                </button>
                <button className="btn secondary" onClick={leaveClass} disabled={!joined}>
                  Leave
                </button>
              </div>

              <div className="controls">
                <button className="btn" onClick={startCamera} disabled={!joined}>
                  Start Camera
                </button>
                <button className="btn" onClick={startScreenShare} disabled={!joined}>
                  Screen Share
                </button>
                <button className="btn danger" onClick={stopShare} disabled={!joined}>
                  Stop Share
                </button>
                <button className="btn danger" onClick={endClass} disabled={!joined}>
                  End Class
                </button>
              </div>

              <div className="status">{status}</div>
            </div>
          </div>

          <div className="card stage">
            <div id="local-player"></div>
          </div>

          <div className="card">
            <div className="panelTitle">Raised Hands</div>
            <div className="panel">
              {hands.length === 0 ? (
                <div className="hint">No hands raised</div>
              ) : (
                hands.map((h) => (
                  <div key={h.userId} className="chatItem">
                    {h.userName || h.userId}
                    <button
                      className="btn secondary"
                      style={{ marginLeft: 8, padding: "4px 8px", width: "auto" }}
                      onClick={() => clearHand(h.userId)}
                    >
                      Clear
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="card">
            <div className="panelTitle">Chat</div>
            <div className="panel">
              {chatMessages.map((m) => (
                <div key={m.id} className="chatItem">
                  <strong>{m.userName || "User"}:</strong> {m.text}
                </div>
              ))}
            </div>
            <div className="chatRow">
              <input
                placeholder="Type message..."
                value={chatText}
                onChange={(e) => setChatText(e.target.value)}
              />
              <button className="btn" onClick={sendChat}>Send</button>
            </div>
          </div>

          <div className="card">
            <button className="btn secondary" onClick={signOutNow}>Sign out</button>
          </div>
        </div>
      )}
    </div>
  );
}
