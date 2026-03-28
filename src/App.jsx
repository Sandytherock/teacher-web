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
  deleteDoc,
} from "firebase/firestore";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { auth, provider, db } from "./firebase";
import { isTeacherEmail } from "./teacherAccess";

const API_BASE = "https://tokenyodha-api-two.vercel.app/api";
const TOKEN_ENDPOINT = `${API_BASE}/agoraToken`;
const RECORDING_START_ENDPOINT = `${API_BASE}/agoraRecordingStart`;
const RECORDING_STOP_ENDPOINT = `${API_BASE}/agoraRecordingStop`;
const RECORDING_QUERY_ENDPOINT = `${API_BASE}/agoraRecordingQuery`;
const FALLBACK_APP_ID = "f62387c2a1f74173a83a882fbd37b2f9";
const LANDSCAPE_WIDTH = 1280;
const LANDSCAPE_HEIGHT = 720;
const LANDSCAPE_ASPECT = LANDSCAPE_WIDTH / LANDSCAPE_HEIGHT;
const LANDSCAPE_ENCODER_CONFIG = {
  width: LANDSCAPE_WIDTH,
  height: LANDSCAPE_HEIGHT,
  frameRate: 30,
  bitrateMin: 1200,
  bitrateMax: 3000,
};
const SCREEN_PREVIEW_CONFIG = { fit: "contain", mirror: false };

export default function App() {
  const [user, setUser] = useState(null);
  const [allowed, setAllowed] = useState(false);
  const [classes, setClasses] = useState([]);
  const [selected, setSelected] = useState(null);
  const [status, setStatus] = useState("Idle");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatText, setChatText] = useState("");
  const [hands, setHands] = useState([]);
  const [reactionsFeed, setReactionsFeed] = useState([]);
  const [joined, setJoined] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [videoStats, setVideoStats] = useState(null);

  const clientRef = useRef(null);
  const localTracksRef = useRef({ audio: null, video: null });
  const videoSourceRef = useRef(null);
  const videoPipelineRef = useRef(null);
  const statsIntervalRef = useRef(null);
  const recordingStartRequestedRef = useRef(false);
  const recordingStopRequestedRef = useRef(false);
  const [recordingSession, setRecordingSession] = useState({
    resourceId: null,
    sid: null,
    recorderUid: null,
  });

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
    const reactionsRef = collection(db, "liveClasses", selected.id, "reactions");

    const chatUnsub = onSnapshot(query(chatRef, orderBy("createdAt", "asc")), (snap) => {
      setChatMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    const handsUnsub = onSnapshot(handsRef, (snap) => {
      setHands(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    const reactionsUnsub = onSnapshot(
      query(reactionsRef, orderBy("createdAt", "desc")),
      (snap) => {
        setReactionsFeed(snap.docs.map((d) => ({ id: d.id, ...d.data() })).slice(0, 12));
      }
    );
    return () => {
      chatUnsub();
      handsUnsub();
      reactionsUnsub();
    };
  }, [selected?.id]);

  useEffect(() => {
    recordingStartRequestedRef.current = false;
    recordingStopRequestedRef.current = false;
    setRecordingSession({
      resourceId: selected?.recordingResourceId || null,
      sid: selected?.recordingSid || null,
      recorderUid: selected?.recordingRecorderUid || null,
    });
  }, [selected?.id, selected?.recordingResourceId, selected?.recordingSid, selected?.recordingRecorderUid]);

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
    const data = await res.json();
    if (!data?.token) throw new Error("Token API returned no token");
    return { token: data.token, appId: data.appId || FALLBACK_APP_ID };
  };

  const postRecordingRequest = async (url, body) => {
    if (!user) throw new Error("Teacher login required");
    const idToken = await user.getIdToken();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || data?.raw || `Recording API failed (${res.status})`);
    }

    return data;
  };

  const clearStatsPolling = () => {
    if (statsIntervalRef.current) {
      window.clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
    setVideoStats(null);
  };

  const startStatsPolling = () => {
    clearStatsPolling();
    statsIntervalRef.current = window.setInterval(() => {
      const client = clientRef.current;
      if (!client || !localTracksRef.current.video) {
        setVideoStats(null);
        return;
      }

      try {
        setVideoStats(client.getLocalVideoStats());
      } catch {
        setVideoStats(null);
      }
    }, 2000);
  };

  const stopVideoPipeline = () => {
    const pipeline = videoPipelineRef.current;
    if (pipeline?.cancelFrame) pipeline.cancelFrame();
    if (pipeline?.videoEl) {
      pipeline.videoEl.pause();
      pipeline.videoEl.srcObject = null;
    }
    if (pipeline?.stream) {
      pipeline.stream.getTracks().forEach((track) => track.stop());
    }
    videoPipelineRef.current = null;
  };

  const clearLocalPlayer = () => {
    const player = document.getElementById("local-player");
    if (player) player.innerHTML = "";
  };

  const drawLandscapeFrame = (ctx, sourceEl) => {
    const sourceWidth = sourceEl.videoWidth || LANDSCAPE_WIDTH;
    const sourceHeight = sourceEl.videoHeight || LANDSCAPE_HEIGHT;

    if (!sourceWidth || !sourceHeight) return;

    const sourceAspect = sourceWidth / sourceHeight;
    let sx = 0;
    let sy = 0;
    let sw = sourceWidth;
    let sh = sourceHeight;

    if (sourceAspect > LANDSCAPE_ASPECT) {
      sw = sourceHeight * LANDSCAPE_ASPECT;
      sx = (sourceWidth - sw) / 2;
    } else if (sourceAspect < LANDSCAPE_ASPECT) {
      sh = sourceWidth / LANDSCAPE_ASPECT;
      sy = (sourceHeight - sh) / 2;
    }

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, LANDSCAPE_WIDTH, LANDSCAPE_HEIGHT);
    ctx.drawImage(sourceEl, sx, sy, sw, sh, 0, 0, LANDSCAPE_WIDTH, LANDSCAPE_HEIGHT);
  };

  const createLandscapeVideoTrack = async (sourceTrack, { optimizationMode, mirror }) => {
    const sourceMediaTrack = sourceTrack.getMediaStreamTrack();
    const videoEl = document.createElement("video");
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.autoplay = true;
    videoEl.srcObject = new MediaStream([sourceMediaTrack]);

    await new Promise((resolve) => {
      if (videoEl.readyState >= 1) {
        resolve();
        return;
      }
      videoEl.onloadedmetadata = () => resolve();
    });
    await videoEl.play();

    const canvas = document.createElement("canvas");
    canvas.width = LANDSCAPE_WIDTH;
    canvas.height = LANDSCAPE_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Unable to create 2D canvas context");

    let rafId = null;
    let frameCallbackId = null;
    let stopped = false;

    const renderFrame = () => {
      if (stopped) return;
      drawLandscapeFrame(ctx, videoEl);

      if (typeof videoEl.requestVideoFrameCallback === "function") {
        frameCallbackId = videoEl.requestVideoFrameCallback(() => {
          renderFrame();
        });
      } else {
        rafId = window.requestAnimationFrame(renderFrame);
      }
    };

    renderFrame();

    const stream = canvas.captureStream(LANDSCAPE_ENCODER_CONFIG.frameRate);
    const [canvasTrack] = stream.getVideoTracks();
    const publishedTrack = AgoraRTC.createCustomVideoTrack({
      mediaStreamTrack: canvasTrack,
      encoderConfig: LANDSCAPE_ENCODER_CONFIG,
      optimizationMode,
    });
    await publishedTrack.setEncoderConfiguration(LANDSCAPE_ENCODER_CONFIG);

    return {
      track: publishedTrack,
      previewConfig: { fit: "contain", mirror },
      stream,
      videoEl,
      cancelFrame: () => {
        stopped = true;
        if (
          frameCallbackId !== null &&
          typeof videoEl.cancelVideoFrameCallback === "function"
        ) {
          videoEl.cancelVideoFrameCallback(frameCallbackId);
        }
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
        }
      },
    };
  };

  const unpublishCurrentVideo = async () => {
    const client = clientRef.current;
    const publishedTrack = localTracksRef.current.video;

    clearStatsPolling();

    if (client && publishedTrack) {
      await client.unpublish(publishedTrack);
    }

    if (publishedTrack) {
      publishedTrack.stop();
      publishedTrack.close();
    }

    if (videoSourceRef.current) {
      videoSourceRef.current.stop();
      videoSourceRef.current.close();
      videoSourceRef.current = null;
    }

    stopVideoPipeline();
    clearLocalPlayer();
    localTracksRef.current.video = null;
  };

  const publishProcessedVideo = async (sourceTrack, options) => {
    const processed = await createLandscapeVideoTrack(sourceTrack, options);
    videoSourceRef.current = sourceTrack;
    videoPipelineRef.current = processed;
    localTracksRef.current.video = processed.track;
    await clientRef.current.publish(processed.track);
    processed.track.play("local-player", processed.previewConfig);
    startStatsPolling();
  };

  const joinClass = async () => {
    if (!selected?.agoraChannelName) return;
    setStatus("Joining...");
    const { token, appId } = await fetchToken(selected.agoraChannelName);
    const client = AgoraRTC.createClient({ mode: "live", codec: "vp8" });
    clientRef.current = client;
    client.setClientRole("host");
    const teacherRtcUid = await client.join(appId, selected.agoraChannelName, token, null);
    setJoined(true);
    setStatus("Joined");
    const updates = {
      status: "live",
      startedAt: serverTimestamp(),
    };

    if (!recordingStartRequestedRef.current) {
      recordingStartRequestedRef.current = true;
      try {
        const recording = await postRecordingRequest(RECORDING_START_ENDPOINT, {
          classId: selected.id,
          courseId: selected.courseId,
          channelName: selected.agoraChannelName,
          teacherRtcUid,
        });

        setRecordingSession({
          resourceId: recording.resourceId,
          sid: recording.sid,
          recorderUid: recording.recorderUid,
        });

        updates.recordingStatus = "recording";
        updates.recordingStartedAt = serverTimestamp();
        updates.recordingResourceId = recording.resourceId;
        updates.recordingSid = recording.sid;
        updates.recordingRecorderUid = recording.recorderUid;
        updates.recordingError = null;
      } catch (error) {
        updates.recordingStatus = "start_failed";
        updates.recordingError = error?.message || "Failed to start cloud recording";
        setStatus(`Joined, recording failed: ${error?.message || error}`);
      }
    }

    await updateDoc(doc(db, "liveClasses", selected.id), updates);
    try {
      await startMic();
    } catch (e) {
      // ignore mic auto-start errors
    }
  };

  const leaveClass = async () => {
    const client = clientRef.current;
    if (!client) return;
    const { audio, video } = localTracksRef.current;
    if (audio) await client.unpublish(audio);
    if (video) await client.unpublish(video);

    audio && audio.close();
    clearStatsPolling();
    stopVideoPipeline();
    if (videoSourceRef.current) {
      videoSourceRef.current.stop();
      videoSourceRef.current.close();
      videoSourceRef.current = null;
    }
    clearLocalPlayer();
    localTracksRef.current = { audio: null, video: null };

    await client.leave();
    clientRef.current = null;
    setJoined(false);
    setPublishing(false);
    setMicOn(false);
    setCamOn(false);
    setScreenOn(false);
    setVideoStats(null);
    setStatus("Left");
  };

  const startMic = async () => {
    if (!clientRef.current) return;
    if (localTracksRef.current.audio) return;
    setStatus("Starting mic...");
    try {
      const audio = await AgoraRTC.createMicrophoneAudioTrack();
      if (audio.setVolume) audio.setVolume(100);
      localTracksRef.current.audio = audio;
      await clientRef.current.publish(audio);
      await audio.setEnabled(true);
      setMicOn(true);
      setPublishing(true);
      setStatus("Mic live");
    } catch (e) {
      setStatus(`Mic error: ${e?.message || e}`);
    }
  };

  const stopMic = async () => {
    if (!clientRef.current || !localTracksRef.current.audio) return;
    await clientRef.current.unpublish(localTracksRef.current.audio);
    localTracksRef.current.audio.close();
    localTracksRef.current.audio = null;
    setMicOn(false);
    setPublishing(!!localTracksRef.current.video);
    setStatus("Mic off");
  };

  const startCamera = async () => {
    if (!clientRef.current) return;
    if (localTracksRef.current.video) return;

    setStatus("Starting camera...");
    try {
      if (!localTracksRef.current.audio) {
        await startMic();
      }

      const sourceTrack = await AgoraRTC.createCameraVideoTrack({
        encoderConfig: LANDSCAPE_ENCODER_CONFIG,
        optimizationMode: "motion",
      });

      await publishProcessedVideo(sourceTrack, {
        optimizationMode: "motion",
        mirror: true,
      });
      setCamOn(true);
      setScreenOn(false);
      setPublishing(true);
      setStatus("Camera live 1280x720 (16:9)");
    } catch (e) {
      await unpublishCurrentVideo().catch(() => {});
      setCamOn(false);
      setStatus(`Camera error: ${e?.message || e}`);
    }
  };

  const stopCamera = async () => {
    if (!clientRef.current || !localTracksRef.current.video) return;
    await unpublishCurrentVideo();
    setCamOn(false);
    setScreenOn(false);
    setPublishing(!!localTracksRef.current.audio);
    setStatus("Camera off");
  };

  const startScreenShare = async () => {
    if (!clientRef.current) return;
    if (screenOn) return;

    setStatus("Starting screen share...");
    try {
      const track = await AgoraRTC.createScreenVideoTrack(
        { encoderConfig: LANDSCAPE_ENCODER_CONFIG, optimizationMode: "detail" },
        "auto"
      );
      const sourceTrack = Array.isArray(track) ? track[0] : track;

      if (localTracksRef.current.video) {
        await unpublishCurrentVideo();
      }

      if (localTracksRef.current.audio) {
        await localTracksRef.current.audio.setEnabled(true);
      }

      await publishProcessedVideo(sourceTrack, {
        optimizationMode: "detail",
        mirror: false,
      });
      videoPipelineRef.current.previewConfig = SCREEN_PREVIEW_CONFIG;
      localTracksRef.current.video.play("local-player", SCREEN_PREVIEW_CONFIG);
      setScreenOn(true);
      setCamOn(false);
      setPublishing(true);
      setStatus("Screen share live 1280x720 (16:9)");

      if (sourceTrack?.on) {
        sourceTrack.on("track-ended", () => {
          stopShare().catch(() => {});
        });
      }
    } catch (e) {
      await unpublishCurrentVideo().catch(() => {});
      setScreenOn(false);
      setStatus(`Share error: ${e?.message || e}`);
    }
  };

  const stopShare = async () => {
    if (!clientRef.current || !localTracksRef.current.video) return;
    await unpublishCurrentVideo();
    setScreenOn(false);
    setCamOn(false);
    setPublishing(!!localTracksRef.current.audio);
    setStatus("Screen share stopped");
  };

  const endClass = async () => {
    if (!selected?.id) return;
    try {
      const updates = {
        status: "completed",
        endedAt: serverTimestamp(),
      };

      const activeRecording = {
        resourceId: recordingSession.resourceId || selected.recordingResourceId,
        sid: recordingSession.sid || selected.recordingSid,
        recorderUid: recordingSession.recorderUid || selected.recordingRecorderUid,
      };

      if (
        !recordingStopRequestedRef.current &&
        activeRecording.resourceId &&
        activeRecording.sid &&
        activeRecording.recorderUid != null
      ) {
        recordingStopRequestedRef.current = true;
        try {
          const stopResult = await postRecordingRequest(RECORDING_STOP_ENDPOINT, {
            resourceId: activeRecording.resourceId,
            sid: activeRecording.sid,
            channelName: selected.agoraChannelName,
            recorderUid: activeRecording.recorderUid,
          });

          updates.recordingStatus = "processing";
          updates.recordingStoppedAt = serverTimestamp();
          updates.recordingStopResponse = stopResult.agoraResponse || null;
          updates.recordingFiles = Array.isArray(stopResult.recordingFiles)
            ? stopResult.recordingFiles
            : [];
          updates.recordingObjectKey =
            stopResult.primaryFile?.fileName ||
            stopResult.primaryFile?.filename ||
            null;
          updates.recordingError = null;

          try {
            const queryResult = await postRecordingRequest(RECORDING_QUERY_ENDPOINT, {
              resourceId: activeRecording.resourceId,
              sid: activeRecording.sid,
              channelName: selected.agoraChannelName,
              recorderUid: activeRecording.recorderUid,
            });
            updates.recordingQueryResponse = queryResult.agoraResponse || null;
          } catch (queryError) {
            updates.recordingQueryError =
              queryError?.message || "Failed to query cloud recording status";
          }
        } catch (stopError) {
          updates.recordingStatus = "stop_failed";
          updates.recordingError = stopError?.message || "Failed to stop cloud recording";
        }
      }

      await updateDoc(doc(db, "liveClasses", selected.id), updates);
    } finally {
      await leaveClass();
    }
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
                  Go Live
                </button>
                <button className="btn secondary" onClick={leaveClass} disabled={!joined}>
                  Leave
                </button>
              </div>

              <div className="toggleRow">
                <button
                  className={`toggleBtn ${micOn ? "active" : ""}`}
                  onClick={() => (micOn ? stopMic() : startMic())}
                  disabled={!joined}
                >
                  {micOn ? "Mic On" : "Mic Off"}
                </button>
                <button
                  className={`toggleBtn ${camOn ? "active" : ""}`}
                  onClick={() => (camOn ? stopCamera() : startCamera())}
                  disabled={!joined}
                >
                  {camOn ? "Camera On" : "Camera Off"}
                </button>
                <button
                  className={`toggleBtn ${screenOn ? "active" : ""}`}
                  onClick={() => (screenOn ? stopShare() : startScreenShare())}
                  disabled={!joined}
                >
                  {screenOn ? "Stop Share" : "Share Screen"}
                </button>
                <button className="toggleBtn danger" onClick={endClass} disabled={!joined}>
                  End Class
                </button>
              </div>

              <div className="status">{status}</div>
              {videoStats && (
                <div className="status">
                  Encoded {videoStats.sendResolutionWidth}x{videoStats.sendResolutionHeight}
                  {" | "}Capture {videoStats.captureResolutionWidth}x
                  {videoStats.captureResolutionHeight}
                  {" | "}Bitrate {Math.round((videoStats.sendBitrate || 0) / 1000)} kbps
                </div>
              )}
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
            <div className="panelTitle">Reactions</div>
            <div className="reactionFeed">
              {reactionsFeed.length === 0 ? (
                <div className="hint">No reactions yet</div>
              ) : (
                reactionsFeed.map((r) => (
                  <span key={r.id} className="reactionPill">
                    {r.emoji}
                  </span>
                ))
              )}
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
