import { useEffect, useRef, useState } from "react";
import { api, emit } from "./api";

export function useCalls(socketRef, ready) {
  const [call, setCall] = useState(null);
  const [local, setLocal] = useState(null);
  const [remote, setRemote] = useState(null);
  const [notice, setNotice] = useState("");
  const current = useRef(null);
  const pc = useRef(null);
  const localRef = useRef(null);
  const candidates = useRef([]);
  const signalChain = useRef(Promise.resolve());
  const deadline = useRef(null);
  const facing = useRef("user");
  const switching = useRef(false);

  function update(values) {
    if (!current.current) return;
    current.current = { ...current.current, ...values };
    setCall(current.current);
  }
  function clean(message = "") {
    clearTimeout(deadline.current);
    current.current = null;
    if (pc.current) {
      pc.current.ontrack = null;
      pc.current.onicecandidate = null;
      pc.current.onconnectionstatechange = null;
      pc.current.close();
      pc.current = null;
    }
    for (const track of localRef.current?.getTracks() || []) track.stop();
    localRef.current = null;
    candidates.current = [];
    setLocal(null);
    setRemote(null);
    setCall(null);
    if (message) setNotice(message);
  }
  function end(message = "") {
    const value = current.current;
    if (value?.registered && socketRef.current?.connected)
      emit(socketRef.current, "call:end", { callId: value.callId }).catch(
        () => {},
      );
    clean(message);
  }
  function armTimeout() {
    clearTimeout(deadline.current);
    deadline.current = setTimeout(
      () =>
        end(
          "Unable to connect the call. Check your network; a TURN relay may be needed.",
        ),
      30_000,
    );
  }
  function errorMessage(error) {
    if (["NotAllowedError", "SecurityError"].includes(error.name))
      return "Microphone or camera permission was denied. Allow access in your browser and try again.";
    if (error.name === "NotFoundError")
      return "No microphone or camera was found. Connect a device and try again.";
    if (error.name === "NotReadableError")
      return "Your camera or microphone is being used by another application.";
    return error.message || "The call could not be connected.";
  }
  async function prepare(value) {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error(
        "Calling requires HTTPS or localhost and a browser with microphone access.",
      );
    const config = await api("/calls/config");
    if (current.current?.callId !== value.callId) return false;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video:
        value.kind === "video"
          ? {
              facingMode: "user",
              width: { ideal: 1280 },
              height: { ideal: 720 },
            }
          : false,
    });
    if (current.current?.callId !== value.callId) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    localRef.current = stream;
    setLocal(stream);
    facing.current = "user";
    const peer = new RTCPeerConnection(config);
    pc.current = peer;
    const incoming = new MediaStream();
    setRemote(incoming);
    for (const track of stream.getTracks()) peer.addTrack(track, stream);
    peer.ontrack = (event) => {
      if (!incoming.getTracks().some((t) => t.id === event.track.id))
        incoming.addTrack(event.track);
      setRemote(new MediaStream(incoming.getTracks()));
    };
    peer.onicecandidate = (event) => {
      if (event.candidate && current.current?.callId === value.callId) {
        emit(socketRef.current, "call:signal", {
          callId: value.callId,
          candidate: event.candidate.toJSON(),
        }).catch((error) => {
          if (current.current?.callId === value.callId)
            end(errorMessage(error));
        });
      }
    };
    peer.onconnectionstatechange = () => {
      if (pc.current !== peer) return;
      if (peer.connectionState === "connected") {
        clearTimeout(deadline.current);
        update({
          status: "connected",
          startedAt: current.current.startedAt || Date.now(),
        });
      } else if (peer.connectionState === "failed")
        end("The network connection failed. Please call again.");
      else if (peer.connectionState === "disconnected") {
        update({ status: "reconnecting" });
        armTimeout();
      }
    };
    return true;
  }
  async function start(chat, user, kind) {
    if (current.current || !socketRef.current?.connected) return;
    const person = chat.members.find((m) => m.id !== user.id);
    const value = {
      callId: crypto.randomUUID(),
      chatId: chat.id,
      kind,
      name: person.name,
      status: "preparing",
      outgoing: true,
      muted: false,
      cameraOff: false,
      registered: false,
    };
    current.current = value;
    setCall(value);
    setNotice("");
    try {
      if (!(await prepare(value))) return;
      update({ registered: true, status: "ringing" });
      await emit(socketRef.current, "call:start", {
        callId: value.callId,
        chatId: value.chatId,
        kind,
      });
    } catch (error) {
      if (current.current?.callId === value.callId) end(errorMessage(error));
    }
  }
  async function accept() {
    const value = current.current;
    if (!value || value.status !== "incoming") return;
    update({ status: "preparing" });
    try {
      if (!(await prepare(value))) return;
      update({ status: "connecting" });
      armTimeout();
      await emit(socketRef.current, "call:accept", { callId: value.callId });
    } catch (error) {
      if (current.current?.callId === value.callId) end(errorMessage(error));
    }
  }
  useEffect(() => {
    const socket = socketRef.current;
    if (!ready || !socket) return;
    const incoming = (value) => {
      if (current.current) {
        emit(socket, "call:end", { callId: value.callId }).catch(() => {});
        return;
      }
      const next = {
        ...value,
        status: "incoming",
        outgoing: false,
        muted: false,
        cameraOff: false,
        registered: true,
      };
      current.current = next;
      setCall(next);
      setNotice("");
    };
    const accepted = async ({ callId }) => {
      if (current.current?.callId !== callId || !pc.current) return;
      update({ status: "connecting" });
      armTimeout();
      try {
        const peer = pc.current;
        await peer.setLocalDescription(await peer.createOffer());
        if (current.current?.callId === callId)
          await emit(socket, "call:signal", {
            callId,
            description: {
              type: peer.localDescription.type,
              sdp: peer.localDescription.sdp,
            },
          });
      } catch (error) {
        if (current.current?.callId === callId) end(errorMessage(error));
      }
    };
    const signal = (value) => {
      signalChain.current = signalChain.current
        .catch(() => {})
        .then(async () => {
          if (current.current?.callId !== value.callId) return;
          const peer = pc.current;
          if (value.candidate) {
            if (peer?.remoteDescription)
              await peer.addIceCandidate(value.candidate);
            else candidates.current.push(value.candidate);
            return;
          }
          if (!peer) return;
          await peer.setRemoteDescription(value.description);
          for (const candidate of candidates.current.splice(0))
            await peer.addIceCandidate(candidate);
          if (value.description.type === "offer") {
            await peer.setLocalDescription(await peer.createAnswer());
            if (current.current?.callId === value.callId)
              await emit(socket, "call:signal", {
                callId: value.callId,
                description: {
                  type: peer.localDescription.type,
                  sdp: peer.localDescription.sdp,
                },
              });
          }
        })
        .catch((error) => {
          if (current.current?.callId === value.callId)
            end(errorMessage(error));
        });
    };
    const ended = ({ callId, reason }) => {
      if (current.current?.callId === callId) clean(reason);
    };
    const dismiss = ({ callId }) => {
      if (current.current?.callId === callId)
        clean("Answered on another device.");
    };
    const disconnected = () => {
      if (current.current) clean("Call ended because the connection was lost.");
    };
    socket.on("call:incoming", incoming);
    socket.on("call:accepted", accepted);
    socket.on("call:signal", signal);
    socket.on("call:ended", ended);
    socket.on("call:dismiss", dismiss);
    socket.on("disconnect", disconnected);
    return () => {
      socket.off("call:incoming", incoming);
      socket.off("call:accepted", accepted);
      socket.off("call:signal", signal);
      socket.off("call:ended", ended);
      socket.off("call:dismiss", dismiss);
      socket.off("disconnect", disconnected);
      end();
    };
  }, [ready, socketRef]);

  function toggleMute() {
    const track = localRef.current?.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      update({ muted: !track.enabled });
    }
  }
  function toggleCamera() {
    const track = localRef.current?.getVideoTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      update({ cameraOff: !track.enabled });
    }
  }
  async function switchCamera() {
    if (switching.current || !pc.current || current.current?.kind !== "video")
      return;
    switching.current = true;
    const callId = current.current.callId;
    let replacement;
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === "videoinput",
      );
      const old = localRef.current.getVideoTracks()[0];
      const index = devices.findIndex(
        (d) => d.deviceId === old.getSettings().deviceId,
      );
      const nextFacing = facing.current === "user" ? "environment" : "user";
      replacement = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video:
          devices.length > 1
            ? {
                deviceId: {
                  exact: devices[(index + 1) % devices.length].deviceId,
                },
              }
            : { facingMode: { exact: nextFacing } },
      });
      if (current.current?.callId !== callId) {
        replacement.getTracks().forEach((t) => t.stop());
        return;
      }
      const track = replacement.getVideoTracks()[0];
      track.enabled = !current.current.cameraOff;
      await pc.current
        .getSenders()
        .find((s) => s.track?.kind === "video")
        .replaceTrack(track);
      localRef.current.removeTrack(old);
      old.stop();
      localRef.current.addTrack(track);
      setLocal(new MediaStream(localRef.current.getTracks()));
      facing.current = nextFacing;
    } catch (error) {
      replacement?.getTracks().forEach((t) => t.stop());
      setNotice(
        "Could not switch cameras. Your current camera is still selected.",
      );
    } finally {
      switching.current = false;
    }
  }
  return {
    call,
    local,
    remote,
    notice,
    dismissNotice: () => setNotice(""),
    start,
    accept,
    end,
    toggleMute,
    toggleCamera,
    switchCamera,
  };
}
