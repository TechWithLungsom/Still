import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {io} from 'socket.io-client';
import {createApplication} from '../server/app.js';

test('message deletion and status privacy, media, ownership and expiry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'still-social-')); const origin='http://localhost:5173';
 const service=createApplication({origin,database:join(dir,'db'),uploadDir:join(dir,'files')});
 await new Promise(r=>service.http.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${service.http.address().port}/api`;
 const sockets=[];
 async function req(path,user,method='GET',body){const r=await fetch(base+path,{method,headers:{Origin:origin,...(user?{Cookie:user.cookie}:{}),...(body && !(body instanceof FormData)?{'Content-Type':'application/json'}:{})},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});return r;}
 async function account(username){const r=await req('/auth/register',null,'POST',{username,name:username,password:'long-test-password-2026'});assert.equal(r.status,201);return {...(await r.json()).user,cookie:r.headers.get('set-cookie').split(';')[0]};}
 try{
 const a=await account('socialalice'),b=await account('socialbob'),c=await account('socialother');
 const {chatId}=await(await req('/chats',a,'POST',{kind:'direct',memberIds:[b.id]})).json();
 const socket=io(base.replace('/api',''),{transports:['websocket'],extraHeaders:{Origin:origin,Cookie:a.cookie},reconnection:false});sockets.push(socket);await new Promise((r,j)=>{socket.once('connect',r);socket.once('connect_error',j)});
 const emit=(name,payload)=>new Promise((r,j)=>socket.timeout(2000).emit(name,payload,(e,v)=>e?j(e):r(v)));
 for(const kind of ['text','decision','file']){
 let attachmentId;
 if(kind==='file'){const f=new FormData();f.append('file',new Blob(['sample'],{type:'audio/webm'}),'voice.webm');attachmentId=(await(await req(`/chats/${chatId}/files`,a,'POST',f)).json()).attachment.id;}
 const input={chatId,clientId:randomUUID(),kind,body:kind==='file'?'':'Delete me',...(attachmentId?{attachmentId}:{})};
 const sent=await emit('message:send',input);assert.equal(sent.ok,true);const mid=sent.message.id;
 assert.equal((await req(`/messages/${mid}`,b,'DELETE')).status,403);
 assert.equal((await req(`/messages/${mid}`,a,'DELETE')).status,200);
 const page=await(await req(`/chats/${chatId}/messages?after=${sent.message.seq}`,b)).json();assert.ok(page.deleted.includes(mid));
 const retry=await emit('message:send',input);assert.equal(retry.message.body,'Message deleted');assert.equal(retry.message.attachment,null);
 if(attachmentId)assert.equal((await req(`/files/${attachmentId}?play=1`,a)).status,404);
 }
 const form=new FormData();form.append('body','Hello today');form.append('file',new Blob([new Uint8Array([137,80,78,71,13,10,26,10])],{type:'image/png'}),'photo.png');
 const created=await req('/statuses',a,'POST',form);assert.equal(created.status,201);const {id}=await created.json();
 assert.equal((await(await req('/statuses',b)).json()).statuses.length,1);
 assert.equal((await(await req('/statuses',c)).json()).statuses.length,0);
 assert.equal((await req(`/statuses/${id}/media`,c)).status,404);
 assert.equal((await req(`/statuses/${id}`,b,'DELETE')).status,404);
 assert.equal((await req(`/statuses/${id}/media`,b)).status,200);
 service.db.prepare('UPDATE statuses SET expires_at=? WHERE id=?').run(Date.now()-1,id);
 assert.equal((await(await req('/statuses',b)).json()).statuses.length,0);
 assert.equal((await req(`/statuses/${id}/media`,b)).status,404);
 assert.equal((await req(`/statuses/${id}`,a,'DELETE')).status,200);
 }finally{sockets.forEach(s=>s.disconnect());await service.close();await rm(dir,{recursive:true,force:true});}
});
