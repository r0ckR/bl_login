// Sign-in page. Talks to Supabase Auth over its REST API (no library), keeps the session in localStorage, hands the
// access token to the service worker and asks it to sync the local (offline) copy of the app from the private "app"
// Storage bucket. Nothing secret lives here: the URL and the publishable key are public by design; access is enforced
// by Supabase (sign-ups off + the storage policy that only lets approved users read the bucket).
// Offline: a device that was signed in and approved before keeps using its local copy until it is online again;
// then approval is checked again and the copy is deleted if the account was locked.
const { SUPABASE_URL: URL_, SUPABASE_KEY: KEY } = window.BETTERLOADER_CONFIG ?? {};
const SESSION = "betterloader.auth", APP = "betterloader-app", AUTH = "betterloader-auth";
const $ = (id) => document.getElementById(id);
const msg = (t, ok = false) => { $("msg").textContent = t; $("msg").className = ok ? "ok" : ""; };
class Offline extends Error { }

async function auth(path, body, token) {
  let r;
  try {
    r = await fetch(`${URL_}/auth/v1/${path}`, {
      method: "POST",
      headers: { apikey: KEY, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body ?? {}),
    });
  } catch { throw new Offline("No connection."); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.msg || j.message || `Sign-in failed (${r.status})`);
  return j;
}
const store = (s) => { const v = { ...s, expires_at: Math.floor(Date.now() / 1000) + (s.expires_in ?? 3600) }; localStorage.setItem(SESSION, JSON.stringify(v)); return v; };
const load = () => { try { return JSON.parse(localStorage.getItem(SESSION) ?? "null"); } catch { return null; } };

/** A session with a fresh access token; the stored one when offline; null when signed out or refused. */
async function session() {
  const s = load();
  if (!s?.refresh_token) return null;
  if (s.expires_at - 300 > Date.now() / 1000) return s;
  try { return store(await auth("token?grant_type=refresh_token", { refresh_token: s.refresh_token })); }
  catch (e) {
    if (e instanceof Offline) return { ...s, offline: true };
    localStorage.removeItem(SESSION); return null;
  }
}

const hasLocalCopy = async () => !!(await (await caches.open(APP)).match(new URL("app/index.html", location.href).href));
const dropLocalCopy = async () => { try { await caches.delete(APP); await caches.delete(AUTH); } catch { } };

async function worker() {
  await navigator.serviceWorker.register("sw.js", { scope: "./", updateViaCache: "none" });
  return (await navigator.serviceWorker.ready).active;
}
async function giveToken(s) {
  const c = await caches.open(AUTH);
  await c.put(new Request(new URL("__token", location.href)), new Response(JSON.stringify({ token: s.access_token, url: URL_, key: KEY, verifiedAt: Date.now() })));
}
/** Asks the service worker to bring the local copy up to date. Resolves with "ok" | "denied" | "offline" | "error". */
async function sync() {
  const sw = await worker();
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => {
      if (e.data.progress != null) { $("bar").hidden = false; $("bar").value = e.data.progress; msg(`Downloading the app for offline use… ${Math.round(e.data.progress * 100)} %`, true); }
      if (e.data.status) { $("bar").hidden = true; resolve(e.data.status); }
    };
    sw.postMessage({ type: "sync" }, [ch.port2]);
  });
}

async function openApp() {
  const s = await session();
  if (!s) return show(null);
  $("open").disabled = true;
  try {
    if (s.offline || !navigator.onLine) {
      if (await hasLocalCopy()) { location.href = "app/"; return; }
      msg("You are offline and this device has no copy of the app yet. Sign in once while online."); return;
    }
    msg("Checking access…", true);
    await giveToken(s);
    const status = await sync();
    if (status === "denied") { await dropLocalCopy(); msg("Your account is not approved (anymore). Ask the administrator to approve it."); return; }
    if (status !== "ok" && !(await hasLocalCopy())) { msg(status === "offline" ? "No connection to the server. Try again." : "The app could not be downloaded. Try again."); return; }
    location.href = "app/";
  } catch (e) { msg(String(e.message ?? e)); }
  finally { $("open").disabled = false; }
}

function show(s) {
  $("login").hidden = !!s; $("signedin").hidden = !s;
  if (s) $("who").textContent = `Signed in as ${s.user?.email ?? "?"}${s.offline ? " (offline)" : ""}`;
}

$("login").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("go").disabled = true; msg("Signing in…", true);
  try {
    const s = store(await auth("token?grant_type=password", { email: $("email").value.trim(), password: $("password").value }));
    show(s); msg("");
    await openApp();
  } catch (err) { msg(err instanceof Offline ? "No connection. Signing in needs the internet once." : String(err.message ?? err)); }
  finally { $("go").disabled = false; }
});
$("open").addEventListener("click", () => void openApp());
$("out").addEventListener("click", async () => {
  const s = load();
  localStorage.removeItem(SESSION);
  await dropLocalCopy();
  if (s?.access_token) auth("logout", {}, s.access_token).catch(() => { });
  show(null); msg("Signed out. The local copy of the app was removed from this device.", true);
});

// "Install app" (Chrome/Edge): the browser offers it once the manifest and service worker are in place
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; $("install").hidden = false; });
window.addEventListener("appinstalled", () => { installPrompt = null; $("install").hidden = true; });
$("install").addEventListener("click", async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $("install").hidden = true; });

(async () => {
  if (!URL_ || !KEY || URL_.includes("YOUR-PROJECT")) { msg("config.js is not filled in (Supabase URL and key)."); return; }
  if (!("serviceWorker" in navigator)) { msg("This browser cannot run betterloader (no service workers). Use Chrome or Edge."); return; }
  worker().catch(() => { }); // installs the offline copy of this page and makes the app installable
  const q = new URLSearchParams(location.search);
  if (q.has("signout")) { $("out").click(); history.replaceState(null, "", "./"); return; }
  const s = await session();
  show(s);
  if (!s) $("login").hidden = false;
  // installed app start, coming back from the app (token check), or a bookmarked .../app/: go straight on
  if (s && (q.has("launch") || q.get("next") === "app" || q.has("expired"))) await openApp();
})();
