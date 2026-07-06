#!/usr/bin/env node
/*
 * fetch-pages-to-lark.js — Lấy danh sách Facebook Page (/me/accounts) rồi ghi vào 1 bảng Lark Base.
 * Ghi các cột: TÊN Page, PAGE ID, PAGE TOKEN, Category, Follower, Avatar. Bỏ qua page đã có (so theo Page ID).
 * Mục đích: dựng bảng "Danh sách Page" để đăng Reel NHIỀU trang (mỗi trang 1 token riêng).
 *
 * Chạy:  node fetch-pages-to-lark.js            (thêm page mới, không đụng page cũ)
 *        node fetch-pages-to-lark.js --update   (ghi đè lại token + info cho page đã có — token FB có thể đổi)
 *        node fetch-pages-to-lark.js --dry-run  (chỉ in ra, không ghi Lark)
 *
 * Bí mật đặt qua BIẾN MÔI TRƯỜNG (không hardcode):
 *   LARK_APP_SECRET   (bắt buộc)  — secret app Lark
 *   FB_USER_TOKEN     (bắt buộc)  — USER access token (không phải page token) có quyền pages_show_list
 * Tùy chọn ghi đè:
 *   LARK_APP_ID (default cli_aa8cccd0b262deed), LARK_APP_TOKEN (base), LARK_TABLE_ID, LARK_DOMAIN, FB_VERSION
 *   F_NAME / F_ID / F_TOKEN / F_CATEGORY / F_FOLLOWER / F_AVATAR — tên cột nếu auto-detect đoán sai.
 */
'use strict';
const CFG = {
  APP_ID:      process.env.LARK_APP_ID    || 'cli_aa8cccd0b262deed',
  APP_SECRET:  process.env.LARK_APP_SECRET|| '',
  APP_TOKEN:   process.env.LARK_APP_TOKEN || 'Rnmkbe9vMa7V6ssUP37lh3Cbgdd', // base chứa bảng Page
  TABLE_ID:    process.env.LARK_TABLE_ID  || 'tblNYaNnHUhMofPa',
  LARK_DOMAIN: process.env.LARK_DOMAIN    || 'https://open.larksuite.com',
  FB_USER_TOKEN: process.env.FB_USER_TOKEN|| '',
  FB_VERSION:  process.env.FB_VERSION     || 'v25.0',
  F_NAME:     process.env.F_NAME     || '',
  F_ID:       process.env.F_ID       || '',
  F_TOKEN:    process.env.F_TOKEN    || '',
  F_CATEGORY: process.env.F_CATEGORY || '',
  F_FOLLOWER: process.env.F_FOLLOWER || '',
  F_AVATAR:   process.env.F_AVATAR   || '',
};
const DRY = process.argv.includes('--dry-run');
const UPDATE = process.argv.includes('--update');
if (!DRY && (!CFG.APP_SECRET || !CFG.FB_USER_TOKEN)) {
  console.error('!! Thiếu LARK_APP_SECRET hoặc FB_USER_TOKEN — đặt qua biến môi trường.');
  process.exit(1);
}
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
const plain = v => v==null?'':typeof v==='string'?v:Array.isArray(v)?v.map(x=>x.text||x.name||'').join(''):(v.text||v.name||v.link||String(v));

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
  return (j.data.items||[]).map(f=>({ name:f.field_name, type:f.type })); // [{name,type}]
}
async function listRecords(tk) {
  let items=[], pt='';
  do { const r=await fetch(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${CFG.TABLE_ID}/records?page_size=200`+(pt?'&page_token='+pt:''),{headers:{Authorization:'Bearer '+tk}});
    const j=await r.json(); if(j.code!==0)throw new Error('records: '+JSON.stringify(j));
    items=items.concat(j.data.items||[]); pt=j.data.has_more?j.data.page_token:''; } while(pt);
  return items;
}
async function createRecord(tk, fields) {
  const r=await fetch(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${CFG.TABLE_ID}/records`,
    {method:'POST',headers:{'Content-Type':'application/json; charset=utf-8',Authorization:'Bearer '+tk},body:JSON.stringify({fields})});
  const j=await r.json(); if(j.code!==0)throw new Error('create: '+JSON.stringify(j)); return j;
}
async function updateRecord(tk, recId, fields) {
  const r=await fetch(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${CFG.TABLE_ID}/records/${recId}`,
    {method:'PUT',headers:{'Content-Type':'application/json; charset=utf-8',Authorization:'Bearer '+tk},body:JSON.stringify({fields})});
  const j=await r.json(); if(j.code!==0)throw new Error('update: '+JSON.stringify(j)); return j;
}
async function fbPages() {
  let url=`https://graph.facebook.com/${CFG.FB_VERSION}/me/accounts?fields=name,id,access_token,category,followers_count,fan_count,picture.type(large){url}&limit=200&access_token=${encodeURIComponent(CFG.FB_USER_TOKEN)}`;
  let out=[];
  while(url){ const r=await fetch(url); const j=await r.json();
    if(j.error) throw new Error('FB: '+JSON.stringify(j.error));
    out=out.concat(j.data||[]); url=(j.paging&&j.paging.next)||''; }
  return out;
}
// Đoán tên cột từ danh sách field thật của bảng. Ưu tiên biến F_* nếu người dùng đặt.
function pickFields(names) {
  const find = re => names.find(n=>re.test(n));
  const fToken = CFG.F_TOKEN || find(/token/i);
  const fId    = CFG.F_ID    || find(/\bid\b|page[\s_-]*id|id[\s_-]*page/i);
  const fName  = CFG.F_NAME  || names.find(n=>/tên|name|page|fanpage/i.test(n) && n!==fToken && n!==fId) || names[0];
  // Các cột phụ: loại trừ cột đã dùng cho tên/id/token để tránh khớp nhầm (vd "Fanpage" chứa "fan").
  const used = new Set([fName, fId, fToken]);
  const pick = re => names.find(n=>!used.has(n) && re.test(n));
  const fCategory = CFG.F_CATEGORY || pick(/category|danh[\s_-]*mục|thể[\s_-]*loại/i);
  const fFollower = CFG.F_FOLLOWER || pick(/follower|theo[\s_-]*dõi/i);
  const fAvatar   = CFG.F_AVATAR   || pick(/avatar|ảnh|hình|logo|picture|photo/i);
  return { fName, fId, fToken, fCategory, fFollower, fAvatar };
}

(async()=>{
  const pages = await fbPages();
  log(`FB trả về ${pages.length} Page.`);
  if (DRY) { pages.forEach(p=>log(`  ${p.id} | ${p.name} | ${p.category||'-'} | followers=${p.followers_count??p.fan_count??'-'} | token_len=${(p.access_token||'').length}`)); return; }

  const tk = await larkToken();
  const fieldsMeta = await listFields(tk);
  const names = fieldsMeta.map(f=>f.name);
  const typeOf = n => (fieldsMeta.find(f=>f.name===n)||{}).type;
  log('Cột trong bảng: ' + names.join(' | '));
  const { fName, fId, fToken, fCategory, fFollower, fAvatar } = pickFields(names);
  log(`Map cột -> TÊN="${fName}" ID="${fId}" TOKEN="${fToken}" CAT="${fCategory||'(bỏ)'}" FOLLOWER="${fFollower||'(bỏ)'}" AVATAR="${fAvatar||'(bỏ)'}"`);
  if (!fId || !fToken || !fName) {
    console.error('!! Không xác định được cột. Đặt env F_NAME / F_ID / F_TOKEN cho khớp tên cột ở trên.');
    process.exit(1);
  }

  // Ghép value theo kiểu cột (URL=15 cần object {link,text}; số=2 cần Number).
  const buildFields = (p, full) => {
    const f = full ? { [fName]: p.name, [fId]: p.id } : {};
    f[fToken] = p.access_token;
    if (fCategory && p.category != null) f[fCategory] = p.category;
    if (fFollower) { const n = p.followers_count ?? p.fan_count; if (n != null) f[fFollower] = typeOf(fFollower)===2 ? Number(n) : String(n); }
    if (fAvatar) { const url = p.picture && p.picture.data && p.picture.data.url;
      if (url) f[fAvatar] = typeOf(fAvatar)===15 ? { link:url, text:'Avatar' } : url; }
    return f;
  };

  const recs = await listRecords(tk);
  const byId = new Map();
  for (const r of recs) { const pid = plain(r.fields[fId]).trim(); if (pid) byId.set(pid, r.record_id); }

  let added=0, updated=0, skipped=0;
  for (const p of pages) {
    const exist = byId.get(p.id);
    if (exist) {
      if (UPDATE) { await updateRecord(tk, exist, buildFields(p, true)); log(`  ~ cập nhật: ${p.name}`); updated++; }
      else { log(`  = đã có, bỏ qua: ${p.name}`); skipped++; }
    } else { await createRecord(tk, buildFields(p, true)); log(`  + thêm: ${p.name} (${p.id})`); added++; }
  }
  log(`Xong. Thêm ${added}, cập nhật ${updated}, bỏ qua ${skipped}.`);
})().catch(e=>{console.error('FATAL',e.message||e);process.exit(1);});
