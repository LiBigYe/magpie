// Run with Node's test runner and Playwright on the module path; see README.md.
// The Routing page's loop draws only what it has to: with nothing flying it
// asks for the once-a-second frame the countdown tick arms it for (and the
// one that resumes a page whose frames were not drawn, as a covered window's
// are not), not the sixty a second it asked for while the window was open;
// a live request wakes it into a flight, and while that request is still out
// at an account it is back to the tick's alone. It used to ask for every
// frame of every hour, JS heap flat while the renderer's private bytes
// climbed. The count is of the loop's own frame, as in
// routing-idle-frame.test.cjs.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");
const engines = process.env.BROWSER ? [process.env.BROWSER] : ["webkit"];

const assets = path.resolve(__dirname, "../assets");
const iso = (ms) => new Date(ms).toISOString();
const acct = (n) => ({ id: `acct-${n}`, provider: `prov${n}`, name: `Provider ${n}`, who: `user${n}@example.com`, kind: "account", model: `model-${n}`, known: true, used: 10 * n, plan: "Pro" });

// a request as the trace carries it: done, or still out at the account
function req(id, done = true) {
  const t0 = Date.now() - 500;
  const order = [acct(id % 3), acct((id + 1) % 3)];
  const tries = order.slice(0, 1).map((w) => ({ id: w.id, model: w.model, start: iso(t0), done, ms: done ? 300 : 0, status: done ? 200 : 0 }));
  return { id, seq: id, time: iso(t0), agent: "codex", model: order[0].model, provider: order[0].provider, order, tries, done, status: done ? 200 : 0, ms: 400, tokens: 900 };
}

function serve(ctl) {
  const state = { agents: [{ id: "codex", name: "Codex", path: "/test/codex", fields: [] }], profiles: [], settings: { lang: ctl.lang, theme: "light" } };
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${ctl.lang}",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json(state);
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname === "/api/gateway/trace") {
      const after = Number(url.searchParams.get("after") || 0);
      if (!ctl.live.some((r) => r.seq > after) && url.searchParams.get("wait")) {
        // the gateway holds the answer until there is one, as wait=1 does
        await new Promise((res) => { ctl.waiters.push(res); setTimeout(res, 1500); });
      }
      const out = ctl.live.filter((r) => r.seq > after);
      const seq = ctl.live.length ? ctl.live[ctl.live.length - 1].seq : after;
      return json({ mine: true, now: new Date().toISOString(), seq, totals: { requests: ctl.live.length, rerouted: 0, errors: 0 }, routes: out.slice(-60) });
    }
    if (url.pathname === "/api/gateway/history") return json({ cut: false, days: [], routes: [] });
    if (url.pathname === "/api/groups") return json({ models: [], groups: [], pools: [] });
    if (url.pathname === "/api/providers") return json({ providers: [], excluded: [], gateway: { running: true, window: true, url: "http://127.0.0.1:3999" } });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await route.fulfill({ body: await fs.readFile(file), contentType });
  };
}

// counts the callbacks of the loop's own frame, whatever the minifier would
// name it: the function that asks for itself again
const init = () => {
  const raf = window.requestAnimationFrame.bind(window);
  window.__frames = 0;
  window.__seenFrame = false;
  window.__pkts = 0;
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1 && node.matches(".pkt")) window.__pkts++;
  }).observe(document, { childList: true, subtree: true });
  window.__mark = () => { window.__frames = 0; return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); };
  window.__count = (ms) => new Promise((r) => setTimeout(() => r(window.__frames), ms));
  window.requestAnimationFrame = (cb) => {
    const self = typeof cb === "function" && /requestAnimationFrame\s*\(\s*([A-Za-z_$][\w$]*)/.test(cb.toString()) && new RegExp(`\\b${RegExp.$1}\\s*\\(`).test(cb.toString());
    if (typeof cb === "function" && (cb.name === "frame" || self)) window.__seenFrame = true;
    return raf((ts) => { if (typeof cb === "function" && (cb.name === "frame" || self)) window.__frames++; cb(ts); });
  };
};

async function routingPage(t, engine, lang) {
  const ctl = { lang, live: [req(1)], waiters: [], seq: 1 };
  const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(init);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", serve(ctl));
  await page.goto("http://magpie.test/?view=routing");
  await page.locator(".rt-req").first().waitFor();
  await page.waitForFunction(() => window.__seenFrame, null, { timeout: 5000 });
  // a route the gateway has changed is a new seq, as a trace update is
  const push = async (r) => { r.seq = ++ctl.seq; ctl.live.push(r); ctl.waiters.splice(0).forEach((res) => res()); };
  return { page, ctl, push, errors };
}

for (const engine of engines) for (const lang of ["en", "zh"]) {
  test(`${engine} ${lang}: with nothing flying the loop asks for no frames, and a live request wakes it`, async (t) => {
    const { page, push, errors } = await routingPage(t, engine, lang);
    // the page is drawn, and then it rests between the tick's own frames: no
    // frame is asked for while nothing flies, nothing is captioned and no
    // flip is in progress (sixty a second before this)
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__mark());
    const quiet = await page.evaluate(() => window.__count(1200));
    assert(quiet <= 3, `${quiet} frames of the Routing loop were drawn with nothing flying`);

    // a request arrives and is still out at an account: the flight wakes the
    // loop, and the page goes quiet again while the answer is waited for
    await push(req(2, false));
    await page.waitForFunction(() => window.__pkts > 0, null, { timeout: 5000 });
    const flying = await page.evaluate(() => window.__mark().then(() => window.__count(600)));
    assert(flying > 5, `the loop must draw the flight (${flying} frames in 600ms)`);
    await page.waitForTimeout(900); // the bird lands and holds at the seat
    await page.evaluate(() => window.__mark());
    const waiting = await page.evaluate(() => window.__count(1200));
    assert(waiting <= 3, `${waiting} frames were drawn while the request waited for its answer`);

    // it answers: the reply's flight wakes the loop once more
    await push(req(2, true));
    const back = await page.evaluate(() => window.__mark().then(() => window.__count(700)));
    assert(back > 5, `the loop must draw the answer's flight (${back} frames in 700ms)`);
    assert.equal(errors.length, 0, errors.join("\n"));
  });

  test(`${engine} ${lang}: a caption shows though the loop was resting`, async (t) => {
    const { page, errors } = await routingPage(t, engine, lang);
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__mark());
    assert(await page.evaluate(() => window.__count(1200)) <= 3, "the loop must be resting before the click");
    // picking a request says why it went where it did: the caption is the
    // queue a frame shows, and no frame was asked for when it was filled
    await page.locator(".rt-req").first().click();
    const cap = page.locator(".rt-cap").first();
    await cap.waitFor({ timeout: 3000 });
    assert((await cap.textContent()).trim().length > 0, "the caption says something");
    assert.equal(errors.length, 0, errors.join("\n"));
  });
}
