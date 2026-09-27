import { useEffect, useRef, useState } from "react";
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Video,
  VideoOff,
  SwitchCamera,
  Volume2,
  X,
} from "lucide-react";

export function CallPanel({ calls }) {
  const localVideo = useRef(null);
  const remoteVideo = useRef(null);
  const dialog = useRef(null);
  const [playBlocked, setPlayBlocked] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const { call, local, remote } = calls;
  useEffect(() => {
    if (call && dialog.current && !dialog.current.open)
      dialog.current.showModal();
  }, [call]);
  useEffect(() => {
    if (localVideo.current) {
      localVideo.current.srcObject = local;
      localVideo.current.play().catch(() => {});
    }
  }, [local, call?.callId]);
  useEffect(() => {
    if (remoteVideo.current) {
      remoteVideo.current.srcObject = remote;
      if (remote)
        remoteVideo.current
          .play()
          .then(() => setPlayBlocked(false))
          .catch(() => setPlayBlocked(true));
    }
  }, [remote, call?.callId]);
  useEffect(() => {
    setElapsed(0);
    if (!call?.startedAt) return;
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - call.startedAt) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [call?.startedAt]);
  const status =
    call?.status === "connected"
      ? `${Math.floor(elapsed / 60)
          .toString()
          .padStart(2, "0")}:${(elapsed % 60).toString().padStart(2, "0")}`
      : {
          incoming: "Incoming call",
          preparing: "Waiting for microphone / camera…",
          ringing: "Ringing…",
          connecting: "Connecting…",
          reconnecting: "Reconnecting…",
        }[call?.status];
  return (
    <>
      {calls.notice && (
        <div className="call-notice" role="status">
          <span>{calls.notice}</span>
          <button
            onClick={calls.dismissNotice}
            aria-label="Dismiss call notice"
          >
            <X size={18} />
          </button>
        </div>
      )}
      {call && (
        <dialog
          ref={dialog}
          className={`call-panel ${call.kind}`}
          aria-label={`${call.kind === "video" ? "Video" : "Audio"} call with ${call.name}`}
          onCancel={(e) => {
            e.preventDefault();
            calls.end();
          }}
        >
          <header>
            <span>
              STILL / {call.kind === "video" ? "VIDEO CALL" : "AUDIO CALL"}
            </span>
            <span className="call-status" role="status">
              {status}
            </span>
          </header>
          <div className="call-stage">
            <video
              ref={remoteVideo}
              autoPlay
              playsInline
              className={`remote-video ${call.kind === "audio" || call.status !== "connected" ? "concealed-video" : ""}`}
            />
            {(call.kind === "audio" || call.status !== "connected") && (
              <div className="call-person">
                <span>
                  {call.name
                    .split(" ")
                    .map((x) => x[0])
                    .slice(0, 2)
                    .join("")}
                </span>
                <h2>{call.name}</h2>
                <p>{call.kind === "video" ? "Video call" : "Voice call"}</p>
              </div>
            )}
            {local && call.kind === "video" && (
              <div className="local-video-wrap">
                <video ref={localVideo} autoPlay muted playsInline />
                <span>You{call.cameraOff ? " · Camera off" : ""}</span>
              </div>
            )}
          </div>
          {playBlocked && (
            <button
              className="enable-audio"
              onClick={() =>
                remoteVideo.current
                  .play()
                  .then(() => setPlayBlocked(false))
                  .catch(() => {})
              }
            >
              <Volume2 size={17} />
              Enable call audio
            </button>
          )}
          <div className="call-controls">
            {call.status === "incoming" ? (
              <>
                <button className="call-action answer" onClick={calls.accept}>
                  <Phone size={23} />
                  <span>Answer</span>
                </button>
                <button
                  className="call-action hangup"
                  onClick={() => calls.end()}
                >
                  <PhoneOff size={23} />
                  <span>Decline</span>
                </button>
              </>
            ) : (
              <>
                <button
                  className={`call-action ${call.muted ? "toggled" : ""}`}
                  disabled={!local}
                  aria-pressed={call.muted}
                  onClick={calls.toggleMute}
                >
                  {call.muted ? <MicOff size={22} /> : <Mic size={22} />}
                  <span>{call.muted ? "Unmute" : "Mute"}</span>
                </button>
                {call.kind === "video" && (
                  <>
                    <button
                      className={`call-action ${call.cameraOff ? "toggled" : ""}`}
                      disabled={!local}
                      aria-pressed={call.cameraOff}
                      onClick={calls.toggleCamera}
                    >
                      {call.cameraOff ? (
                        <VideoOff size={22} />
                      ) : (
                        <Video size={22} />
                      )}
                      <span>Camera</span>
                    </button>
                    <button
                      className="call-action"
                      disabled={!local}
                      onClick={calls.switchCamera}
                    >
                      <SwitchCamera size={22} />
                      <span>Switch</span>
                    </button>
                  </>
                )}
                <button
                  className="call-action hangup"
                  onClick={() => calls.end()}
                >
                  <PhoneOff size={23} />
                  <span>End call</span>
                </button>
              </>
            )}
          </div>
          <p className="call-footnote">
            {call.status === "incoming"
              ? "Answering requests access to your microphone" +
                (call.kind === "video" ? " and camera." : ".")
              : "Audio and video travel over an encrypted WebRTC connection."}
          </p>
        </dialog>
      )}
    </>
  );
}
