import { useEffect, useState } from "react";
import { api } from "./api";

export function StatusFeed({ user, onBack }) {
  const [statuses,setStatuses]=useState([]);
  const [body,setBody]=useState("");
  const [file,setFile]=useState(null);
  const [preview,setPreview]=useState(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [now,setNow]=useState(Date.now());
  async function refresh(){const data=await api('/statuses');setStatuses(data.statuses);setNow(Date.now());}
  useEffect(()=>{let alive=true;const load=()=>api('/statuses').then(data=>{if(alive){setStatuses(data.statuses);setNow(Date.now());}}).catch(e=>{if(alive)setError(e.message)});load();const timer=setInterval(load,15000);return()=>{alive=false;clearInterval(timer)};},[]);
  useEffect(()=>{if(!file){setPreview(null);return;}const url=URL.createObjectURL(file);setPreview(url);return()=>URL.revokeObjectURL(url);},[file]);
  async function submit(event){event.preventDefault();setBusy(true);setError('');try{const data=new FormData();data.append('body',body);if(file)data.append('file',file);await api('/statuses',{method:'POST',body:data});setBody('');setFile(null);event.target.reset();await refresh();}catch(e){setError(e.message)}finally{setBusy(false)}}
  async function remove(id){if(!window.confirm('Delete this status for everyone?'))return;try{await api(`/statuses/${id}`,{method:'DELETE'});await refresh();}catch(e){setError(e.message)}}
  return <section className="status-feed"><header><button type="button" onClick={onBack}>← Back to chats</button><span className="eyebrow">A MOMENT FROM YOUR DAY</span><h1>Status</h1><p>Share with people in your chats. Updates disappear after 24 hours.</p></header>
    <form onSubmit={submit} className="status-compose"><label>Your update<textarea aria-label="Your status" maxLength={700} value={body} onChange={e=>setBody(e.target.value)} placeholder="What’s happening today?" /></label>
    <label className="status-file">Add photo or video (up to 10 MB)<input type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" onChange={e=>{const selected=e.target.files?.[0];if(selected?.size>10*1024*1024){setError('Choose a file smaller than 10 MB.');e.target.value='';setFile(null);return;}setFile(selected||null)}} /></label>
    {preview && (file.type.startsWith('video/')?<video controls src={preview} />:<img src={preview} alt="Status preview" />)}
    {file && <button type="button" onClick={()=>setFile(null)}>Remove media</button>}
    <button className="primary" disabled={busy || (!body.trim()&&!file)}>{busy?'Sharing…':'Share status'}</button></form>
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="status-grid">{statuses.filter(s=>s.expires_at>now).map(status=><article className="status-card" key={status.id}><header><strong>{status.owner_id===user.id?'My status':status.name}</strong><small>{new Date(status.created_at).toLocaleString()} · expires in {Math.max(1,Math.ceil((status.expires_at-now)/3600000))}h</small></header>
    {status.mediaUrl && (status.mime.startsWith('video/')?<video controls preload="metadata" src={status.mediaUrl}/>:<img src={status.mediaUrl} alt={status.body||`${status.name}’s status`} loading="lazy"/>)}
    {status.body && <p>{status.body}</p>}{status.owner_id===user.id&&<button onClick={()=>remove(status.id)}>Delete status</button>}</article>)}</div>
    {!statuses.length&&<p>No recent updates. Share the first moment.</p>}
  </section>;
}
