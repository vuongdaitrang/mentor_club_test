#!/usr/bin/env node
/*
 * post-feed-api.js — Đăng bài (ẢNH / VIDEO lên feed) từ bảng "14.3 Đăng bài tự động" lên Facebook Page.
 * KHÁC post-reels-api.js: đăng feed ảnh/video (không phải Reel) và MỖI DÒNG chọn Page riêng
 * qua cột link "Link Page" (trỏ tới bảng 14.1 Pages) → dùng đúng token của page đó.
 *
 * Chạy:  node post-feed-api.js            (đăng thật các dòng đủ điều kiện)
 *        node post-feed-api.js --dry-run  (chỉ liệt kê, không đăng, không ghi Base)
 *
 * Điều kiện đăng 1 dòng: Trạng thái ≠ "Thành công" + có Page link + có file Ảnh/video
 *   + (Lịch đăng bài trống hoặc đã tới giờ). Đăng xong set Trạng thái + Log + Link bài đăng.
 *
 * Bí mật qua BIẾN MÔI TRƯỜNG: LARK_APP_SECRET (bắt buộc). Token FB lấy TỪ bảng Pages (không cần env).
 * Tùy chọn: LARK_APP_ID, LARK_APP_TOKEN, LARK_TABLE_ID, PAGES_TABLE_ID, LARK_DOMAIN, GRAPH_VERSION, RESPECT_SCHEDULE.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const CFG = {
  APP_ID:       process.env.LARK_APP_ID    || 'cli_aa8cccd0b262deed',
  APP_SECRET:   process.env.LARK_APP_SECRET|| '',
  APP_TOKEN:    process.env.LARK_APP_TOKEN || 'Rnmkbe9vMa7V6ssUP37lh3Cbgdd',
  TABLE_ID:     process.env.LARK_TABLE_ID  || 'tblxSnM1mHO8gOYD',   // 14.3 Đăng bài tự động
  PAGES_TABLE:  process.env.PAGES_TABLE_ID || 'tblNYaNnHUhMofPa',   // 14.1 Pages (ID + access_token)
  LARK_DOMAIN:  process.env.LARK_DOMAIN    || 'https://open.larksuite.com',
  GRAPH_VERSION:process.env.GRAPH_VERSION  || 'v21.0',
  RESPECT_SCHEDULE: process.env.RESPECT_SCHEDULE !== 'false',
  RECORD_ID:    (process.env.RECORD_ID || '').trim(),   // đăng đúng 1 dòng: truyền record_id qua client_payload
};
const GRAPH = `https://graph.facebook.com/${CFG.GRAPH_VERSION}`;
const DRY = process.argv.includes('--dry-run');
if (!DRY && !CFG.APP_SECRET) { console.error('!! Thiếu LARK_APP_SECRET — đặt qua biến môi trường.'); process.exit(1); }

const F = { link:'Link Page', type:'Loại', caption:'Nội dung', comment:'Comment ebook', media:'Ảnh/video',
            schedule:'Lịch đăng bài', status:'Trạng thái', log:'Log', linkPost:'Link bài đăng' };
const DONE = 'Thành công', FAIL = 'Thất bại';
const now = () => new Date().toISOString().replace('T',' ').slice(0,19);
const log = (...a) => console.log(now(), ...a);
const plain = v => v==null?'':typeof v==='string'?v:Array.isArray(v)?v.map(x=>x.text||x.name||'').join(''):(v.text||v.name||v.link||String(v));
const isVid = a => /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(a.name||'') || /^video/i.test(a.type||'');
const isImg = a => /\.(jpe?g|png|gif|webp|bmp)$/i.test(a.name||'') || /^image/i.test(a.type||'');
// Lấy record_ids từ cell link — API list trả MẢNG [{record_ids:[...]}], API 1-record trả OBJECT {record_ids:[...]}.
const linkRecIds = cell => { if(!cell) return [];
  const arr = Array.isArray(cell) ? cell : [cell]; let ids=[];
  for(const el of arr){ if(!el) continue;
    if(Array.isArray(el.record_ids)) ids=ids.concat(el.record_ids);
    else if(el.record_id) ids.push(el.record_id);
    else if(typeof el==='string') ids.push(el); }
  return ids.filter(Boolean); };

async function larkToken() {
  const r = await fetch(CFG.LARK_DOMAIN+'/open-apis/auth/v3/tenant_access_token/internal',
    { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({app_id:CFG.APP_ID,app_secret:CFG.APP_SECRET}) });
  const j = await r.json(); if (j.code!==0) throw new Error('Lark token: '+JSON.stringify(j)); return j.tenant_access_token;
}
async function listAll(tk, tableId) {
  let items=[], pt='';
  do { const r=await fetch(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${tableId}/records?page_size=200`+(pt?'&page_token='+pt:''),{headers:{Authorization:'Bearer '+tk}});
    const j=await r.json(); if(j.code!==0)throw new Error('list '+tableId+': '+JSON.stringify(j));
    items=items.concat(j.data.items||[]); pt=j.data.has_more?j.data.page_token:''; } while(pt);
  return items;
}
async function listFields(tk, tableId) {
  const r=await fetch(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${tableId}/fields?page_size=200`,{headers:{Authorization:'Bearer '+tk}});
  const j=await r.json(); if(j.code!==0)throw new Error('fields: '+JSON.stringify(j));
  return (j.data.items||[]).map(f=>({name:f.field_name,type:f.type}));
}
async function updateRow(tk, recId, fields) {
  const r=await fetch(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${CFG.TABLE_ID}/records/${recId}`,
    {method:'PUT',headers:{'Content-Type':'application/json; charset=utf-8',Authorization:'Bearer '+tk},body:JSON.stringify({fields})});
  const j=await r.json(); if(j.code!==0)throw new Error('update: '+JSON.stringify(j));
}
async function downloadMedia(tk, fileToken, out) {
  const tries=[ `${CFG.LARK_DOMAIN}/open-apis/drive/v1/medias/${fileToken}/download?extra=${encodeURIComponent(JSON.stringify({bitablePerm:{tableId:CFG.TABLE_ID}}))}`,
                `${CFG.LARK_DOMAIN}/open-apis/drive/v1/medias/${fileToken}/download` ];
  for (const u of tries) { const r=await fetch(u,{headers:{Authorization:'Bearer '+tk}});
    if (r.ok && (r.headers.get('content-type')||'').indexOf('json')<0) { const b=Buffer.from(await r.arrayBuffer()); fs.writeFileSync(out,b); return b.length; } }
  throw new Error('không tải được media từ Lark');
}
async function fbFetch(u,o){ const r=await fetch(u,o); const t=await r.text(); let j; try{j=JSON.parse(t)}catch{j={_raw:t}}
  if(!r.ok||j.error)throw new Error('FB '+r.status+': '+JSON.stringify(j.error||j._raw||j)); return j; }

// Đăng feed nhiều ảnh: upload từng ảnh (published=false) → media_fbid → tạo post /feed đính kèm.
async function postPhotos(pageId, token, files, caption) {
  const fbids=[];
  for (const f of files) {
    const fd=new FormData(); fd.set('access_token',token); fd.set('published','false');
    fd.set('source', new Blob([fs.readFileSync(f.path)]), f.name||'photo.jpg');
    const j=await fbFetch(`${GRAPH}/${pageId}/photos`,{method:'POST',body:fd});
    if(!j.id) throw new Error('upload ảnh không có id'); fbids.push(j.id);
  }
  const body=new URLSearchParams(); body.set('access_token',token); if(caption)body.set('message',caption);
  fbids.forEach((id,i)=>body.set(`attached_media[${i}]`, JSON.stringify({media_fbid:id})));
  const post=await fbFetch(`${GRAPH}/${pageId}/feed`,{method:'POST',body});
  return { objectId:post.id, permalink:`https://www.facebook.com/${post.id}` };
}
async function postVideo(pageId, token, file, caption) {
  const fd=new FormData(); fd.set('access_token',token); if(caption)fd.set('description',caption);
  fd.set('source', new Blob([fs.readFileSync(file.path)]), file.name||'video.mp4');
  const j=await fbFetch(`${GRAPH}/${pageId}/videos`,{method:'POST',body:fd});
  if(!j.id) throw new Error('upload video không có id');
  let permalink='';
  try{ const st=await fbFetch(`${GRAPH}/${j.id}?fields=permalink_url&access_token=${encodeURIComponent(token)}`,{method:'GET'});
    permalink=st.permalink_url||''; }catch{}
  if(permalink&&permalink.startsWith('/'))permalink='https://www.facebook.com'+permalink;
  return { objectId:j.id, permalink:permalink||`https://www.facebook.com/${j.id}` };
}
// Upload PHÂN MẢNH + resume + retry lên rupload endpoint của Reels.
// Đọc file theo từng chunk (không nạp cả file vào RAM), gửi theo offset tăng dần;
// lỗi mạng/5xx -> retry đúng chunk (backoff); tôn trọng offset server trả về để resume.
const REEL_CHUNK = Math.max(1, parseInt(process.env.REEL_CHUNK_MB || '8', 10)) * 1024 * 1024;
const REEL_UPLOAD_RETRY = Math.max(1, parseInt(process.env.REEL_UPLOAD_RETRY || '5', 10));
async function uploadResumable(uploadUrl, token, filePath){
  const total = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, 'r');
  try {
    let offset = 0;
    while (offset < total) {
      const len = Math.min(REEL_CHUNK, total - offset);
      const chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, offset);
      let attempt = 0;
      for(;;){
        attempt++;
        try {
          const r = await fetch(uploadUrl, { method:'POST',
            headers:{ Authorization:`OAuth ${token}`, offset:String(offset), file_size:String(total) }, body: chunk });
          const t = await r.text(); let j; try{j=JSON.parse(t)}catch{j={_raw:t}}
          if(!r.ok || j.error) throw new Error('rupload '+r.status+': '+JSON.stringify(j.error||j._raw||j));
          offset = (typeof j.offset === 'number') ? j.offset : offset + len; // server offset thắng (để resume đúng)
          break;
        } catch(e){
          if(attempt >= REEL_UPLOAD_RETRY) throw new Error(`upload chunk @${offset} thất bại sau ${attempt} lần: ${String(e.message||e).slice(0,160)}`);
          log(`     … chunk @${offset} lỗi (lần ${attempt}), thử lại: ${String(e.message||e).slice(0,100)}`);
          await new Promise(r=>setTimeout(r, 1500*attempt));
        }
      }
      log(`     ↑ reel upload ${Math.min(offset,total)}/${total} bytes (${Math.round(offset/total*100)}%)`);
    }
  } finally { fs.closeSync(fd); }
}
// Đăng REEL (Loại = "Video"): Graph video_reels 3 pha start → upload phân mảnh → finish/PUBLISHED.
// Video phải MP4 dọc 9:16, 3–90s. Dùng token của Page trên dòng (như postVideo/postPhotos).
async function postReel(pageId, token, file, caption){
  const start=await fbFetch(`${GRAPH}/${pageId}/video_reels?upload_phase=start&access_token=${encodeURIComponent(token)}`,{method:'POST'});
  const videoId=start.video_id, uploadUrl=start.upload_url;
  if(!videoId||!uploadUrl)throw new Error('reel start thiếu video_id/upload_url');
  await uploadResumable(uploadUrl, token, file.path);
  await fbFetch(`${GRAPH}/${pageId}/video_reels`,{method:'POST',body:new URLSearchParams({upload_phase:'finish',video_id:videoId,video_state:'PUBLISHED',description:caption||'',access_token:token})});
  let permalink='';
  for(let i=0;i<30;i++){ await new Promise(r=>setTimeout(r,6000));
    try{ const st=await fbFetch(`${GRAPH}/${videoId}?fields=status,permalink_url&access_token=${encodeURIComponent(token)}`,{method:'GET'});
      const phase=st.status&&(st.status.video_status||(st.status.processing_phase&&st.status.processing_phase.status));
      if(st.permalink_url)permalink=st.permalink_url;
      if(phase==='ready'||phase==='PUBLISHED'||(st.status&&st.status.video_status==='ready'))break;
      if(phase==='error')throw new Error('FB xử lý reel lỗi: '+JSON.stringify(st.status)); }catch(e){}
  }
  if(permalink&&permalink.startsWith('/'))permalink='https://www.facebook.com'+permalink;
  return { objectId:videoId, permalink:permalink||`https://www.facebook.com/${videoId}` };
}
async function postComment(pageId, token, objectId, message){
  return fbFetch(`${GRAPH}/${objectId}/comments`,{method:'POST',body:new URLSearchParams({message,access_token:token})});
}
function scheduleMs(cell){ if(cell==null)return null; if(typeof cell==='number')return cell; // Lark datetime = epoch ms
  const t=plain(cell).trim(); if(!t)return null;
  const m=t.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/); if(m)return new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5]).getTime();
  const d=new Date(t); return isNaN(d)?null:d.getTime(); }

(async()=>{
  const tk=await larkToken();
  // Tự dò cột link tới bảng Pages (type 18 single-link / 21 duplex-link) — không phụ thuộc tên cột.
  try {
    const flds=await listFields(tk, CFG.TABLE_ID);
    const lf=flds.find(f=>f.type===18||f.type===21) || flds.find(f=>/page/i.test(f.name));
    if(lf) F.link=lf.name;
    log(`Cột link Page = "${F.link}".`);
  } catch(e){ log('! không đọc được fields, dùng mặc định "'+F.link+'": '+String(e.message||e)); }
  // map record_id (bảng Pages) -> {fbId, token, name}
  const pageRecs=await listAll(tk, CFG.PAGES_TABLE);
  const pageMap=new Map();
  for(const r of pageRecs){ pageMap.set(r.record_id, { fbId:plain(r.fields.ID).trim(), token:plain(r.fields.access_token).trim(), name:plain(r.fields.Fanpage).trim() }); }

  let rows=await listAll(tk, CFG.TABLE_ID);
  // Đăng đúng 1 dòng: truyền record_id qua client_payload -> chỉ xử lý dòng đó.
  if(CFG.RECORD_ID){
    rows=rows.filter(r=>r.record_id===CFG.RECORD_ID);
    log(`Chỉ đăng dòng record_id=${CFG.RECORD_ID} (${rows.length} dòng khớp).`);
    if(rows.length===0) log(`  ! Không tìm thấy record_id=${CFG.RECORD_ID} trong bảng.`);
  }
  const nowMs=Date.now();
  let ok=0,err=0,wait=0,skip=0;
  for(const row of rows){
    const recId=row.record_id;
    if(plain(row.fields[F.status])===DONE) { skip++; continue; }              // đã đăng
    const pageRecId=linkRecIds(row.fields[F.link])[0];
    const atts=Array.isArray(row.fields[F.media])?row.fields[F.media]:[];
    if(!pageRecId || atts.length===0) { skip++; continue; }                   // dòng chưa sẵn sàng → bỏ qua im lặng
    const pg=pageMap.get(pageRecId);
    if(!pg||!pg.fbId||!pg.token){ log(`  [LỖI] ${recId}: Page link không có ID/token trong bảng 14.1`); if(!DRY)await updateRow(tk,recId,{[F.status]:FAIL,[F.log]:`${now()} - Page thiếu ID/token`}); err++; continue; }

    // Chỉ định record_id = đăng ngay dòng đó, bỏ qua kiểm tra lịch.
    if(CFG.RESPECT_SCHEDULE && !CFG.RECORD_ID){ const s=scheduleMs(row.fields[F.schedule]); if(s&&s>nowMs){ log(`  [CHỜ GIỜ] ${recId}: hẹn ${new Date(s).toISOString().slice(0,16)}`); wait++; continue; } }

    const caption=plain(row.fields[F.caption]);
    const loai=plain(row.fields[F.type]);
    // Quy ước cột "Loại": "Hình ảnh" -> đăng bài feed ảnh; "Video" -> đăng REEL.
    let kind = /video|reel/i.test(loai) ? 'reel'
             : /ảnh|hình|image|photo/i.test(loai) ? 'image'
             : (atts.some(isVid)?'reel':'image');
    const files = kind==='reel' ? [ atts.find(isVid)||atts[0] ] : atts.filter(a=>isImg(a)||!isVid(a));
    log(`  >> ${recId} | ${pg.name} | ${kind} | ${files.length} file | "${caption.slice(0,40).replace(/\n/g,' ')}"`);
    if(DRY){ const c=plain(row.fields[F.comment]).trim(); if(c)log(`     [DRY] comment: ${c.slice(0,60)}`); continue; }

    const tmp=[];
    try{
      for(let i=0;i<files.length;i++){ const f=files[i]; const p=path.join(os.tmpdir(),`feed_${recId}_${i}_${(f.name||'m').replace(/[^\w.]/g,'')}`);
        await downloadMedia(tk,f.file_token,p); f.path=p; tmp.push(p); }
      const res = kind==='reel' ? await postReel(pg.fbId,pg.token,files[0],caption)
                                  : await postPhotos(pg.fbId,pg.token,files,caption);
      // Auto comment (link ebook) — không làm hỏng bài nếu lỗi.
      let cmtNote=''; const commentText=plain(row.fields[F.comment]).trim();
      if(commentText){ try{ await postComment(pg.fbId,pg.token,res.objectId,commentText); cmtNote=' +cmt'; }
        catch(e){ cmtNote=' (cmt lỗi)'; log(`     ! comment lỗi: ${String(e.message||e).slice(0,120)}`); } }
      await updateRow(tk,recId,{ [F.status]:DONE, [F.linkPost]:{link:res.permalink,text:'Xem bài'}, [F.log]:`${now()} - OK - ${res.objectId}${cmtNote}` });
      log(`     ✔ ĐÃ ĐĂNG: ${res.permalink}`); ok++;
    }catch(e){ const msg=String(e.message||e).slice(0,300); log(`     ✖ LỖI: ${msg}`);
      try{await updateRow(tk,recId,{[F.status]:FAIL,[F.log]:`${now()} - LỖI - ${msg}`});}catch{} err++;
    }finally{ tmp.forEach(p=>{try{fs.unlinkSync(p)}catch{}}); }
  }
  log(`Xong. Đăng: ${ok}, Lỗi: ${err}, Chờ giờ: ${wait}, Bỏ qua: ${skip}.`);
})().catch(e=>{console.error('FATAL',e.message||e);process.exit(1);});
