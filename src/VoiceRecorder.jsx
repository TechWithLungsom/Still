import { useEffect, useRef, useState } from "react";
import { Mic, Square, Send, Trash2 } from "lucide-react";

export function VoiceRecorder({ disabled, onSend, onError }) {
  const [phase, setPhase] = useState("idle");
  const [seconds, setSeconds] = useState(0);
  const [clip, setClip] = useState(null);
  const recorder = useRef(null);
  const stream = useRef(null);
  const timer = useRef(null);
  const generation = useRef(0);
  const preview = useRef(null);
  function release() {
    clearInterval(timer.current);
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
  }
  function discard() {
    generation.current++;
    if (recorder.current?.state === "recording") recorder.current.stop();
    release();
    if (preview.current) URL.revokeObjectURL(preview.current);
    preview.current = null;
    setClip(null);
    setPhase("idle");
  }
  useEffect(() => () => {
    generation.current++;
    if (recorder.current?.state === "recording") recorder.current.stop();
    release();
    if (preview.current) URL.revokeObjectURL(preview.current);
  }, []);
  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      onError("Voice recording requires a supported browser and HTTPS.");
      return;
    }
    const version = ++generation.current;
    setPhase("requesting");
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation.current !== version) { media.getTracks().forEach(t => t.stop()); return; }
      stream.current = media;
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error("This browser cannot record a supported audio format.");
      const recording = new MediaRecorder(media, { mimeType, audioBitsPerSecond: 64000 });
      recorder.current = recording;
      const chunks = [];
      let size = 0;
      recording.ondataavailable = event => {
        if (event.data.size) { chunks.push(event.data); size += event.data.size; }
        if (size >= 9 * 1024 * 1024 && recording.state === "recording") recording.stop();
      };
      recording.onerror = () => { if (generation.current === version) { discard(); onError("Recording failed. Please try again."); } };
      recording.onstop = () => {
        if (generation.current !== version) return;
        release();
        const blob = new Blob(chunks, { type: mimeType });
        if (!blob.size || blob.size > 10 * 1024 * 1024) { discard(); onError("Recording is empty or exceeds 10 MB."); return; }
        const extension = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
        const file = new File([blob], `Voice note ${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`, { type: mimeType });
        preview.current = URL.createObjectURL(blob);
        setClip({ file, url: preview.current });
        setPhase("preview");
      };
      recording.start(1000);
      setSeconds(0);
      setPhase("recording");
      const began = Date.now();
      timer.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - began) / 1000);
        setSeconds(elapsed);
        if (elapsed >= 300 && recording.state === "recording") recording.stop();
      }, 250);
    } catch (error) {
      if (generation.current !== version) return;
      release(); setPhase("idle");
      onError(error.name === "NotAllowedError" ? "Microphone access was denied. Allow it in browser settings to record a voice note." : error.message);
    }
  }
  async function send() {
    setPhase("sending");
    try { await onSend(clip.file); discard(); }
    catch (error) { setPhase("preview"); onError(error.message); }
  }
  return <div className="voice-recorder">
    {phase === "idle" ? <button type="button" className="voice-start" disabled={disabled} onClick={start}><Mic size={17} /> Voice note</button> : <>
      <span role="status">{phase === "requesting" ? "Waiting for microphone…" : phase === "recording" ? `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} / 5:00` : phase === "sending" ? "Sending voice note…" : "Preview voice note"}</span>
      {phase === "recording" && <button type="button" aria-label="Stop recording" onClick={() => recorder.current?.stop()}><Square size={17} /> Stop</button>}
      {clip && <audio controls src={clip.url} aria-label="Voice note preview" />}
      <button type="button" aria-label="Discard voice note" disabled={phase === "sending"} onClick={discard}><Trash2 size={17} /></button>
      {clip && <button type="button" disabled={disabled || phase === "sending"} onClick={send}><Send size={17} /> Send voice note</button>}
    </>}
  </div>;
}
