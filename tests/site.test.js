// Loads the real index.html in jsdom with a fake network: no request leaves this machine, nothing is submitted.
//   npm test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const JOBS = fs.readFileSync(path.join(ROOT, 'jobs.xml'), 'utf8');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'form-schema.json'), 'utf8')).questions;
const ENDPOINT = /script\.google\.com\/macros\/s\//;
const FORM_POST = /formResponse$/;

const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await tick(); }
  return false;
}

// backend(body) returns: an object (JSON answer), 'hang', 'throw' or 'html'. status: object, 404, 'bad', 'throw', 'hang'.
function page({search = '', status = {accepting: true}, backend = () => ({ok: true, receipt: 'X', v: 2}), timeouts} = {}) {
  const calls = [];
  const fetch = (url, opts = {}) => {
    url = String(url);
    const call = {url, opts, body: typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body};
    calls.push(call);
    const hang = () => new Promise((res, rej) => opts.signal && opts.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    if (url.startsWith('status.json')) {
      if (status === 'throw') return Promise.reject(new TypeError('network'));
      if (status === 'hang') return hang();
      if (status === 404) return Promise.resolve({ok: false, status: 404, json: () => Promise.reject(new Error('no'))});
      if (status === 'bad') return Promise.resolve({ok: true, status: 200, json: () => Promise.reject(new SyntaxError('bad json'))});
      return Promise.resolve({ok: true, status: 200, json: () => Promise.resolve(status)});
    }
    if (ENDPOINT.test(url)) {
      const a = backend(call.body);
      if (a === 'hang') return hang();
      if (a === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
      if (a === 'html') return Promise.resolve({ok: true, status: 200, json: () => Promise.reject(new SyntaxError('<html>'))});
      return Promise.resolve({ok: true, status: 200, json: () => Promise.resolve(a)});
    }
    if (FORM_POST.test(url)) return Promise.resolve({type: 'opaque', ok: false, status: 0});   // no-cors hides a 403 too
    return Promise.reject(new Error('unexpected fetch ' + url));
  };
  const dom = new JSDOM(HTML, {
    url: 'https://labasecareers.com/' + search, runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = fetch;
      w.HTMLElement.prototype.scrollIntoView = () => {};
      // Browsers let form.role reach the control named "role" (LegacyOverrideBuiltIns); jsdom does not.
      for (const k of ['name', 'phone', 'email', 'city', 'role', 'exp', 'start', 'notes', 'resume', 'source']) {
        Object.defineProperty(w.HTMLFormElement.prototype, k, {configurable: true, get() { return this.elements.namedItem(k); }});
      }
    },
  });
  const w = dom.window;
  if (timeouts && w.LB) Object.assign(w.LB.TIMEOUT, timeouts);
  const $ = (id) => w.document.getElementById(id);
  const shown = (id) => $(id).style.display === 'block' || ($(id).style.display === '' && id === 'formwrap');
  return {w, $, calls, shown, doc: w.document};
}

function fill(p, role = 'Direct Support Professional, full time') {
  const f = p.$('f');
  const set = (k, v) => { f.elements[k].value = v; };
  set('name', 'Test Person'); set('phone', '(319) 555-0100'); set('email', 'test@example.com'); set('city', 'Cedar Rapids');
  set('role', role); f.elements.role.dispatchEvent(new p.w.Event('change', {bubbles: true}));
  f.querySelector('input[name=shifts][value="Evenings"]').checked = true;
  for (const k of ['license', 'auth', 'checks']) f.querySelector(`input[name=${k}][value="Yes"]`).checked = true;
  set('exp', 'Some caregiving experience, under 2 years'); set('start', 'Right away');
  set('notes', 'Can start Monday');
}
const submit = (p) => p.$('f').dispatchEvent(new p.w.Event('submit', {cancelable: true, bubbles: true}));
const applyCalls = (p) => p.calls.filter((c) => ENDPOINT.test(c.url) && c.body && c.body.action === 'apply');
const formPosts = (p) => p.calls.filter((c) => FORM_POST.test(c.url));
const keptTyping = (p) => {
  const f = p.$('f');
  return f.elements.name.value === 'Test Person' && f.elements.email.value === 'test@example.com' && f.elements.notes.value === 'Can start Monday'
    && f.querySelector('input[name=license][value="Yes"]').checked;
};

// ---- #1: "thank you" only after the application is confirmed ----

test('#1 the old backend and a Form that silently rejects (403 behind no-cors) never show "Got it, thank you"', async () => {
  const p = page({backend: () => ({ok: false, error: 'type'})});   // exactly what the deployed v1 script answers
  fill(p); submit(p);
  assert.ok(await until(() => p.shown('thanks') || p.$('msg').textContent));
  assert.notEqual(p.$('thanks').querySelector('h2').textContent.trim(), 'Got it, thank you');
  assert.match(p.$('thanks').textContent, /could not confirm/i);
  assert.match(p.$('thanks').textContent, /\(319\) 777-8705/);
  assert.equal(formPosts(p).length, 1, 'with the old backend the page still posts the Form so nobody is lost');
});

test('#1 a confirmed application shows the thank you and its reference, once', async () => {
  const p = page({backend: (b) => (b.action === 'apply' ? {ok: true, receipt: b.appId, v: 2} : {ok: false, v: 2})});
  fill(p); submit(p);
  assert.ok(await until(() => p.shown('thanks')));
  const a = applyCalls(p);
  assert.equal(a.length, 1);
  assert.match(a[0].body.appId, /^[A-Za-z0-9]{8,32}$/);
  assert.equal(p.$('thanks').querySelector('h2').textContent.trim(), 'Got it, thank you');
  assert.match(p.$('thanks').textContent, new RegExp(a[0].body.appId));
  assert.equal(formPosts(p).length, 0, 'never a blind no-cors post when the backend can confirm');
  const fields = Object.fromEntries(a[0].body.fields);
  assert.equal(fields['entry.334748380'], 'Test Person');
  assert.equal(fields['entry.1663875271'], 'Direct Support Professional, full time');
  assert.match(fields['entry.934972207'], /^Can start Monday \| Ref: /);
});

test('#1 a rejected application shows the fallback, keeps every answer and lets the applicant send again', async () => {
  const p = page({backend: () => ({ok: false, error: 'rejected', code: 400, v: 2})});
  fill(p); submit(p);
  assert.ok(await until(() => p.$('msg').textContent));
  assert.equal(p.shown('thanks'), false);
  assert.match(p.$('msg').textContent, /did not go through/);
  assert.match(p.$('msg').innerHTML, /tel:\+13197778705/);
  assert.match(p.$('msg').innerHTML, /viewform/);
  assert.ok(keptTyping(p));
  assert.equal(p.$('go').disabled, false);
  assert.equal(formPosts(p).length, 0);
});

// Re-audit 2026-11-20 #4: the v2 backend says why a submit was not confirmed. No reason may reach the thank you.
test('#1 a v2 answer that Google did not confirm (any reason) shows Send again, never the thank you', async () => {
  for (const reason of ['form_closed', 'signin', 'form_reshown', 'not_recorded', 'redirect']) {
    const p = page({backend: () => ({ok: false, error: 'rejected', reason, code: 200, v: 2})});
    fill(p); submit(p);
    assert.ok(await until(() => p.$('msg').textContent), reason);
    assert.equal(p.shown('thanks'), false, reason);
    assert.equal(p.shown('closed'), false, reason + ': a closed Google Form is not the paused panel');
    assert.match(p.$('msg').textContent, /did not go through/, reason);
    assert.match(p.$('msg').textContent, /Send again/, reason);
    assert.ok(keptTyping(p), reason);
    assert.equal(p.$('go').disabled, false, reason);
    assert.equal(formPosts(p).length, 0, reason);
  }
});

test('#1 a network error or a non JSON answer is a failure, never a blind post', async () => {
  for (const answer of ['throw', 'html']) {
    const p = page({backend: () => answer});
    fill(p); submit(p);
    assert.ok(await until(() => p.$('msg').textContent), answer);
    assert.equal(p.shown('thanks'), false, answer);
    assert.equal(formPosts(p).length, 0, answer);
    assert.ok(keptTyping(p), answer);
  }
});

// ---- #10: bounded waits; #8: a retry reuses the application id ----

test('#10 a backend that never answers times out into the fallback, and the retry reuses the same application id', async () => {
  let n = 0;
  const p = page({backend: (b) => (n++ === 0 ? 'hang' : {ok: true, receipt: b.appId, v: 2}), timeouts: {apply: 60}});
  assert.ok(p.w.LB, 'the page exposes its tested core as LB');
  fill(p); submit(p);
  assert.ok(await until(() => p.$('msg').textContent));
  assert.equal(p.shown('thanks'), false);
  assert.ok(keptTyping(p));
  submit(p);
  assert.ok(await until(() => p.shown('thanks')));
  const a = applyCalls(p);
  assert.equal(a.length, 2);
  assert.equal(a[0].body.appId, a[1].body.appId);
});

test('#7 the backend saying closed shows the paused panel', async () => {
  const p = page({backend: () => ({ok: false, error: 'closed', v: 2})});
  fill(p); submit(p);
  assert.ok(await until(() => p.shown('closed')));
  assert.equal(p.shown('thanks'), false);
});

// ---- resume flow ----

function attach(p, bytes = '%PDF-1.7 test', name = 'cv.pdf', type = 'application/pdf') {
  const file = new p.w.File([bytes], name, {type});
  Object.defineProperty(p.$('resume'), 'files', {value: [file], configurable: true});
}

test('an office role uploads the resume first, then sends the application with the link and the same id', async () => {
  const p = page({backend: (b) => (b.action === 'upload' ? {ok: true, url: 'https://drive.google.com/file/d/abc/view', v: 2}
    : {ok: true, receipt: b.appId, v: 2})});
  fill(p, 'Case Manager'); attach(p); submit(p);
  assert.ok(await until(() => p.shown('thanks')));
  const up = p.calls.find((c) => ENDPOINT.test(c.url) && c.body.action === 'upload');
  const a = applyCalls(p)[0];
  assert.equal(up.body.appId, a.body.appId);
  assert.doesNotMatch(JSON.stringify(up.body), /555-0100/, 'the phone is not sent with the file');
  assert.match(Object.fromEntries(a.body.fields)['entry.934972207'], /Resume: https:\/\/drive\.google\.com\/file\/d\/abc\/view/);
});

test('an office role without a resume is stopped before anything is sent', async () => {
  const p = page();
  fill(p, 'Case Manager'); submit(p);
  assert.ok(await until(() => p.$('msg').textContent));
  assert.match(p.$('msg').textContent, /resume/i);
  assert.equal(p.calls.filter((c) => ENDPOINT.test(c.url)).length, 0);
});

test('a failed upload keeps the answers and sends no application', async () => {
  const p = page({backend: (b) => (b.action === 'upload' ? {ok: false, error: 'busy', v: 2} : {ok: true, receipt: 'X', v: 2})});
  fill(p, 'Case Manager'); attach(p); submit(p);
  assert.ok(await until(() => p.$('msg').textContent));
  assert.match(p.$('msg').textContent, /resume did not upload/i);
  assert.equal(applyCalls(p).length, 0);
  assert.ok(keptTyping(p));
});

// ---- #3: the switch on the page ----

test('#3 status.json closed hides the form; missing, broken, unreachable or slow keeps it (the backend enforces closed)', async () => {
  const closed = page({status: {accepting: false, closed_line: 'Paused for now.'}});
  assert.ok(await until(() => closed.shown('closed')));
  assert.equal(closed.$('closedline').textContent, 'Paused for now.');
  for (const status of [404, 'bad', 'throw', 'hang']) {
    const p = page({status, timeouts: {status: 30}});
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(p.shown('closed'), false, String(status));
    assert.notEqual(p.$('formwrap').style.display, 'none', String(status));
  }
});

// ---- #13: source attribution; #9: values the Form accepts ----

const sentSource = async (search) => {
  const p = page({search, backend: (b) => ({ok: true, receipt: b.appId, v: 2})});
  fill(p); submit(p);
  await until(() => p.shown('thanks'));
  const f = Object.fromEntries(applyCalls(p)[0].body.fields);
  return {source: f['entry.481921958'], notes: f['entry.934972207']};
};

test('#13 every ?s= link used in jobs.xml is attributed, and only Form options are ever sent as the source', async () => {
  const options = SCHEMA['481921958'].options;
  const keys = [...new Set([...JOBS.matchAll(/labasecareers\.com\/\?s=(\w+)/g)].map((m) => m[1]))];
  assert.deepEqual(keys, ['feed']);
  for (const k of keys) {
    const s = await sentSource('?s=' + k);
    assert.ok(options.includes(s.source), `${k} sent "${s.source}", not a Form option: Google would reject the row`);
    assert.ok(s.source !== 'Other' || /Came from: Job feed/.test(s.notes), `${k} recorded as Other with no trace`);
  }
  assert.equal((await sentSource('?s=fbg')).source, 'Facebook group');
  const odd = await sentSource('?s=tiktok');
  assert.equal(odd.source, 'Other');
  assert.match(odd.notes, /Link source: tiktok/);
});

test('#9 every entry id and every answer value on the page exists on the Form', () => {
  const p = page();
  const E = p.w.LB.E;
  for (const [k, id] of Object.entries(E)) assert.ok(SCHEMA[id.replace('entry.', '')], `${k} ${id} is not on the Form`);
  const f = p.$('f');
  const opts = (k) => SCHEMA[E[k].replace('entry.', '')].options;
  for (const k of ['role', 'exp', 'start']) {
    for (const o of f.elements[k].querySelectorAll('option')) if (o.value) assert.ok(opts(k).includes(o.value), `${k}: "${o.value}"`);
  }
  for (const k of ['shifts', 'certs', 'license', 'auth', 'checks']) {
    for (const i of f.querySelectorAll(`input[name=${k}]`)) assert.ok(opts(k).includes(i.value), `${k}: "${i.value}"`);
  }
  for (const s of p.w.LB.FORM_SOURCES) assert.ok(opts('source').includes(s), `source "${s}"`);
});

// ---- #15, #20, #21: the page agrees with itself ----

test('#15 every posting is on the page, in the select, in jobs.xml and in the hero line, with the same starting pay', () => {
  const p = page();
  const ld = JSON.parse(p.doc.querySelector('script[type="application/ld+json"], script[type="application/x-paused-ld+json"]').textContent);
  const titles = ld.map((j) => j.title).sort();
  const cards = [...p.doc.querySelectorAll('.role:not(.alt) h3')].map((h) => h.textContent.trim()).sort();
  const feed = [...new Set([...JOBS.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)].map((m) => m[1]))].sort();
  assert.deepEqual(cards, titles);
  assert.deepEqual(feed, titles);
  const options = [...p.$('f').elements.role.querySelectorAll('option')].map((o) => o.value);
  const hero = p.doc.querySelector('.hero p.lead').textContent.toLowerCase();
  for (const t of titles) {
    assert.ok(options.some((o) => o.startsWith(t)), `no select option for ${t}`);
    const key = t.startsWith('Overnight') ? 'overnight' : t.toLowerCase().split(' ').slice(0, 2).join(' ');
    assert.ok(hero.includes(key), `hero line misses ${t}`);
  }
  for (const j of ld.filter((x) => x.baseSalary)) {
    const card = [...p.doc.querySelectorAll('.role')].find((r) => r.querySelector('h3').textContent.trim() === j.title);
    const min = j.baseSalary.value.minValue;
    const money = Number.isInteger(min) ? `$${min}` : `$${min.toFixed(2)}`;
    assert.ok(card.querySelector('.pay').textContent.includes(money), `${j.title} card pay misses ${money}`);
  }
});

test('#20 the page never promises name and phone are enough while the form asks for more', () => {
  const p = page();
  assert.ok(p.$('f').elements.email.hasAttribute('required'));
  assert.doesNotMatch(p.doc.body.textContent, /Name and phone are enough/i);
});

test('#21 host home pay is "often tax free" everywhere it is mentioned', () => {
  const p = page();
  const text = p.doc.documentElement.innerHTML + JOBS;
  const all = [...text.matchAll(/(\w+) tax free/g)].map((m) => m[1]);
  assert.ok(all.length >= 2);
  assert.deepEqual([...new Set(all)], ['often']);
});
