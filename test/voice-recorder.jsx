import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {VoiceRecorder} from '../src/VoiceRecorder';
let context;
Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {value: async () => {
  context ||= new AudioContext();
  await context.resume();
  const destination = context.createMediaStreamDestination();
  const oscillator = context.createOscillator();
  oscillator.connect(destination); oscillator.start();
  destination.stream.getAudioTracks()[0].addEventListener('ended', () => oscillator.stop());
  return destination.stream;
}});
function Test(){const [result,setResult]=useState('Record synthetic audio, stop, preview, then send. No microphone is used.');return <><h1>Voice recorder verification</h1><p role="status">{result}</p><VoiceRecorder onError={setResult} onSend={async file=>{
 const audio=document.createElement('audio');const url=URL.createObjectURL(file);audio.src=url;
 await new Promise((resolve,reject)=>{audio.onloadeddata=resolve;audio.onerror=reject;audio.load()});
 setResult(`PASS: ${file.size} bytes recorded and decoded as ${file.type}`);URL.revokeObjectURL(url);
}}/></>};createRoot(document.getElementById('root')).render(<Test/>);
