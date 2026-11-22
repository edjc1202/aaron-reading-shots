// Firebase backend shim: provides window.claude.use('db'|'user'|'sample') with the same
// API shape the game already uses on the Claude artifact runtime, so index.html stays identical.
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  collection, doc, onSnapshot, getDoc, getDocs, setDoc, deleteDoc, query, orderBy as fbOrderBy,
  getDocsFromServer, getDocFromServer
} from 'firebase/firestore';

const CONFIG = {
  apiKey: "AIzaSyDX92hWm-sBWil4VAmEm6Sn6CCNxKP0HJQ",
  authDomain: "aaron-reading-shots.firebaseapp.com",
  projectId: "aaron-reading-shots",
  storageBucket: "aaron-reading-shots.firebasestorage.app",
  messagingSenderId: "417990951680",
  appId: "1:417990951680:web:55b83a20bf742c7e4de9e5"
};
const KIDS = [{ id: 'aaron', name: 'Aaron', emoji: '🏀' }];
const LS_FAM = 'rs-fam', LS_KID = 'rs-kid';

function lsGet(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
function lsSet(k, v){ try { localStorage.setItem(k, v); } catch(e){} }

// family code: from #f=... in the link (then remembered), else from storage
function familyCode(){
  const m = ((location.hash || '') + '&' + (location.search || '')).match(/f=([A-Za-z0-9_-]{24,})/);
  if (m){ lsSet(LS_FAM, m[1]); try { history.replaceState(null, '', location.pathname); } catch(e){} return m[1]; }
  return lsGet(LS_FAM);
}

function overlay(html){
  let o = document.getElementById('kidPick');
  if (!o){ o = document.createElement('div'); o.id = 'kidPick';
    o.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#FAF9F6;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.2em;font-family:inherit;padding:2em;text-align:center';
    document.body.appendChild(o); }
  o.innerHTML = html; return o;
}

function pickKid(){
  return new Promise(res => {
    const saved = lsGet(LS_KID);
    if (saved && KIDS.some(k => k.id === saved)) return res(saved);
    if (KIDS.length === 1){ lsSet(LS_KID, KIDS[0].id); return res(KIDS[0].id); }
    const o = overlay('<div style="font-size:2em;font-weight:800">Who is playing?</div><div id="kidBtns" style="display:flex;gap:1em;flex-wrap:wrap;justify-content:center"></div>');
    KIDS.forEach(k => { const b = document.createElement('button');
      b.textContent = k.emoji + ' ' + k.name;
      b.style.cssText = 'font-size:1.8em;padding:.8em 1.4em;border-radius:18px;border:2px solid #C4922F;background:#fff;cursor:pointer';
      b.onclick = () => { lsSet(LS_KID, k.id); o.remove(); res(k.id); };
      o.querySelector('#kidBtns').appendChild(b); });
  });
}

// A Firestore write promise only resolves after the server confirms it. Offline, the write stays
// queued in the local cache and is sent automatically later; the game is told 'unavailable' after 12 s
// so its own outbox/retry UI keeps working. Re-sending the same document id later is harmless.
function withTimeout(p, ms){ return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('unavailable (queued offline)'), { code: 'unavailable' })), ms || 12000))]); }

// ---- adapter objects (artifact-runtime-like API) ----
function wrapDoc(s){ return { id: s.id, exists: s.exists(), data: () => s.data() }; }
function wrapQuery(s){ return { docs: s.docs.map(d => ({ id: d.id, data: () => d.data() })), metadata: { fromCache: s.metadata.fromCache, hasPendingWrites: s.metadata.hasPendingWrites }, size: s.size }; }

function makeDb(fs, fam, kid){
  const base = 'families/' + fam + '/kids/' + kid + '/';
  const famBase = 'families/' + fam + '/';
  const P = p => (p.startsWith('wordcache') ? famBase : base) + p;
  function coll(name, ord){
    const ref = () => ord ? query(collection(fs, P(name)), fbOrderBy(ord[0], ord[1] || 'asc')) : collection(fs, P(name));
    return {
      orderBy(f, d){ return coll(name, [f, d]); },
      onSnapshot(next, err){ return onSnapshot(ref(), { includeMetadataChanges: true }, s => next(wrapQuery(s)), e => err && err(e)); },
      // collection reads must come from the server: a cached (possibly empty) result would look like 'no records'
      async get(){ return wrapQuery(await getDocsFromServer(ref())); },
      doc(id){ return d(name + '/' + id); }
    };
  }
  function d(path){
    const ref = () => doc(fs, P(path));
    return {
      onSnapshot(next, err){ return onSnapshot(ref(), { includeMetadataChanges: true }, s => next(Object.assign(wrapDoc(s), { metadata: { fromCache: s.metadata.fromCache } })), e => err && err(e)); },
      async get(){ try { return wrapDoc(await getDocFromServer(ref())); } catch(e){ return wrapDoc(await getDoc(ref())); } },
      // resolves when the write is committed on the server; offline it stays queued in Firestore's local cache
      set(v, opt){ return withTimeout(setDoc(ref(), v, opt || {})); },
      update(v){ return withTimeout(setDoc(ref(), v, { merge: true })); },
      delete(){ return deleteDoc(ref()); }
    };
  }
  return { collection: n => coll(n), doc: p => d(p), _fs: fs, _base: base, _fam: fam, _kid: kid };
}

// ---- boot ----
let dbPromise = null;
function boot(){
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const fam = familyCode();
    if (!fam){ overlay('<div style="font-size:1.6em;font-weight:800">🔗 가족 링크로 열어 주세요</div><div style="color:#6E6E73">Open this page with the family link (bit.ly) once.</div>'); return null; }
    const app = initializeApp(CONFIG);
    let fs;
    try { fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
    catch(e){ fs = initializeFirestore(app, { localCache: memoryLocalCache() }); }
    const auth = getAuth(app);
    // auth: works offline after first sign-in (persisted). Do not block forever when offline.
    await new Promise(res => {
      let done = false; const fin = () => { if (!done){ done = true; res(); } };
      onAuthStateChanged(auth, u => { if (u) fin(); else signInAnonymously(auth).then(fin).catch(fin); });
      setTimeout(fin, 8000);
    });
    const kid = await pickKid();
    const db = makeDb(fs, fam, kid);
    window.__rsBackend = { name: 'firebase', fam: fam.slice(0, 4) + '…', kid, db };
    return db;
  })();
  return dbPromise;
}

window.claude = {
  use: async name => {
    if (name === 'db') return boot();
    if (name === 'user') return { isOwner: async () => true, can: async () => true };
    return null; // 'sample' (AI word lookup) is not available outside claude.ai
  }
};

// switch child (parent use): call window.rsSwitchKid()
window.rsSwitchKid = () => { try { localStorage.removeItem(LS_KID); } catch(e){} location.reload(); };

// app shell cache for offline start
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
