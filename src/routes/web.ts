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
     <label for="su">Username</label>
     <input id="su" autocomplete="username" placeholder="e.g. julia" />
     <button class="primary full mt" id="signup">Create account</button>
     <div class="err" id="suErr"></div>
     <div id="tokenBox" hidden>
       <div class="notice">
         <p style="margin:0 0 4px"><b>Save your sync token now.</b> It won't be shown again.</p>
         <p class="muted" style="margin:0">This is your password on your reader and here on the web.</p>
       </div>
       <code class="token" id="tokenVal"></code>
       <div class="row">
         <button class="ghost" id="copyTok">Copy token</button>
         <a href="/account">Continue →</a>
       </div>
     </div>
   </div>

   <div class="card">
     <h2>Sign in</h2>
     <label for="li">Sync token</label>
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
  const { ok, data } = await post('/auth/signup', { username: $('su').value.trim() });
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

const ACCOUNT = shell(
  'Account',
  `<div>
     <span class="eyebrow">Account</span>
     <h1>Signed in as <span id="who">…</span></h1>
   </div>

   <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:var(--stone-500);margin:32px 0 12px;">Linked services</h2>
   <div id="connectors"><p class="muted">Loading…</p></div>

   <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:var(--stone-500);margin:32px 0 12px;">Your sync token</h2>
   <div class="card">
     <p class="muted" style="margin-top:0">Use this as the password on your reader (KOReader / CrossPoint sync settings), with your username. Rotating it signs your reader out until you enter the new one.</p>
     <button class="ghost" id="rotate">Rotate token</button>
     <div id="rotBox" hidden>
       <code class="token" id="rotVal"></code>
       <button class="ghost" id="copyRot">Copy token</button>
     </div>
   </div>

   <p class="foot"><a href="https://github.com/crosspoint-reader/crosspoint-sync">Want to self host this?</a></p>

<script>
const $ = (id) => document.getElementById(id);
async function jget(u){ const r = await fetch(u); return { ok:r.ok, data: await r.json().catch(()=>({})) }; }
async function jsend(u, m='POST', body){ const r = await fetch(u,{method:m,headers:body?{'content-type':'application/json'}:undefined, body: body?JSON.stringify(body):undefined}); return { ok:r.ok, data: await r.json().catch(()=>({})) }; }

(async () => {
  const me = await jget('/auth/me');
  if (!me.ok) { location.href='/'; return; }
  $('who').textContent = me.data.username;
  renderConnectors();
})();

async function renderConnectors() {
  const { ok, data } = await jget('/api/v1/connectors');
  const el = $('connectors');
  if (!ok) { el.innerHTML = '<p class="muted">Could not load services.</p>'; return; }
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
    return '<div class="card"><div class="row"><div><div style="font-weight:600">'+c.name+' '+badge+
      '</div><div class="muted" style="margin-top:3px">syncs '+c.carries.join(', ')+(c.account?' · '+c.account:'')+'</div></div>'+action+'</div></div>';
  }).join('');
  el.querySelectorAll('[data-unlink]').forEach(b => b.onclick = async () => {
    await jsend('/api/v1/connectors/'+b.dataset.unlink, 'DELETE'); renderConnectors();
  });
  el.querySelectorAll('[data-link]').forEach(b => b.onclick = () => { location.href = '/link/' + b.dataset.link; });
}

$('logout').onclick = async () => { await jsend('/auth/logout'); location.href='/'; };
$('rotate').onclick = async () => {
  if (!confirm('Rotate your token? Your reader will stop syncing until you enter the new one.')) return;
  const { ok, data } = await jsend('/auth/token/rotate');
  if (ok) { $('rotVal').textContent = data.token; $('rotBox').hidden = false; }
};
async function copyWithFeedback(btn, text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
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
$('copyRot').onclick = () => copyWithFeedback($('copyRot'), $('rotVal').textContent);
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

  return app;
}
