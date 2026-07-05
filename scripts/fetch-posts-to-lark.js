#!/usr/bin/env node
/*
 * fetch-posts-to-lark.js — Lấy bài viết (published_posts) của TẤT CẢ Page trong /me/accounts
 * rồi ghi vào bảng "14.2 Lấy danh sách bài viết" của Lark Base.
 *
 * Bảng đích tự tính: cột ID (tách pageId từ Post-ID), Fanpage (lookup theo pageId), Ngày đăng (CT).
 * Script chỉ ghi: Post-ID, Nội dung, Link post, Lượt share, Lượt bình luận, Số tương tác,
 *                 LIKE/LOVE/HAHA/WOW/SAD/ANGRY/CARE, Ngày đăng (YYYY-MM-DD), Tháng (YYYY-MM).
 *
 * Chạy:  node fetch-posts-to-lark.js            (chỉ thêm bài mới, không đụng bài cũ)
 *        node fetch-posts-to-lark.js --update   (refresh chỉ số share/cmt/reaction cho bài đã có)
 *        node fetch-posts-to-lark.js --dry-run  (chỉ in, không ghi Lark)
 *
 * Bí mật qua BIẾN MÔI TRƯỜNG: LARK_APP_SECRET, FB_USER_TOKEN (bắt buộc).
 * Tùy chọn: LARK_APP_ID, LARK_APP_TOKEN, LARK_TABLE_ID, LARK_DOMAIN, FB_VERSION,
 *           POSTS_PER_PAGE (mặc định 100; 0 = lấy hết).
 */
'use strict';
const CFG = {
  APP_ID:      process.env.LARK_APP_ID    || '',                  // BẮT BUỘC qua env/Variables
  APP_SECRET:  process.env.LARK_APP_SECRET|| '',                  // BẮT BUỘC qua env/Secrets
  APP_TOKEN:   process.env.LARK_APP_TOKEN || '',                  // BẮT BUỘC: base token (Variables)
  TABLE_ID:    process.env.LARK_TABLE_ID  || '',                  // BẮT BUỘC: bảng 14.2 bài viết (Variables)
  LARK_DOMAIN: process.env.LARK_DOMAIN    || 'https://open.larksuite.com',
  FB_USER_TOKEN: process.env.FB_USER_TOKEN|| '',
  FB_VERSION:  process.env.FB_VERSION     || 'v25.0',
  PER_PAGE:    parseInt(process.env.POSTS_PER_PAGE || '100', 10), // giới hạn bài/1 page (0 = hết)
};
const DRY = process.argv.includes('--dry-run');
const UPDATE = process.argv.includes('--update');
if (!DRY && (!CFG.APP_SECRET || !CFG.FB_USER_TOKEN)) {
  console.error('!! Thiếu LARK_APP_SECRET hoặc FB_USER_TOKEN — đặt qua biến môi trường.');
  process.exit(1);
}
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
const plain = v => v==null?'':typeof v==='string'?v:Array.isArray(v)?v.map(x=>x.text||x.name||'').join(''):(v.text||v.name||v.link||String(v));
const num = v => (v==null || isNaN(v)) ? 0 : Number(v);

// ---- Lark ----
async function larkToken() {
  const r = await fetch(CFG.LARK_DOMAIN+'/open-apis/auth/v3/tenant_access_token/internal',
    { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({app_id:CFG.APP_ID,app_secret:CFG.APP_SECRET}) });
  const j = await r.json(); if (j.code!==0) throw new Error('Lark token: '+JSON.stringify(j));
  return j.tenant_access_token;
}
async function listFields(tk) {
  const r = await fetch(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${CFG.TABLE_ID}/fields?page_size=200`,
    { headers:{Authorization:'Bearer '+tk} });
  const j = await r.json(); if (j.code!==0) throw new Error('fields: '+JSON.stringify(j));
  return (j.data.items||[]).map(f=>f.field_name);
}
async function listRecords(tk) {
  let items=[], pt='';
  do { const r=await fetch(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${CFG.TABLE_ID}/records?field_names=%5B%22Post-ID%22%5D&page_size=500`+(pt?'&page_token='+pt:''),{headers:{Authorization:'Bearer '+tk}});
    const j=await r.json(); if(j.code!==0)throw new Error('records: '+JSON.stringify(j));
    items=items.concat(j.data.items||[]); pt=j.data.has_more?j.data.page_token:''; } while(pt);
  return items;
}
async function batch(tk, action, payload) {
  const r=await fetch(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${CFG.TABLE_ID}/records/${action}`,
    {method:'POST',headers:{'Content-Type':'application/json; charset=utf-8',Authorization:'Bearer '+tk},body:JSON.stringify(payload)});
  const j=await r.json(); if(j.code!==0)throw new Error(action+': '+JSON.stringify(j)); return j;
}

// ---- Facebook ----
async function fbPages() {
  let url=`https://graph.facebook.com/${CFG.FB_VERSION}/me/accounts?fields=name,id,access_token&limit=200&access_token=${encodeURIComponent(CFG.FB_USER_TOKEN)}`;
  let out=[]; while(url){ const r=await fetch(url); const j=await r.json();
    if(j.error) throw new Error('FB accounts: '+JSON.stringify(j.error));
    out=out.concat(j.data||[]); url=(j.paging&&j.paging.next)||''; } return out;
}
const REACTS = [['LIKE','r_like'],['LOVE','r_love'],['HAHA','r_haha'],['WOW','r_wow'],['SAD','r_sad'],['ANGRY','r_angry'],['CARE','r_care']];
async function fbPosts(pageId, pageTok) {
  const rf = REACTS.map(([t,a])=>`reactions.type(${t}).summary(total_count).limit(0).as(${a})`).join(',');
  const fields = `id,message,permalink_url,created_time,shares,comments.summary(total_count).limit(0),reactions.summary(total_count).limit(0).as(reactions),${rf}`;
  let url=`https://graph.facebook.com/${CFG.FB_VERSION}/${pageId}/published_posts?fields=${fields}&limit=50&access_token=${encodeURIComponent(pageTok)}`;
  let out=[];
  while(url){ const r=await fetch(url); const j=await r.json();
    if(j.error) throw new Error('FB posts '+pageId+': '+JSON.stringify(j.error));
    out=out.concat(j.data||[]);
    if (CFG.PER_PAGE && out.length>=CFG.PER_PAGE) { out=out.slice(0,CFG.PER_PAGE); break; }
    url=(j.paging&&j.paging.next)||''; }
  return out;
}
// created_time UTC -> ngày/tháng theo giờ VN (+7)
function vnDate(created) {
  const d = new Date(new Date(created).getTime() + 7*3600*1000);
  const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,'0'), day=String(d.getUTCDate()).padStart(2,'0');
  return { date:`${y}-${m}-${day}`, month:`${y}-${m}` };
}
const rc = (p,a) => num(p[a] && p[a].summary && p[a].summary.total_count);

(async()=>{
  const tk = DRY ? null : await larkToken();
  if (!DRY) {
    const names = await listFields(tk);
    const need = ['Post-ID','Nội dung','Link post','Lượt share','Lượt bình luận','Số tương tác','LIKE','LOVE','HAHA','WOW','SAD','ANGRY','CARE','Ngày đăng','Tháng'];
    const miss = need.filter(n=>!names.includes(n));
    if (miss.length) log('!! Cột thiếu (sẽ bỏ qua): ' + miss.join(', '));
  }
  const pages = await fbPages();
  log(`Có ${pages.length} Page. Lấy tối đa ${CFG.PER_PAGE||'∞'} bài/Page.`);

  // Gom toàn bộ bài của mọi page
  const all = [];
  for (const pg of pages) {
    const posts = await fbPosts(pg.id, pg.access_token);
    log(`  ${pg.name}: ${posts.length} bài`);
    for (const p of posts) all.push(p);
  }
  log(`Tổng ${all.length} bài.`);
  if (DRY) { all.slice(0,10).forEach(p=>log(`  ${p.id} | ${p.created_time} | react=${rc(p,'reactions')} cmt=${num(p.comments&&p.comments.summary&&p.comments.summary.total_count)} share=${num(p.shares&&p.shares.count)}`)); return; }

  const buildFields = p => {
    const d = vnDate(p.created_time);
    const reactTotal = rc(p,'reactions');
    const comments = num(p.comments && p.comments.summary && p.comments.summary.total_count);
    const shares = num(p.shares && p.shares.count);
    return {
      'Post-ID': p.id,
      'Nội dung': p.message || '',
      'Link post': p.permalink_url ? { link:p.permalink_url, text:'Xem post' } : undefined,
      'Lượt share': shares,
      'Lượt bình luận': comments,
      'Số tương tác': reactTotal + comments + shares, // tổng tương tác = reaction + cmt + share
      'LIKE': rc(p,'r_like'), 'LOVE': rc(p,'r_love'), 'HAHA': rc(p,'r_haha'), 'WOW': rc(p,'r_wow'),
      'SAD': rc(p,'r_sad'), 'ANGRY': rc(p,'r_angry'), 'CARE': rc(p,'r_care'),
      'Ngày đăng': d.date, 'Tháng': d.month,
    };
  };
  const clean = o => { for (const k of Object.keys(o)) if (o[k]===undefined) delete o[k]; return o; };

  // Dedupe theo Post-ID
  const recs = await listRecords(tk);
  const byId = new Map();
  for (const r of recs) { const pid = plain(r.fields['Post-ID']).trim(); if (pid) byId.set(pid, r.record_id); }

  const toCreate = [], toUpdate = [];
  for (const p of all) {
    const exist = byId.get(p.id);
    if (exist) { if (UPDATE) toUpdate.push({ record_id:exist, fields:clean(buildFields(p)) }); }
    else toCreate.push({ fields:clean(buildFields(p)) });
  }

  // Ghi theo lô 500
  const chunk = (arr,n)=>{const o=[];for(let i=0;i<arr.length;i+=n)o.push(arr.slice(i,i+n));return o;};
  let added=0, updated=0;
  for (const c of chunk(toCreate,500)) { const j=await batch(tk,'batch_create',{records:c}); added+=j.data.records.length; }
  for (const c of chunk(toUpdate,500)) { const j=await batch(tk,'batch_update',{records:c}); updated+=j.data.records.length; }
  log(`Xong. Thêm ${added}, cập nhật ${updated}, bỏ qua ${all.length-added-updated}.`);
})().catch(e=>{console.error('FATAL',e.message||e);process.exit(1);});
