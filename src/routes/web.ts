import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../auth/middleware.js';
import { SESSION_COOKIE, verifySession } from '../auth/session.js';

/**
 * Minimal server-rendered web UI (no framework, no build step, no deps). Styled
 * to match the CrossPoint Reader site: Inter (UI) + Lora (display) + Geist Mono,
 * stone neutrals with the forest-green brand accent, white cards on stone-50.
 * Pages are static HTML calling the JSON /auth and /api/v1 endpoints via fetch;
 * the session cookie authenticates automatically (same-origin).
 */

const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');
const LOGO = fs.readFileSync(path.join(ASSETS_DIR, 'logo.png'));
const FAVICON = fs.readFileSync(path.join(ASSETS_DIR, 'favicon.png'));

const STYLE = `
  :root {
    color-scheme: light;
    --stone-50:#fafaf9; --stone-100:#f5f5f4; --stone-200:#e7e5e4; --stone-300:#d6d3d1;
    --stone-400:#a8a29e; --stone-500:#78716c; --stone-600:#57534e; --stone-700:#44403c;
    --stone-900:#1c1917; --stone-950:#0c0a09;
    --brand-50:#f0f5f3; --brand-100:#d6e5de; --brand-400:#69917d; --brand-500:#4a7a62;
    --brand-600:#3d6652; --brand-700:#315243;
    --ring:rgba(12,10,9,0.05);
  }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body {
    margin:0; background:var(--stone-50); color:var(--stone-900);
    font-family:"InterVariable","Inter",ui-sans-serif,system-ui,sans-serif;
    font-feature-settings:"cv02","cv03","cv04","cv11";
    -webkit-font-smoothing:antialiased;
  }
  .display { font-family:"Lora",ui-serif,serif; }
  .mono { font-family:"Geist Mono",ui-monospace,monospace; }

  header.site {
    position:sticky; top:0; z-index:40;
    border-bottom:1px solid rgba(231,229,228,0.8);
    background:rgba(250,250,249,0.8); backdrop-filter:blur(12px);
  }
  header.site .bar { max-width:64rem; margin:0 auto; padding:14px 20px;
    display:flex; align-items:center; justify-content:space-between; gap:16px; }
  .wordmark { display:flex; align-items:center; gap:10px; text-decoration:none; }
  .wordmark img { width:28px; height:28px; border-radius:6px; display:block; }
  .wordmark span { font-family:"Lora",serif; font-weight:600; font-size:16px;
    letter-spacing:-0.01em; color:var(--stone-900); }
  .wordmark .accent { color:var(--brand-600); }

  .wrap { max-width:32rem; margin:0 auto; padding:44px 20px 96px; }
  .center { text-align:center; }
  .eyebrow { display:inline-flex; align-items:center; gap:7px; font-size:12px; font-weight:600;
    letter-spacing:0.08em; text-transform:uppercase; color:var(--brand-600); }
  .eyebrow::before { content:""; width:16px; height:1px; background:var(--brand-400); display:inline-block; }
  h1 { font-family:"Lora",serif; font-weight:600; font-size:30px; line-height:1.15;
    letter-spacing:-0.015em; margin:14px 0 0; color:var(--stone-900); }
  .sub { color:var(--stone-600); margin:12px 0 0; line-height:1.6; }

  .card { background:#fff; border-radius:12px; box-shadow:0 0 0 1px var(--ring); padding:24px; }
  .card + .card { margin-top:16px; }
  .card h2 { font-size:13px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em;
    color:var(--stone-500); margin:0 0 14px; }

  label { display:block; font-size:14px; font-weight:500; color:var(--stone-700); margin:0 0 6px; }
  input { width:100%; padding:10px 14px; border:1px solid var(--stone-200); border-radius:8px;
    background:var(--stone-50); color:var(--stone-900); font-size:14px; }
  input::placeholder { color:var(--stone-400); }
  input:focus { outline:none; border-color:var(--brand-400); box-shadow:0 0 0 3px rgba(74,122,98,0.15); }

  button { appearance:none; border:0; border-radius:8px; padding:10px 16px; font-size:14px;
    font-weight:600; cursor:pointer; font-family:inherit; }
  button.primary { background:var(--brand-500); color:#fff; box-shadow:0 1px 2px rgba(0,0,0,0.06); }
  button.primary:hover { background:var(--brand-600); }
  button.ghost { background:#fff; color:var(--stone-700); box-shadow:0 0 0 1px var(--stone-200); }
  button.ghost:hover { background:var(--stone-50); }
  button.danger { background:#fff; color:#b91c1c; box-shadow:0 0 0 1px #f0cccc; }
  button.danger:hover { background:#fef2f2; }
  button.copied { color:var(--brand-700); box-shadow:0 0 0 1px var(--brand-100); background:var(--brand-50); opacity:1; }
  button:disabled { opacity:.5; cursor:default; }
  button.copied:disabled { opacity:1; }
  button.full { width:100%; }
  .mt { margin-top:14px; }

  .row { display:flex; align-items:center; justify-content:space-between; gap:14px; }
  .muted { color:var(--stone-500); font-size:13px; line-height:1.55; }
  .pill { font-size:11px; font-weight:600; padding:2px 9px; border-radius:999px;
    box-shadow:0 0 0 1px var(--stone-200); color:var(--stone-500); text-transform:uppercase; letter-spacing:0.03em; }
  .pill.ok { color:var(--brand-700); box-shadow:0 0 0 1px var(--brand-100); background:var(--brand-50); }
  .pill.warn { color:#9a7a2e; box-shadow:0 0 0 1px #ecdcae; background:#faf5e6; }

  code.token { display:block; margin:12px 0; padding:12px 14px; background:var(--stone-50);
    box-shadow:0 0 0 1px var(--stone-200); border-radius:8px; font-family:"Geist Mono",monospace;
    font-size:13px; word-break:break-all; color:var(--stone-900); }
  .notice { margin-top:16px; padding:14px 16px; background:var(--brand-50); border-radius:8px; }
  .notice b { color:var(--brand-700); }
  .err { color:#b91c1c; font-size:13px; min-height:18px; margin-top:8px; }
  .foot { text-align:center; color:var(--stone-400); font-size:12px; margin-top:28px; }
  .foot a { color:var(--stone-500); }
  a { color:var(--brand-600); text-decoration:none; }
  a:hover { text-decoration:underline; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · CrossPoint Sync</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="preconnect" href="https://rsms.me/">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lora:wght@500;600;700&family=Geist+Mono:wght@400;500&display=swap">
<style>${STYLE}</style></head>
<body>
<header class="site"><div class="bar">
  <a class="wordmark" href="/"><img src="/logo.png" alt=""><span>CrossPoint <span class="accent">Sync</span></span></a>
  ${title === 'Account' ? '<button class="ghost" id="logout">Sign out</button>' : ''}
</div></header>
<div class="wrap">${body}</div>
</body></html>`;
}

const LANDING = shell(
  'Sign in',
  `<div class="center">
     <span class="eyebrow">Sync Hub</span>
     <h1>Your reading, everywhere</h1>
     <p class="sub">One account to sync reading progress across your devices and link services like Hardcover, Readwise, and BookFusion.</p>
   </div>

   <div class="card mt" style="margin-top:32px">
     <h2>Create account</h2>
     <label for="su">Choose a handle</label>
     <input id="su" autocomplete="username" placeholder="e.g. julia" />
     <button class="primary full mt" id="signup">Create account</button>
     <div class="err" id="suErr"></div>
     <div id="tokenBox" hidden>
       <div class="notice">
         <p style="margin:0 0 4px"><b>Save your login token now.</b> It won't be shown again.</p>
         <p class="muted" style="margin:0">This is how you sign into this website. It is not your reader password. You set up your reader sync separately, inside.</p>
       </div>
       <code class="token" id="tokenVal"></code>
       <div class="row">
         <button class="ghost" id="copyTok">Copy token</button>
         <a href="/account">Continue &rarr;</a>
       </div>
     </div>
   </div>

   <div class="card">
     <h2>Sign in</h2>
     <label for="li">Login token</label>
     <input id="li" class="mono" placeholder="xp1_…" autocomplete="current-password" />
     <button class="primary full mt" id="login">Sign in</button>
     <div class="err" id="liErr"></div>
   </div>

   <p class="foot"><a href="https://github.com/crosspoint-reader/crosspoint-sync">Want to self host this?</a></p>

<script>
const $ = (id) => document.getElementById(id);
async function post(url, body) {
  const r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  return { ok: r.ok, data: await r.json().catch(()=>({})) };
}
$('signup').onclick = async () => {
  $('suErr').textContent = '';
  const { ok, data } = await post('/auth/signup', { handle: $('su').value.trim() });
  if (!ok) { $('suErr').textContent = data.error || 'Something went wrong'; return; }
  $('tokenVal').textContent = data.token;
  $('tokenBox').hidden = false;
  $('signup').disabled = true; $('su').disabled = true;
};
async function copyWithFeedback(btn, text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API can fail (insecure context / permissions); fall back.
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {} document.body.removeChild(ta);
  }
  const original = btn.textContent;
  btn.textContent = 'Copied ✓';
  btn.classList.add('copied');
  btn.disabled = true;
  setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); btn.disabled = false; }, 1600);
}
$('copyTok').onclick = () => copyWithFeedback($('copyTok'), $('tokenVal').textContent);
$('login').onclick = async () => {
  $('liErr').textContent = '';
  const { ok, data } = await post('/auth/login', { token: $('li').value.trim() });
  if (!ok) { $('liErr').textContent = data.error || 'Invalid token'; return; }
  location.href = '/account';
};
</script>`
);

const SECTION = 'font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:var(--stone-500);margin:32px 0 12px;';

const ACCOUNT = shell(
  'Account',
  `<div>
     <span class="eyebrow">Account</span>
     <h1>Signed in as <span id="who">…</span></h1>
   </div>

   <h2 style="${SECTION}">CrossPoint Sync (KOSync)</h2>
   <div id="kosync"><p class="muted">Loading…</p></div>

   <h2 style="${SECTION}">Linked services</h2>
   <div id="connectors"><p class="muted">Loading…</p></div>

   <h2 style="${SECTION}">Website login</h2>
   <div class="card">
     <p class="muted" style="margin-top:0">The token you use to sign into this website. Rotating it signs you out on the web and does not affect your reader.</p>
     <div class="row" style="justify-content:flex-start;gap:8px">
       <button class="ghost" id="rotate">Rotate login token</button>
       <button class="danger" id="delAccount">Delete account</button>
     </div>
     <div id="rotBox" hidden>
       <code class="token" id="rotVal"></code>
       <button class="ghost" id="copyRot">Copy token</button>
     </div>
   </div>

   <p class="foot"><a href="https://github.com/crosspoint-reader/crosspoint-sync">Want to self host this?</a></p>

<script>
const ORIGIN = window.location.origin;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
async function jget(u){ const r = await fetch(u); return { ok:r.ok, data: await r.json().catch(()=>({})) }; }
async function jsend(u, m='POST', body){ const r = await fetch(u,{method:m,headers:body?{'content-type':'application/json'}:undefined, body: body?JSON.stringify(body):undefined}); return { ok:r.ok, data: await r.json().catch(()=>({})) }; }
async function copyWithFeedback(btn, text) {
  try { await navigator.clipboard.writeText(text); }
  catch { const ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy');}catch{} document.body.removeChild(ta); }
  const o=btn.textContent; btn.textContent='Copied ✓'; btn.classList.add('copied'); btn.disabled=true;
  setTimeout(()=>{btn.textContent=o; btn.classList.remove('copied'); btn.disabled=false;}, 1600);
}

(async () => {
  const me = await jget('/auth/me');
  if (!me.ok) { location.href='/'; return; }
  $('who').textContent = me.data.handle;
  renderKosync();
})();

// Reader-setup panel shown once a sync account exists. The password is the one
// the user chose (we never store or display plaintext), so we only echo server
// + username and remind them to use their chosen password.
function readerSetup(username) {
  return '<div class="notice"><p style="margin:0 0 8px"><b>Enter these in your reader</b> under Settings &rarr; KOReader Sync.</p>'
    + '<dl style="margin:0;font-size:13px">'
    + '<div class="row"><dt class="muted">Server</dt><dd class="mono" style="margin:0">'+esc(ORIGIN)+'</dd></div>'
    + '<div class="row" style="margin-top:6px"><dt class="muted">Username</dt><dd class="mono" style="margin:0">'+esc(username)+'</dd></div>'
    + '<div class="row" style="margin-top:6px"><dt class="muted">Password</dt><dd style="margin:0">the password you just chose</dd></div>'
    + '</dl></div>';
}

async function renderKosync() {
  const { ok, data } = await jget('/account/kosync');
  const el = $('kosync');
  if (!ok) { el.innerHTML = '<p class="muted">Could not load.</p>'; return; }
  if (data.linked) {
    el.innerHTML =
      '<div class="card"><div class="row"><div><div style="font-weight:600">'+esc(data.username)+' <span class="pill ok">connected</span></div>'
      + '<div class="muted" style="margin-top:3px">Your reader syncs reading progress to this KOSync account.</div></div>'
      + '<button class="ghost" id="ksPw">Change password</button></div>'
      + '<div id="ksPwBox" style="margin-top:12px"></div>'
      + '<div class="row" style="margin-top:12px;justify-content:flex-start;gap:8px"><button class="ghost" id="ksUnlink">Disconnect</button>'
      + '<button class="danger" id="ksDelete">Delete sync account</button></div></div>';
    $('ksPw').onclick = () => {
      $('ksPwBox').innerHTML = '<label>New password</label><input id="ksNewPw" type="password" autocomplete="new-password">'
        + '<button class="primary mt" id="ksPwSave">Save password</button><div class="err" id="ksPwErr"></div>';
      $('ksPwSave').onclick = async () => {
        $('ksPwErr').textContent = '';
        const r = await jsend('/account/kosync/password', 'POST', { password: $('ksNewPw').value });
        if (r.ok) { $('ksPwBox').innerHTML = readerSetup(data.username); }
        else { $('ksPwErr').textContent = r.data.error || 'Could not update'; }
      };
    };
    $('ksUnlink').onclick = async () => {
      if (!confirm('Disconnect this sync account from your login? Your reading data is kept.')) return;
      await jsend('/account/kosync', 'DELETE'); renderKosync();
    };
    $('ksDelete').onclick = async () => {
      if (!confirm('Permanently delete this sync account and ALL its reading data (progress, bookmarks, clippings, stats, linked services)? This cannot be undone.')) return;
      await jsend('/account/kosync/data', 'DELETE'); renderKosync();
    };
    renderConnectors();
    return;
  }
  el.innerHTML =
    '<div class="card"><div style="font-weight:600">Set up reading sync</div>'
    + '<p class="muted" style="margin:6px 0 14px">CrossPoint Sync is a KOReader-compatible (KOSync) progress server. Create a sync account, then enter it in your reader under Settings &rarr; KOReader Sync. Already made one on your device? Connect it below.</p>'
    + '<div><label>Username</label><input id="ksUser" autocomplete="off" placeholder="your sync username"></div>'
    + '<div style="margin-top:10px"><label>Password</label><input id="ksPass" type="password" autocomplete="new-password"></div>'
    + '<div style="margin-top:10px"><label>Confirm password</label><input id="ksPass2" type="password" autocomplete="new-password"></div>'
    + '<button class="primary full mt" id="ksCreate">Create sync account</button>'
    + '<div id="ksCreateBox" style="margin-top:12px"></div>'
    + '<div class="err" id="ksErr"></div>'
    + '<hr style="border:0;border-top:1px solid var(--stone-200);margin:18px 0">'
    + '<div style="font-weight:600;font-size:14px">Connect an existing sync account</div>'
    + '<p class="muted" style="margin:4px 0 10px">Use the username and password you already set on your device.</p>'
    + '<div><label>Username</label><input id="ksLuser" autocomplete="off"></div>'
    + '<div style="margin-top:10px"><label>Password</label><input id="ksLpass" type="password" autocomplete="off"></div>'
    + '<button class="ghost mt" id="ksLink">Connect existing</button>'
    + '<div class="err" id="ksLerr"></div></div>';
  $('ksCreate').onclick = async () => {
    $('ksErr').textContent = '';
    const u = $('ksUser').value.trim(), p = $('ksPass').value, p2 = $('ksPass2').value;
    if (p !== p2) { $('ksErr').textContent = 'Passwords do not match.'; return; }
    const r = await jsend('/account/kosync', 'POST', { username: u, password: p });
    if (r.ok) {
      el.querySelector('.card').innerHTML = '<div style="font-weight:600">'+esc(r.data.username)+' <span class="pill ok">connected</span></div>'
        + '<div style="margin-top:12px">'+readerSetup(r.data.username)+'</div>'
        + '<div style="margin-top:12px"><button class="primary" id="ksDone">Done</button></div>';
      $('ksDone').onclick = () => renderKosync();
      // The sync account now exists, so surface the linkable services right away.
      renderConnectors();
    } else { $('ksErr').textContent = r.data.error || 'Could not create'; }
  };
  $('ksLink').onclick = async () => {
    $('ksLerr').textContent = '';
    const r = await jsend('/account/kosync', 'PUT', { username: $('ksLuser').value.trim(), password: $('ksLpass').value });
    if (r.ok) { renderKosync(); } else { $('ksLerr').textContent = r.data.error || 'Could not connect'; }
  };
  $('connectors').innerHTML = '<p class="muted">Set up reading sync above to link services.</p>';
}

async function renderConnectors() {
  const { ok, data } = await jget('/api/v1/connectors');
  const el = $('connectors');
  if (!ok) { el.innerHTML = '<p class="muted">Set up reading sync above to link services.</p>'; return; }
  if (data.encryption !== 'enabled') {
    el.innerHTML = '<div class="card"><p class="muted" style="margin:0">Service linking is disabled on this server (no <code class="mono">TOKEN_ENC_KEY</code> configured).</p></div>';
    return;
  }
  el.innerHTML = data.connectors.map(c => {
    const badge = c.linked
      ? '<span class="pill ok">'+(c.status==='needs_reauth'?'needs reauth':'linked')+'</span>'
      : (c.experimental ? '<span class="pill warn">experimental</span>' : '<span class="pill">not linked</span>');
    const action = c.linked
      ? '<button class="ghost" data-unlink="'+c.id+'">Unlink</button>'
      : '<button class="primary" data-link="'+c.id+'">Link</button>';
    return '<div class="card"><div class="row"><div><div style="font-weight:600">'+esc(c.name)+' '+badge+
      '</div><div class="muted" style="margin-top:3px">syncs '+esc(c.carries.join(', '))+(c.account?' · '+esc(c.account):'')+'</div></div>'+action+'</div></div>';
  }).join('');
  el.querySelectorAll('[data-unlink]').forEach(b => b.onclick = async () => {
    await jsend('/api/v1/connectors/'+b.dataset.unlink, 'DELETE'); renderConnectors();
  });
  el.querySelectorAll('[data-link]').forEach(b => b.onclick = () => { location.href = '/link/' + b.dataset.link; });
}

$('logout').onclick = async () => { await jsend('/auth/logout'); location.href='/'; };
$('rotate').onclick = async () => {
  if (!confirm('Rotate your website login token? You will be signed out on the web and must sign in with the new token.')) return;
  const { ok, data } = await jsend('/auth/token/rotate');
  if (ok) { $('rotVal').textContent = data.token; $('rotBox').hidden = false; }
};
$('copyRot').onclick = () => copyWithFeedback($('copyRot'), $('rotVal').textContent);
$('delAccount').onclick = async () => {
  if (!confirm('Permanently delete your account, your sync account, and ALL reading data? This cannot be undone.')) return;
  if (!confirm('Are you absolutely sure? Everything will be erased.')) return;
  await jsend('/account', 'DELETE'); location.href = '/';
};
</script>`
);

const LINK = shell(
  'Link service',
  `<div><a class="muted" href="/account">&larr; Account</a></div>
   <div style="margin-top:16px"><span class="eyebrow" id="eyebrow">Link service</span>
     <h1 id="title">Link</h1>
     <p class="sub" id="desc"></p></div>
   <div class="card mt" style="margin-top:24px" id="form"><p class="muted">Loading…</p></div>

<script>
const ID = decodeURIComponent(location.pathname.split('/').pop());
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
async function jget(u){ const r = await fetch(u); return { ok:r.ok, status:r.status, data: await r.json().catch(()=>({})) }; }
async function jsend(u, m='POST', body){ const r = await fetch(u,{method:m,headers:body?{'content-type':'application/json'}:undefined, body: body?JSON.stringify(body):undefined}); return { ok:r.ok, status:r.status, data: await r.json().catch(()=>({})) }; }

const HINTS = {
  hardcover: 'Paste your Hardcover API token from hardcover.app/account/api. Syncs your reading progress and shelf status.',
  readwise: 'Paste your Readwise access token from readwise.io/access_token. Syncs your highlights.',
  kosync: 'Mirror your reading progress to another KOReader-compatible (KOSync) server, so your other devices see it too.',
  bookfusion: 'Connect your BookFusion account to sync reading progress. You will approve the request on bookfusion.com.'
};

(async () => {
  const { ok, status, data } = await jget('/api/v1/connectors');
  if (status === 409) { location.href = '/account'; return; }   // no sync account yet
  if (!ok) { $('form').innerHTML = '<p class="muted">Could not load.</p>'; return; }
  const conn = (data.connectors || []).find(c => c.id === ID);
  if (!conn) { location.href = '/account'; return; }
  $('title').textContent = 'Link ' + conn.name;
  $('desc').textContent = HINTS[ID] || '';
  if (conn.experimental) $('eyebrow').textContent = 'Experimental';
  render(conn);
})();

function done() { location.href = '/account'; }

function render(conn) {
  const f = $('form');
  if (conn.credential_kind === 'token') {
    f.innerHTML = '<label>API token</label><input id="tok" class="mono" placeholder="paste token">'
      + '<button class="primary full mt" id="go">Link ' + esc(conn.name) + '</button><div class="err" id="e"></div>';
    $('go').onclick = async () => {
      $('e').textContent = '';
      const r = await jsend('/api/v1/connectors/' + ID, 'PUT', { credential: { token: $('tok').value.trim() } });
      if (r.ok) done(); else $('e').textContent = r.data.message || 'Could not link';
    };
  } else if (conn.credential_kind === 'kosync') {
    f.innerHTML = '<label>Server URL</label><input id="srv" class="mono" placeholder="https://sync.koreader.rocks:443">'
      + '<div style="margin-top:10px"><label>Username</label><input id="u" autocomplete="off"></div>'
      + '<div style="margin-top:10px"><label>Password</label><input id="p" type="password" autocomplete="off"></div>'
      + '<button class="primary full mt" id="go">Connect server</button><div class="err" id="e"></div>';
    $('go').onclick = async () => {
      $('e').textContent = '';
      const r = await jsend('/api/v1/connectors/' + ID, 'PUT', { credential: { server: $('srv').value.trim(), username: $('u').value.trim(), password: $('p').value } });
      if (r.ok) done(); else $('e').textContent = r.data.message || 'Could not connect';
    };
  } else if (conn.credential_kind === 'device_code') {
    f.innerHTML = '<p class="muted" style="margin-top:0">Click start, then approve the request on ' + esc(conn.name) + '.</p>'
      + '<button class="primary" id="start">Start</button><div id="dc" style="margin-top:14px"></div><div class="err" id="e"></div>';
    $('start').onclick = startDeviceFlow;
  } else {
    f.innerHTML = '<p class="muted">This connector is not linkable from here yet.</p>';
  }
}

async function startDeviceFlow() {
  $('e').textContent = '';
  $('start').disabled = true;
  const r = await jsend('/api/v1/connectors/' + ID + '/link/begin');
  if (!r.ok) { $('e').textContent = r.data.message || 'Could not start'; $('start').disabled = false; return; }
  const { device_code, user_code, verification_uri, interval } = r.data;
  $('dc').innerHTML = '<div class="notice"><p style="margin:0 0 8px">Go to <a href="' + esc(verification_uri) + '" target="_blank" rel="noopener">' + esc(verification_uri) + '</a> and enter this code:</p>'
    + '<code class="token" style="text-align:center;font-size:20px;letter-spacing:3px">' + esc(user_code) + '</code>'
    + '<p class="muted" id="poll" style="margin:8px 0 0">Waiting for approval…</p></div>';
  const deadline = Date.now() + 15 * 60 * 1000;
  const tick = async () => {
    if (Date.now() > deadline) { $('poll').textContent = 'Timed out. Start again.'; return; }
    const p = await jsend('/api/v1/connectors/' + ID + '/link/poll', 'POST', { device_code });
    if (p.data.status === 'ok') { done(); return; }
    if (p.data.status === 'pending') { setTimeout(tick, Math.max(2, interval || 5) * 1000); return; }
    $('poll').textContent = p.data.error || 'Linking failed. Start again.';
    $('start').disabled = false;
  };
  setTimeout(tick, Math.max(2, interval || 5) * 1000);
}
</script>`
);

export function webRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/logo.png', (c) => {
    c.header('content-type', 'image/png');
    c.header('cache-control', 'public, max-age=86400');
    return c.body(LOGO);
  });
  app.get('/favicon.png', (c) => {
    c.header('content-type', 'image/png');
    c.header('cache-control', 'public, max-age=86400');
    return c.body(FAVICON);
  });

  app.get('/', (c) => {
    if (verifySession(getCookie(c, SESSION_COOKIE))) return c.redirect('/account');
    return c.html(LANDING);
  });

  app.get('/account', (c) => {
    if (!verifySession(getCookie(c, SESSION_COOKIE))) return c.redirect('/');
    return c.html(ACCOUNT);
  });

  app.get('/link/:id', (c) => {
    if (!verifySession(getCookie(c, SESSION_COOKIE))) return c.redirect('/');
    return c.html(LINK);
  });

  return app;
}
