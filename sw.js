// Service worker of the sign-in site.
// - Keeps the sign-in page itself available offline (network first, cached copy as fallback).
// - Serves ./app/* from a local copy of the app ("betterloader-app" cache). The copy is filled and updated by the
//   sign-in page only after Supabase confirmed that the user is approved (see sync below), and deleted on sign-out
//   or when the account is no longer approved. Offline, the last copy keeps working.
// Storage returns HTML as text/plain on purpose, so content types are set here from the file extension.
const APP = "betterloader-app", SHELL = "betterloader-shell", AUTH = "betterloader-auth";
const SHELL_FILES = ["./", "index.html", "gate.js", "config.js", "manifest.webmanifest", "favicon.svg", "favicon-32.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"];
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript", mjs: "text/javascript", css: "text/css", wasm: "application/wasm",
  json: "application/json", png: "image/png", svg: "image/svg+xml", ico: "image/x-icon", ttf: "font/ttf", woff2: "font/woff2", txt: "text/plain" };
/** Re-check approval online when the last check is older than this; offline the local copy is used regardless. */
const RECHECK_MS = 10 * 60 * 1000;

const scope = () => self.registration.scope;
const appUrl = (p) => new URL("app/" + p, scope()).href;

self.addEventListener("install", (e) => e.waitUntil((async () => {
  const c = await caches.open(SHELL);
  await Promise.all(SHELL_FILES.map((f) => c.add(new Request(new URL(f, scope()), { cache: "reload" })).catch(() => { })));
  await self.skipWaiting();
})()));
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

async function auth() {
  const r = await (await caches.open(AUTH)).match(new Request(new URL("__token", scope())));
  return r ? r.json() : null;
}
async function fromBucket(a, path) {
  return fetch(`${a.url}/storage/v1/object/authenticated/app/${path.split("/").map(encodeURIComponent).join("/")}`,
    { headers: { apikey: a.key, authorization: `Bearer ${a.token}` }, cache: "no-store" });
}
const typed = (body, path, extra = {}) => new Response(body, { status: 200, headers: { "content-type": TYPES[path.split(".").pop().toLowerCase()] ?? "application/octet-stream", ...extra } });

/** Brings the local copy in line with app/files.json. Posts progress to the page. Returns a status word. */
async function sync(port) {
  const a = await auth();
  if (!a) return "signed-out";
  let list;
  try {
    const r = await fromBucket(a, "files.json");
    if (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404) return "denied";
    if (!r.ok) return "error";
    list = await r.json();
  } catch { return "offline"; }
  const cache = await caches.open(APP);
  const want = new Map(list.files.map((f) => [appUrl(f.path), f]));
  const todo = [];
  for (const [url, f] of want) {
    const have = await cache.match(url);
    if (!have || have.headers.get("x-hash") !== f.hash) todo.push(f);
  }
  const total = todo.reduce((s, f) => s + (f.size || 1), 0);
  let done = 0;
  for (const f of todo) {
    const r = await fromBucket(a, f.path);
    if (!r.ok) return r.status === 400 || r.status === 401 || r.status === 403 ? "denied" : "error";
    await cache.put(appUrl(f.path), typed(await r.arrayBuffer(), f.path, { "x-hash": f.hash }));
    done += f.size || 1;
    port?.postMessage({ progress: total ? done / total : 1 });
  }
  for (const req of await cache.keys()) if (!want.has(req.url)) await cache.delete(req);
  return "ok";
}

self.addEventListener("message", (e) => {
  if (e.data?.type === "sync") e.waitUntil(sync(e.ports[0]).then((status) => e.ports[0]?.postMessage({ status })));
});

self.addEventListener("fetch", (e) => {
  const url = e.request.url, root = scope();
  if (e.request.method !== "GET" || !url.startsWith(root)) return;
  const appRoot = new URL("app/", root).href;

  if (url.startsWith(appRoot)) {
    e.respondWith((async () => {
      let path = new URL(url).pathname.slice(new URL(appRoot).pathname.length);
      if (path === "" || path.endsWith("/")) path += "index.html";
      if (e.request.mode === "navigate" && navigator.onLine) {
        // opened directly (bookmark, history): online, re-check approval through the sign-in page now and then
        const a = await auth();
        if (!a || Date.now() - (a.verifiedAt ?? 0) > RECHECK_MS) return Response.redirect(new URL("./?next=app", root).href, 302);
      }
      const hit = await (await caches.open(APP)).match(appUrl(path));
      if (hit) return hit;
      if (e.request.mode === "navigate") return Response.redirect(new URL("./?next=app", root).href, 302);
      // not in the local copy (should not happen after a sync): fetch it with the token
      const a = await auth();
      if (!a) return new Response("Not signed in", { status: 401 });
      try { const r = await fromBucket(a, path); return r.ok ? typed(r.body, path) : new Response(`Not available (${r.status})`, { status: r.status }); }
      catch { return new Response("Offline", { status: 503 }); }
    })());
    return;
  }

  // the sign-in page: network first so updates arrive, cached copy offline
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    try {
      const r = await fetch(e.request, { cache: "no-cache" });
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) ?? (await cache.match(new URL("./", root).href)) ?? new Response("Offline", { status: 503 });
    }
  })());
});
