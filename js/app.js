import * as db from './db.js';
import * as V from './vault.js';
import { parseCardFile, blobToAvatar, exportCardPng, toV2, isPng, normalizeCard } from './card.js';
import { buildPrompt, macros } from './prompt.js';
import { PROVIDERS, TEXT_SERVERS, diagnose, generate, listModels, generateImage, ttsAudio, listElevenVoices, embed, blobToDataUrl } from './api.js';
import { INSTRUCT_TEMPLATES, INSTRUCT_FIELDS, importInstruct, messagesToText } from './instruct.js';
import * as X from './extras.js';
import { evaluateMacros } from './macros.js';
import { normalizeBook, normalizeEntry, exportBook, POSITIONS, LOGIC } from './worldinfo.js';
import { applyRegex, parseRegexFile, normalizeScript, runScript as runRegexScript, regexFromString, PLACEMENT, PLACEMENT_LABELS } from './regex.js';
import { importSTPreset, exportSTPreset, isSTPreset, MARKER_LABELS, AUTO_SLOTS } from './preset.js';
import { formatMessage, renderInto, setThemeShadowCss, setExternalMedia } from './render.js';
import { runScript, COMMANDS } from './stscript.js';
import { DEFAULT_ENHANCE_SETTINGS, ENHANCE_TOGGLES, buildEnhancementPrompt, normalizeGeneratedText, DEFAULT_SUMMARIZE_SETTINGS } from './enhance.js';
import * as MEM from './memory.js';
import * as NDB from './narrative-db.js';
import { openZip, classify, readEntry, readText, readJson, baseName, parseStChat } from './stimport.js';
import { CHAT_STYLES, AVATAR_SHAPES, THEMES, COLOR_FIELDS, DEFAULT_APPEARANCE, paletteOf, applyAppearance, importThemeFile, exportTheme } from './theme.js';

const VERSION = '1.9.10';
const BUILD_NAME = 'PocketTavern';
const DEFAULT_MAIN = "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}. Write one reply only, in an immersive roleplay style. Stay in character. Never write {{user}}'s dialogue or actions.";

function defaultSettings() {
  const pid = db.uid();
  return {
    connections: [],
    activeConnection: null,
    preset: {
      temperature: 0.9, top_p: 1, top_k: 0, min_p: 0,
      frequency_penalty: 0, presence_penalty: 0, repetition_penalty: 1,
      max_tokens: 600, context_size: 32000, stream: true,
      claude_sampling: false, claude_effort: '', show_thoughts: false,
      stop_strings: '', stop_on_names: true, reasoning_parse: true, reasoning_prefix: '<think>', reasoning_suffix: '</think>',
    },
    prompt: {
      main: DEFAULT_MAIN, post_history: '',
      prefer_card_system: true, prefer_card_post_history: true, wi_scan_depth: 4,
      wi_budget: 25, wi_recursion: true, wi_max_recursion: 3,
    },
    personas: [{ id: pid, name: 'User', description: '', avatar: null }],
    activePersona: pid,
    ui: { enterSends: false, fontSize: 16, allowExternalMedia: false },
    instruct: { template: 'chatml', saved: [] },
    library: { sort: 'recent', favFirst: true, folders: [] },
    ext: { enhance: { ...DEFAULT_ENHANCE_SETTINGS }, summarize: { ...DEFAULT_SUMMARIZE_SETTINGS }, memory: { ...MEM.DEFAULT_MEMORY_SETTINGS }, database: { ...NDB.DEFAULT_DATABASE_SETTINGS }, ...structuredClone(X.DEFAULT_EXT) },
    appearance: structuredClone(DEFAULT_APPEARANCE),
  };
}

// ---------- state & helpers ----------
const S = {
  settings: null,
  char: null,
  chat: null,
  chats: [],
  generating: null, // chat id currently generating
  abort: null,
  editing: null, // message id being edited
  openActions: null, // message id with action row open
  draft: null, // character being edited
  models: null,
  presets: [],
  lorebooks: [],
  regex: [],
  groups: [],
  group: null, // active group (group chats)
  members: new Map(), // id -> character, for the active group
  qr: [], // quick reply sets
};

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hue = (s) => { let h = 0; for (const ch of String(s || '')) h = (h * 31 + ch.codePointAt(0)) % 360; return h; };
const isTouch = matchMedia('(pointer: coarse)').matches;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(navigator.userAgent);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  || document.referrer.startsWith('android-app://');

// Android/Chrome: keep the browser's install prompt so the home screen can offer an Install button.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (S.booted && route().name === 'home' && !document.querySelector('.sheet-wrap')) render();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  if (S.booted && route().name === 'home' && !document.querySelector('.sheet-wrap')) render();
});

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
$('#toast').addEventListener('click', () => $('#toast').classList.remove('show'));

let saveTimer;
let saveQueue = Promise.resolve();
function saveSettings(now = false) {
  clearTimeout(saveTimer);
  // Keys go into the encrypted device vault; the stored settings have none.
  // Saves run one at a time, in order, and each writes settings + vault in a
  // single transaction, so an older save can never overwrite a newer one.
  const doSave = () => {
    const job = saveQueue.then(async () => {
      S.settings.savedAt = Date.now();
      const { settings, vault, unsaved } = await V.sealSettings(S.settings);
      if (unsaved && !S.warnedNoVault) { S.warnedNoVault = true; toast('Secure storage isn\'t available here, so API keys only last until you close the app. Open PocketTavern from its https address to save them.', 8000); }
      await db.putMany('kv', vault ? [[settings, 'settings'], [vault, 'vault']] : [[settings, 'settings']]);
    });
    saveQueue = job.catch((e) => console.error('Saving settings failed', e));
    return job;
  };
  if (now) return doSave();
  saveTimer = setTimeout(doSave, 400);
}

/** Apply the appearance settings, including an imported SillyTavern theme's custom CSS. */
async function applyLook() {
  const a = S.settings.appearance;
  const t = (a.saved || []).find((x) => x.id === a.theme);
  let css = '';
  if (t && t.hasCss) {
    if (S.themeCssId !== t.id) {
      try { S.themeCss = (await db.get('kv', `themecss:${t.id}`)) || ''; } catch { S.themeCss = ''; }
      S.themeCssId = t.id;
    }
    css = S.themeCss;
  }
  const shadow = applyAppearance(a, css);
  if (shadow !== S.lastShadowCss) {
    S.lastShadowCss = shadow;
    setThemeShadowCss(shadow);
    if (route().name === 'chat' && S.chat && $('#chat')) renderMessages();
  }
}

const activeConn = () => S.settings.connections.find((c) => c.id === S.settings.activeConnection) || null;
const activePersona = () => S.settings.personas.find((p) => p.id === S.settings.activePersona) || S.settings.personas[0];
const activePreset = () => S.presets.find((p) => p.id === S.settings.activePreset) || null;

const kvTimers = {};
function saveKv(key, now = false) {
  clearTimeout(kvTimers[key]);
  const doSave = () => db.put('kv', S[key], key);
  if (now) return doSave();
  kvTimers[key] = setTimeout(doSave, 400);
}
const savePresets = (now) => saveKv('presets', now);
const saveLorebooks = (now) => saveKv('lorebooks', now);
const saveRegex = (now) => saveKv('regex', now);
const saveGroups = (now) => saveKv('groups', now);
const saveQr = (now) => saveKv('qr', now);

const cardScriptCache = new WeakMap();
function scriptsFor(char) {
  const list = [...S.regex];
  const raw = char && char.extensions && char.extensions.regex_scripts;
  if (char && char.runCardRegex !== false && Array.isArray(raw) && raw.length) {
    if (!cardScriptCache.has(raw)) {
      cardScriptCache.set(raw, raw.map((x) => { try { return normalizeScript(x); } catch { return null; } }).filter(Boolean));
    }
    list.push(...cardScriptCache.get(raw));
  }
  // Regex scripts bundled inside the active ST preset (extensions.regex_scripts).
  const pr = activePreset();
  const praw = pr && pr.raw && pr.raw.extensions && pr.raw.extensions.regex_scripts;
  if (pr && pr.runPresetRegex !== false && Array.isArray(praw) && praw.length) {
    if (!cardScriptCache.has(praw)) {
      cardScriptCache.set(praw, praw.map((x) => { try { return normalizeScript(x); } catch { return null; } }).filter(Boolean));
    }
    list.push(...cardScriptCache.get(praw));
  }
  return list;
}

const embeddedCache = new WeakMap();
function embeddedEntries(char) {
  const book = char && char.character_book;
  if (!book || !book.entries) return [];
  if (!embeddedCache.has(book)) {
    let entries = [];
    try { entries = normalizeBook(book).entries; } catch { /* ignore */ }
    embeddedCache.set(book, entries);
  }
  return embeddedCache.get(book);
}

function promptFor(chat, char, history, opts = {}) {
  const conn = activeConn();
  const inGroup = S.group && chat.groupId === S.group.id;
  const group = inGroup ? {
    names: groupMembers().map((c) => c.name).join(', '),
    nameOf: (m) => (m.role === 'user' ? (activePersona().name || 'User') : ((S.members.get(m.charId) || {}).name || m.name || char.name)),
  } : null;
  return buildPrompt({
    char, persona: activePersona(), settings: S.settings, chat, history,
    preset: activePreset(), lorebooks: S.lorebooks, regexScripts: scriptsFor(char),
    model: conn && conn.model, embeddedEntries: char._embedded || embeddedEntries(char),
    mode: opts.mode || 'normal', group, quietPrompt: opts.quietPrompt || '',
    summary: summaryFor(chat), timed: structuredClone(chat.wiTimed || {}),
    memory: memoryFor(chat), continuity: continuityFor(chat),
    narrativeDatabase: history.length >= (chat.narrativeDb?.covered || 0) ? databaseFor(chat) : null,
    vision: S.settings.ext.vision,
    recall: opts.recall ? { text: opts.recall, depth: S.settings.ext.recall.depth, template: S.settings.ext.recall.template } : null,
  });
}

// ---------- chat recall (ST "Vector Storage") ----------
/** Relevant older messages for the next reply: keyword (BM25, free) or embeddings. */
async function computeRecall(chat, history) {
  const cfg = S.settings.ext.recall;
  if (!cfg.enabled) return '';
  const msgs = history.filter((m) => !m.hidden && m.role !== 'system' && (m.swipes[m.swipeIdx] || '').trim());
  const skip = Math.max(2, Number(cfg.skipRecent) || 12);
  if (msgs.length <= skip) return '';
  const pool = msgs.slice(0, msgs.length - skip);
  const query = msgs.slice(-2).map((m) => m.swipes[m.swipeIdx]).join('\n');
  const k = Math.max(1, Number(cfg.topK) || 3);
  let picked = [];
  if (cfg.mode === 'embeddings') {
    if (!cfg.embKey) throw new Error('Chat recall: add an embeddings API key, or switch to keyword mode.');
    const need = pool.filter((m) => !(m.emb && m.emb.m === cfg.embModel && m.emb.s === m.swipeIdx));
    for (let i = 0; i < need.length; i += 64) {
      const batch = need.slice(i, i + 64);
      const vecs = await embed(cfg, batch.map((m) => m.swipes[m.swipeIdx].slice(0, 6000)));
      batch.forEach((m, j) => { m.emb = { m: cfg.embModel, s: m.swipeIdx, v: X.packVector(vecs[j]) }; });
    }
    if (need.length) saveChat(chat);
    const [qv] = await embed(cfg, [query.slice(0, 6000)]);
    picked = pool.map((m) => ({ m, score: X.cosine(qv, X.unpackVector(m.emb.v)) }))
      .filter((x) => x.score >= Math.max(0.2, Number(cfg.minScore) || 0.3)).sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.m);
  } else {
    const ranked = X.bm25(query, pool.map((m) => ({ id: m.id, text: m.swipes[m.swipeIdx] })));
    const ids = new Set(ranked.filter((x) => x.score >= (Number(cfg.minScore) || 0.25)).slice(0, k).map((x) => x.id));
    picked = pool.filter((m) => ids.has(m.id));
  }
  picked.sort((a, b) => msgs.indexOf(a) - msgs.indexOf(b));
  return picked.map((m) => `- ${memNameOf(m)}: ${m.swipes[m.swipeIdx].replace(/\s+/g, ' ').slice(0, 600)}`).join('\n');
}

// ---------- image generation (ST "Image Generation") ----------
function lastSpeaker(chat) {
  if (!S.group) return S.char;
  const l = [...chat.messages].reverse().find((m) => m.role === 'assistant' && m.charId);
  return (l && S.members.get(l.charId)) || groupMembers()[0] || S.char;
}

async function runImageGen(mode, extra = '') {
  const cfg = S.settings.ext.image;
  const chat = S.chat;
  if (S.generating) return toast('Wait for the current reply first.');
  const speaker = lastSpeaker(chat);
  const msg = { id: db.uid(), role: 'assistant', swipes: [''], swipeIdx: 0, ts: Date.now(), images: [], generated: true };
  if (S.group) { msg.charId = speaker.id; msg.name = speaker.name; }
  chat.messages.push(msg);
  S.generating = chat.id;
  S.abort = new AbortController();
  updateSendButton();
  renderMessages(true);
  try {
    let prompt = extra;
    if (mode !== 'free' || cfg.writePrompt) {
      toast('Writing the image prompt…', 20000);
      const instr = X.imagePromptInstruction(mode, extra);
      prompt = normalizeGeneratedText(await quietGenerate(instr, { maxTokens: 400, signal: S.abort.signal }));
      prompt = prompt.replace(/^(prompt|image prompt)\s*:\s*/i, '').replace(/^["']|["']$/g, '').trim();
    }
    if (!prompt) throw new Error('No image prompt was written.');
    toast('Generating image…', 60000);
    const [w, h] = X.aspectSize(cfg.aspect);
    let src = await generateImage(cfg, activeConn(), prompt, { width: w, height: h, signal: S.abort.signal });
    if (src.startsWith('data:')) src = await blobToAvatar(await (await fetch(src)).blob(), 1280);
    if (!X.isSafeImageSrc(src)) throw new Error('The image service returned something that is not an image.');
    msg.images = [src];
    msg.imagePrompt = prompt;
    toast('Image ready', 2000);
  } catch (e) {
    chat.messages.splice(chat.messages.indexOf(msg), 1);
    if (e.name !== 'AbortError') toast('Image generation: ' + (e.message || e), 8000);
  } finally {
    S.generating = null;
    S.abort = null;
    updateSendButton();
    await saveChat(chat);
    if (S.chat === chat) renderMessages(true);
  }
}

function imageSheet() {
  const cfg = S.settings.ext.image;
  const names = { char: (lastSpeaker(S.chat) || {}).name, user: activePersona().name };
  openSheet(`
    <div class="sheet-title">Generate image</div>
    <p class="hint">${esc({ openrouter: `OpenRouter · ${cfg.model}`, openai: `OpenAI-compatible · ${cfg.model}`, pollinations: 'Pollinations (free)' }[cfg.provider] || cfg.provider)} — change in Settings → Extensions.</p>
    <div class="menu-grid two">
      ${['scene', 'char', 'user'].map((m) => `<button data-action="img-gen" data-mode="${m}">${ICONS.image}<span>${esc(X.IMAGE_MODES[m].replace('{{char}}', names.char || 'character').replace('{{user}}', names.user || 'you'))}</span></button>`).join('')}
    </div>
    <label class="field"><span class="label">Or describe it</span><textarea id="img-free" rows="3" placeholder="e.g. Wade's bike parked outside the bar at night, neon rain"></textarea></label>
    <button class="btn primary block" data-action="img-gen" data-mode="free">${cfg.writePrompt ? 'Generate (the AI polishes your description)' : 'Generate'}</button>`);
}

// ---------- text to speech (ST "TTS") ----------
let speaking = null;
function stopSpeaking() {
  try { window.speechSynthesis && speechSynthesis.cancel(); } catch { /* ignore */ }
  if (S.audio) { S.audio.pause(); S.audio.removeAttribute('src'); }
  if (S.ttsAbort) S.ttsAbort.abort();
  speaking = null;
}

/** iOS (and Android Chrome) only play audio started from a tap; prime the players during the send tap. */
function unlockAudio() {
  const cfg = S.settings.ext.tts;
  if (!cfg.enabled || S.audioUnlocked) return;
  S.audioUnlocked = true;
  try {
    if (cfg.provider === 'browser' && window.speechSynthesis) speechSynthesis.speak(new SpeechSynthesisUtterance(' '));
    S.audio = S.audio || new Audio();
    S.audio.src = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    S.audio.play().then(() => S.audio.pause()).catch(() => {});
  } catch { /* ignore */ }
}

function voiceFor(msg) {
  const cfg = S.settings.ext.tts;
  if (msg.role === 'system') return cfg.narratorVoice || cfg.defaultVoice;
  const who = msg.role === 'user' ? null : speakerOf(msg);
  return (who && who.ttsVoice) || cfg.defaultVoice;
}

async function speakMessage(msg) {
  const cfg = S.settings.ext.tts;
  if (speaking === msg.id) { stopSpeaking(); renderMessages(); return; }
  stopSpeaking();
  const raw = (msg.tr && msg.tr[msg.swipeIdx] && !msg.showOriginal) ? msg.tr[msg.swipeIdx].text : msg.swipes[msg.swipeIdx];
  const text = X.speakableText(evaluateMacros(raw || '', { char: (speakerOf(msg) || S.char || {}).name, user: activePersona().name, vars: {} }), cfg);
  if (!text) return toast('Nothing to read aloud here.');
  speaking = msg.id;
  const done = () => { if (speaking === msg.id) { speaking = null; if (S.chat && S.chat.messages.includes(msg)) renderMessages(); } };
  try {
    if (cfg.provider === 'browser') {
      if (!window.speechSynthesis) throw new Error('This browser has no built-in voices.');
      const u = new SpeechSynthesisUtterance(text);
      const v = voiceFor(msg);
      const voice = v && speechSynthesis.getVoices().find((x) => x.voiceURI === v || x.name === v);
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      u.rate = Number(cfg.rate) || 1;
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    } else {
      if (!cfg.apiKey) throw new Error('Add a TTS API key in Settings → Extensions → Text-to-speech.');
      S.ttsAbort = new AbortController();
      const blob = await ttsAudio(cfg, text.slice(0, 4000), voiceFor(msg), S.ttsAbort.signal);
      if (speaking !== msg.id) return;
      S.audio = S.audio || new Audio();
      if (S.audioUrl) URL.revokeObjectURL(S.audioUrl);
      S.audioUrl = URL.createObjectURL(blob);
      S.audio.src = S.audioUrl;
      S.audio.onended = done;
      await S.audio.play();
    }
    if (S.chat && S.chat.messages.includes(msg)) renderMessages();
  } catch (e) {
    speaking = null;
    if (e.name !== 'AbortError') toast('TTS: ' + (e.message || e), 6000);
  }
}

async function voicesSheet(target) {
  const cfg = S.settings.ext.tts;
  const sheet = openSheet('<div class="sheet-title">Voices</div><p class="muted">Loading…</p>', 'tall');
  try {
    let voices;
    if (cfg.provider === 'browser') {
      voices = speechSynthesis.getVoices();
      if (!voices.length) { await new Promise((r) => { speechSynthesis.onvoiceschanged = r; setTimeout(r, 1500); }); voices = speechSynthesis.getVoices(); }
      voices = voices.map((v) => ({ id: v.voiceURI || v.name, name: `${v.name} (${v.lang})` }));
    } else if (cfg.provider === 'elevenlabs') voices = await listElevenVoices(cfg.apiKey);
    else voices = X.OPENAI_VOICES.map((v) => ({ id: v, name: v }));
    sheet.innerHTML = `<div class="sheet-title">Pick a voice</div><div class="model-list">${voices.map((v) => `<button class="model-item" data-action="pick-voice" data-target="${esc(target)}" data-id="${esc(v.id)}"><span class="mi-name">${esc(v.name)}</span></button>`).join('') || '<p class="muted">No voices found.</p>'}</div>`;
  } catch (e) {
    sheet.innerHTML = `<div class="sheet-title">Voices</div><p class="error">${esc(e.message)}</p>`;
  }
}

// ---------- translation (ST "Chat Translation") ----------
async function translateText(text, lang) {
  const cfg = S.settings.ext.translate;
  const out = await memCall(`Translate the user's message into ${lang}. Keep every bit of formatting exactly: *asterisks*, "quotes", line breaks, HTML tags, names. Do not add or remove anything. Output only the translation.`,
    text, Math.round(text.length / 2) + 400, cfg.model);
  return normalizeGeneratedText(out);
}

async function translateMessage(msg, chat = S.chat) {
  const cfg = S.settings.ext.translate;
  const idx = msg.swipeIdx;
  msg.tr = msg.tr || {};
  try {
    msg.tr[idx] = { lang: cfg.target, text: await translateText(msg.swipes[idx], cfg.target) };
    msg.showOriginal = false;
    await saveChat(chat);
    if (S.chat === chat) renderMessages();
  } catch (e) { toast('Translation: ' + (e.message || e), 6000); }
}

// ---------- character expressions (ST "Character Expressions") ----------
const spriteCache = new Map();
async function spritesOf(charId) {
  if (!charId) return {};
  if (!spriteCache.has(charId)) {
    let v = {};
    try { v = (await db.get('kv', `sprites:${charId}`)) || {}; } catch { /* none */ }
    spriteCache.set(charId, v);
  }
  return spriteCache.get(charId);
}
async function saveSprites(charId, sprites) {
  spriteCache.set(charId, sprites);
  await db.put('kv', sprites, `sprites:${charId}`);
}

/** Keeps transparency (unlike avatars, which become JPEG). */
async function blobToPng(blob, max = 768) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Not an image')); i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}

async function classifyExpression(chat, msg) {
  const cfg = S.settings.ext.expressions;
  const who = speakerOf(msg);
  if (!cfg.enabled || !who || !who.id) return;
  const sprites = await spritesOf(who.id);
  const labels = Object.keys(sprites);
  if (labels.length < 2) return;
  try {
    const out = await memCall(`You label emotions. Read the roleplay message and answer with exactly one word from this list, the emotion ${who.name} shows most: ${labels.join(', ')}.`,
      String(msg.swipes[msg.swipeIdx] || '').slice(-3000), 20, cfg.model);
    msg.expr = X.pickExpression(out, labels);
    await saveChat(chat);
    if (S.chat === chat) updateExpressionPanel();
  } catch (e) { console.warn('expression', e); }
}

async function updateExpressionPanel() {
  const panel = $('#expr-panel');
  if (!panel) return;
  const cfg = S.settings.ext.expressions;
  const last = S.chat && [...S.chat.messages].reverse().find((m) => m.role === 'assistant' && !m.generated);
  const who = last ? speakerOf(last) : (S.group ? groupMembers()[0] : S.char);
  const sprites = cfg.enabled && who ? await spritesOf(who.id) : {};
  const label = (last && last.expr && sprites[last.expr]) ? last.expr : (sprites.neutral ? 'neutral' : Object.keys(sprites)[0]);
  const src = label && sprites[label];
  if (!src || !X.isSafeImageSrc(src)) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.classList.toggle('collapsed', !!cfg.collapsed);
  panel.innerHTML = `<img src="${esc(src)}" alt="${esc(label)}"><span class="expr-label">${esc(who.name)} · ${esc(label)}</span>`;
}

// ---------- long-term memory (Summaryception-style) ----------
function databaseFor(chat) {
  const cfg = S.settings.ext.database;
  const state = chat.narrativeDb;
  if (!cfg.enabled || !state || !state.text || NDB.isStale(chat.messages, state)) return null;
  return { text: state.text, position: cfg.position, depth: cfg.depth, role: cfg.role, template: cfg.template, covered: state.covered, recentTokens: cfg.recentTokens };
}

function memoryFor(chat) {
  const cfg = S.settings.ext.memory;
  const text = MEM.assembleMemory(chat.mem);
  if (S.settings.ext.database.enabled || !S.settings.ext.memory.enabled || !text) return null;
  return { text, position: cfg.enabled ? cfg.position : 'macro', depth: cfg.depth, role: cfg.role, template: cfg.template };
}

/** Newest audited checkpoint for the visible swipes, and how many replies it lags behind. */
function liveContinuity(chat) {
  let stale = 0;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m.role !== 'assistant') continue;
    if (m.audit && m.audit.swipe === m.swipeIdx) return { msg: m, state: m.audit.state, stale };
    stale++;
  }
  return null;
}

function continuityFor(chat) {
  const cfg = S.settings.ext.memory;
  if (!cfg.enabled || S.settings.ext.database.enabled || !cfg.auditor || chat.groupId) return '';
  const live = liveContinuity(chat);
  return live ? MEM.renderContinuity(live.state, live.stale) : '';
}

const unescapeStop = (s) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

const connReady = (conn) => !!conn && (!!conn.model || (PROVIDERS[conn.provider] || {}).kind === 'text');
const isTextConn = (conn = activeConn()) => !!conn && (PROVIDERS[conn.provider] || {}).kind === 'text';
function currentInstruct() {
  const ins = S.settings.instruct;
  return (ins.saved || []).find((t) => t.id === ins.template) || INSTRUCT_TEMPLATES[ins.template] || INSTRUCT_TEMPLATES.chatml;
}
/** For text-completion backends: turn chat messages into one prompt using the instruct template. */
function textFormatter(kind, speaker) {
  const mode = { reply: 'reply', continue: 'continue', impersonate: 'impersonate' }[kind] || 'quiet';
  return (messages) => messagesToText(messages, currentInstruct(), {
    char: (speaker || S.char || {}).name, user: activePersona().name || 'User', mode, group: !!S.group,
  });
}

/** Stopping strings and <think> parsing for a request. kind: reply | continue | impersonate | quiet */
function genOptions(kind, speaker) {
  const p = S.settings.preset;
  const user = activePersona().name || 'User';
  const env = { char: (speaker || S.char || {}).name, user, vars: { ...((S.chat && S.chat.vars) || {}) } };
  const custom = String(p.stop_strings || '').split('\n').map((x) => x.replace(/\r$/, '')).filter((x) => x.trim()).map((x) => evaluateMacros(unescapeStop(x), env));
  const names = [];
  if (p.stop_on_names !== false && kind !== 'quiet') {
    if (kind === 'impersonate') {
      if (speaker) names.push(`\n${speaker.name}:`);
      groupMembers().forEach((c) => names.push(`\n${c.name}:`));
    } else {
      names.push(`\n${user}:`);
      groupMembers().filter((c) => !speaker || c.id !== speaker.id).forEach((c) => names.push(`\n${c.name}:`));
    }
  }
  const think = p.reasoning_parse !== false ? { prefix: p.reasoning_prefix || '<think>', suffix: p.reasoning_suffix || '</think>' } : null;
  return { stop: [...new Set([...custom, ...names])], think, textFormat: isTextConn() ? textFormatter(kind, speaker) : null };
}

const connFor = (model) => { const c = activeConn(); return c && model ? { ...c, model } : c; };
const memNameOf = (m) => (m.role === 'user' ? (activePersona().name || 'User') : m.role === 'system' ? 'Narrator' : ((speakerOf(m) || S.char || {}).name || m.name || 'Character'));

async function memCall(system, user, maxTokens, model) {
  const conn = connFor(model);
  if (!connReady(conn)) throw new Error('No API connection.');
  const preset = { ...S.settings.preset, stream: false, max_tokens: maxTokens };
  return generate(conn, preset, [{ role: 'system', content: system }, { role: 'user', content: user }], { textFormat: isTextConn(conn) ? textFormatter('quiet') : null });
}

/** Compress old chat into Layer 0 memories, then merge crowded layers. mode: auto | force | slop */
async function runMemory(chat, mode = 'auto') {
  const cfg = S.settings.ext.memory;
  if ((!cfg.enabled && mode === 'auto') || S.memBusy) return;
  const chunks = MEM.planChunks(chat.messages, cfg, mode);
  const needsMerge = () => chat.mem && MEM.nextPromotion(chat.mem.layers, cfg);
  if (!chunks.length && !needsMerge()) { if (mode !== 'auto') toast('Nothing old enough to summarize yet.'); return; }
  S.memBusy = true;
  const env = { char: (S.char || {}).name, user: activePersona().name || 'User', vars: {} };
  const fill = (t) => evaluateMacros(String(t).replace(/\{\{target\}\}/gi, String(cfg.target || 280)), env);
  if (mode !== 'auto') toast(`Summarizing ${chunks.length} part${chunks.length === 1 ? '' : 's'}…`, 30000);
  try {
    chat.mem = chat.mem || { layers: [[]] };
    for (const chunk of chunks) {
      const recent = (chat.mem.layers[0] || []).slice(-3).map((x) => x.text).join('\n\n');
      const user = `${recent ? `<earlier_memories>\n${recent}\n</earlier_memories>\n\n` : ''}<passage>\n${MEM.passageText(chunk, memNameOf)}\n</passage>`;
      const text = MEM.extractNarrative(await memCall(fill(cfg.l0Prompt), user, Math.round((cfg.target || 280) * 3) + 300, cfg.model));
      if (!text) throw new Error('The summarizer returned nothing.');
      chunk.forEach((m) => { m.ghost = 'mem'; });
      chat.mem.layers[0].push({ text, from: chunk[0].id, to: chunk[chunk.length - 1].id, at: Date.now() });
      await saveChat(chat);
      if (S.chat === chat) renderMessages();
    }
    for (let guard = 0; guard < 8; guard++) {
      const plan = MEM.nextPromotion(chat.mem.layers, cfg);
      if (!plan) break;
      const items = chat.mem.layers[plan.layer].slice(0, plan.count);
      const user = items.map((x, i) => `<memory n="${i + 1}">\n${x.text}\n</memory>`).join('\n');
      const text = MEM.extractNarrative(await memCall(fill(cfg.mergePrompt), user, Math.round((cfg.target || 280) * 4) + 300, cfg.model));
      if (!text) break;
      chat.mem.layers[plan.layer].splice(0, plan.count);
      (chat.mem.layers[plan.layer + 1] = chat.mem.layers[plan.layer + 1] || []).push({ text, from: items[0].from, to: items[items.length - 1].to, at: Date.now() });
      await saveChat(chat);
    }
    if (mode !== 'auto') toast('Memory updated', 2500);
  } catch (e) {
    toast('Memory: ' + (e.message || e), 6000);
  } finally {
    S.memBusy = false;
    if ($('#mem-sheet')) memorySheet();
  }
}

function clearMemory(chat) {
  chat.messages.forEach((m) => { if (m.ghost === 'mem') delete m.ghost; });
  chat.mem = null;
  saveChat(chat);
  if (S.chat === chat) renderMessages();
}

/** Continuity Auditor: after each reply in a 1:1 chat, update the live scene/bond/agenda state. */
async function runAuditor(chat, msg) {
  const cfg = S.settings.ext.memory;
  if (!cfg.enabled || !cfg.auditor || chat.groupId || msg.role !== 'assistant') return;
  const idx = chat.messages.indexOf(msg);
  const prior = (() => { for (let i = idx - 1; i >= 0; i--) { const m = chat.messages[i]; if (m.role === 'assistant' && m.audit && m.audit.swipe === m.swipeIdx) return m.audit.state; } return null; })();
  const lastUser = [...chat.messages.slice(0, idx)].reverse().find((m) => m.role === 'user');
  const exchange = [lastUser, msg].filter(Boolean).map((m) => `${memNameOf(m)}: ${m.swipes[m.swipeIdx]}`).join('\n\n');
  const priorView = prior ? { bonds: Object.keys(prior.bonds || {}), agendas: prior.agendas, gm_notes: prior.notes, physics: prior.physics } : {};
  const swipe = msg.swipeIdx;
  try {
    const out = await memCall(evaluateMacros(cfg.auditorPrompt, { char: S.char.name, user: activePersona().name || 'User', vars: {} }),
      `<prior_continuity_state>\n${JSON.stringify(priorView, null, 1)}\n</prior_continuity_state>\n\n<latest_exchange>\n${exchange}\n</latest_exchange>`, 1500, cfg.auditorModel || cfg.model);
    if (msg.swipeIdx !== swipe) return; // user swiped meanwhile
    msg.audit = { swipe, state: MEM.nextContinuityState(prior, out) };
    await saveChat(chat);
    if (S.chat === chat) renderMessages();
  } catch (e) {
    console.warn('Auditor failed', e);
    toast('Continuity auditor: ' + (e.message || e), 5000);
  }
}

// ---------- Narrative Database: independent cumulative summarization ----------
function databaseDuration(seconds) {
  const n = Math.max(0, Math.round(seconds));
  if (n < 60) return n + 's';
  if (n < 3600) return Math.floor(n / 60) + 'm ' + (n % 60) + 's';
  return Math.floor(n / 3600) + 'h ' + Math.floor(n % 3600 / 60) + 'm';
}
function databaseEstimate(progress) {
  if (!progress || !progress.timings?.length) return '';
  const average = progress.timings.reduce((sum, n) => sum + n, 0) / progress.timings.length;
  const left = Math.max(0, progress.total - progress.done);
  return left ? ' · ~' + databaseDuration(average * left) + ' remaining (rough estimate)' : '';
}

function databaseProgressHtml(progress) {
  const total = Math.max(1, progress.total);
  const done = Math.min(total, Math.max(0, progress.done));
  const percent = Math.round(done / total * 100);
  const currentBatch = Math.min(done + 1, total);
  return `
    <div class="ndb-progress-head">
      <span>📚 Narrative Database: ${esc(progress.message.toLowerCase())}…</span>
      <span class="ndb-current-batch">Batch ${currentBatch} of ${total} · processing</span>
    </div>
    <div class="ndb-progress-track" role="progressbar" aria-label="Narrative Database batches completed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
      <div class="ndb-progress-fill" style="width:${percent}%"></div>
    </div>
    <div class="ndb-progress-foot">
      <span>${done} / ${total} complete · ${percent}%</span>
      <span>${progress.lastSeconds != null ? 'Last batch: ' + databaseDuration(progress.lastSeconds) : 'This might take a while…'}${databaseEstimate(progress)}</span>
    </div>`;
}
function databaseFailureHtml(chat) {
  if (!chat?.narrativeDbLastError) return '';
  const covered = chat.narrativeDbPending?.covered || 0;
  const batchLabel = chat.narrativeDbErrorBatch ? ' · Failed at batch ' + chat.narrativeDbErrorBatch : '';
  return `<div class="ndb-error-title">⚠ Narrative Database stopped${batchLabel}</div>
    <div class="ndb-error-message">${esc(chat.narrativeDbLastError)}</div>
    <div class="ndb-error-meta">${covered ? covered + ' messages saved in a partial rebuild. Resume from that checkpoint.' : 'No partial rebuild checkpoint saved yet. Retry from the beginning.'}</div>
    <div class="row wrap"><button class="btn sm" data-action="qa-database">Open database manager</button>
      <button class="btn sm" data-action="ndb-dismiss-error">Dismiss error</button></div>`;
}
function updateDatabaseBanner() {
  const progress = S.dbProgress && S.chat && S.dbProgress.chatId === S.chat.id ? S.dbProgress : null;
  const errorHtml = !progress && S.chat ? databaseFailureHtml(S.chat) : '';
  for (const id of ['ndb-running-banner', 'ndb-settings-progress', 'ndb-sheet-progress']) {
    const el = $('#' + id);
    if (!el) continue;
    el.hidden = !progress && !errorHtml;
    el.classList.toggle('ndb-error', !progress && !!errorHtml);
    if (progress) el.innerHTML = databaseProgressHtml(progress);
    else if (errorHtml) el.innerHTML = errorHtml;
    else el.replaceChildren();
  }
}
async function openDatabaseManager() {
  // Settings can be opened before any chat has been loaded this session.
  if (S.chat) return databaseSheet();
  const chats = (await db.getAll('chats')).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!chats.length) return toast('Open a chat first to manage its Narrative Database.', 5000);
  openSheet(`
    <div class="sheet-title">Choose a chat to manage</div>
    <p class="hint">Narrative Databases are saved per chat. Select one to open its manager.</p>
    <div class="chat-list">
      ${chats.map((c) => `<button class="btn block" data-action="ndb-select-chat" data-id="${esc(c.id)}">${esc(c.title || 'Untitled chat')}</button>`).join('')}
    </div>
  `, 'tall');
}
function databaseSheet() {
  const chat = S.chat;
  const cfg = S.settings.ext.database;
  const dbState = chat.narrativeDb;
  const stale = NDB.isStale(chat.messages, dbState);
  const pending = NDB.pendingTokens(chat.messages, dbState?.covered || 0);
  const prog = S.dbProgress && S.dbProgress.chatId === chat.id ? S.dbProgress : null;
  const resumable = chat.narrativeDbPending && chat.narrativeDbPending.covered > 0 && !NDB.isStale(chat.messages, chat.narrativeDbPending);
  const rebuildStart = resumable ? chat.narrativeDbPending.covered : 0;
  const rebuildBatches = NDB.countBatches(chat.messages, rebuildStart, cfg.batchTokens);
  openSheet(`
    <div class="sheet-title" id="ndb-sheet">Narrative Database ${prog ? '<span class="muted small">· processing…</span>' : ''}</div>
    <p class="hint">Independent of Summarize and Summaryception. Processes the original chat chronologically; the chat is never forked or deleted.</p>
    <div class="mem-stats">
      <div><b>${dbState?.covered || 0} / ${chat.messages.length}</b> messages covered</div>
      <div><b>≈${Math.round(pending / 1000)}k</b> pending tokens</div>
      <div><b>${(dbState?.checkpoints || []).length}</b> checkpoints</div>
    </div>
    <div id="ndb-sheet-progress" class="ndb-running-banner" hidden></div>
    <div class="row wrap">
      ${resumable ? `<button class="btn primary" data-action="ndb-resume" ${prog ? 'disabled' : ''}>▶ Resume partial rebuild</button>` : chat.narrativeDbLastError ? `<button class="btn primary" data-action="ndb-retry" ${prog ? 'disabled' : ''}>↻ Retry failed rebuild</button>` : ''}
      <button class="btn primary" data-action="ndb-update" ${prog || stale ? 'disabled' : ''}>Update from Last Checkpoint</button>
      <button class="btn" data-action="ndb-rebuild" ${prog ? 'disabled' : ''}>${resumable ? 'Restart rebuild from beginning' : 'Rebuild from Chat History'}</button>
      ${prog ? '<button class="btn" data-action="ndb-cancel">Cancel after current batch</button>' : ''}
      <button class="btn danger" data-action="ndb-clear" ${prog ? 'disabled' : ''}>Clear Database</button>
    </div>
    <p class="hint">Full rebuild: approximately ${rebuildBatches} sequential model calls at the current batch size (${Math.round(cfg.batchTokens).toLocaleString()} estimated tokens). ${rebuildStart ? 'Valid partial rebuild detected; estimate covers remaining messages. ' : ''}Timing estimate appears after the first successful batch; later batches may take longer as the database grows. API costs may apply.</p>
    ${stale ? '<p class="hint" style="color:var(--danger,#e66)">⚠ Earlier messages were edited, deleted or reordered. Database is stale. Use Rebuild from Chat History.</p>' : ''}
    ${prog ? `<p class="hint">${esc(prog.message)} (${prog.done}/${prog.total} batches).${prog.lastSeconds != null ? ` Last batch: ${databaseDuration(prog.lastSeconds)}.${databaseEstimate(prog)}` : ''} This might take a while… Progress is saved after each successful batch.</p>` : ''}
    ${resumable ? `<p class="hint">Saved partial rebuild: ${chat.narrativeDbPending.covered} / ${chat.messages.length} messages processed. Resume continues from that checkpoint without repeating completed batches.</p>` : chat.narrativeDbPending ? '<p class="hint">A saved partial rebuild no longer matches this chat and cannot be resumed; start a fresh rebuild.</p>' : ''}
    ${chat.narrativeDbLastError && !prog && !resumable ? `<p class="hint">The failed batch can be retried from the beginning without deleting your current active database.</p>` : ''}
    <div class="row wrap">
      <button class="btn" data-action="ndb-export">Export Database</button>
      <button class="btn" data-action="ndb-import">Import Database</button>
    </div>
    <label class="field"><span class="label">Current database (editable)</span><textarea id="ndb-text" rows="19" spellcheck="false" placeholder="No database yet. Run Catch Up / Rebuild from Chat History.">${esc(dbState?.text || '')}</textarea></label>
    <button class="btn" data-action="ndb-save" ${prog ? 'disabled' : ''}>Save Manual Corrections</button>
    <p class="hint">Manual corrections become the input to the next update. Rebuild retains the active database until every batch succeeds.</p>
  `, 'tall');
  updateDatabaseBanner();
}

async function runDatabase(chat, { rebuild = false, flush = false, silent = false, restart = false } = {}) {
  const cfg = S.settings.ext.database;
  if (S.dbBusy || (!cfg.enabled && silent)) return;
  if (!chat || !chat.messages.length) { if (!silent) toast('No chat messages to process.'); return; }
  const old = chat.narrativeDb || null;
  if (!rebuild && NDB.isStale(chat.messages, old)) {
    if (!silent) toast('Database is stale. Rebuild from Chat History.', 5500);
    return;
  }
  const start = rebuild ? 0 : (old?.covered || 0);
  if (!NDB.nextBatch(chat.messages, start, cfg.batchTokens, flush || rebuild)) {
    if (!silent) toast('Not enough new messages for the next update.');
    return;
  }
  S.dbBusy = true;
  S.dbCancel = false;
  // Staging data is independent of active data: a failed rebuild never destroys it.
  // A paused rebuild can resume without re-paying for all earlier successful batches.
  const pendingRebuild = rebuild && !restart && chat.narrativeDbPending && chat.narrativeDbPending.covered > 0 && !NDB.isStale(chat.messages, chat.narrativeDbPending)
    ? chat.narrativeDbPending : null;
  if (rebuild && restart) { delete chat.narrativeDbPending; await saveChat(chat); }
  const working = rebuild ? structuredClone(pendingRebuild || { text: '', covered: 0, checkpoints: [] }) : {
    text: old?.text || '', covered: start, checkpoints: [...(old?.checkpoints || [])],
  };
  const estimatedTotal = Math.max(1, NDB.countBatches(chat.messages, working.covered, cfg.batchTokens));
  S.dbProgress = { chatId: chat.id, done: 0, total: estimatedTotal, timings: [], message: rebuild ? 'Rebuilding' : 'Updating' };
  updateDatabaseBanner();
  if (!silent) { toast('Narrative Database: processing… This might take a while…', 5000); if ($('#ndb-sheet')) databaseSheet(); }
  let succeeded = false;
  try {
    while (!S.dbCancel) {
      const batch = NDB.nextBatch(chat.messages, working.covered, cfg.batchTokens, flush || rebuild);
      if (!batch) { succeeded = true; break; }
      // Per-call retention filter: the 0.14 default system prompt stays intact.
      // Apply this to inherited memory too, so trivia does not accumulate.
      const input = NDB.buildUpdateInput(working.text, batch, memNameOf) + `
<retention_filter>
Treat this database as LONG-TERM STORY MEMORY, not a transcript or scene inventory.
Before returning the FULL database, audit BOTH the inherited text and new material:
- KEEP lasting changes to relationships, characterization, trust, trauma, knowledge, secrets, consequential choices, timeline-specific history, world mechanics, open mysteries, promises, and real deadlines.
- KEEP an ordinary action only for its lasting meaning. Example: Jason notices Catrin's malnourishment and carefully paces her food because of his own childhood experience. Do NOT preserve pastrami, sandwich placement, which bite was fed, foil, stove, or kitchen choreography.
- KEEP a confession or change in intimacy; omit step-by-step kissing, sex, clothing, gestures, and other physical choreography unless a specific detail has an established lasting consequence.
- KEEP a location, object, time, code, or precise number ONLY when it affects future decisions, access, a deadline, an unresolved plot, or a meaningful outcome. Remove expired logistics, minor inventory, ordinary meals, and decorative measurements.
- ACTIVE THEATRE may briefly orient the immediate next scene; when the scene advances, retire its incidental details. The CHRONICLE must preserve outcomes, not every beat. DOSSIERS should describe what characters carry forward, not list props.
- Do NOT erase or weaken the only record of a consequential fact to achieve brevity. Preserve separate timelines, unknown fates, who knows what, and task deadlines accurately.
- Do NOT preserve trivia merely because it appears in the previous database. Consolidate duplicate important facts into their proper sections.
- CHRONICLE SELECTION TEST: For every proposed historical entry ask, "Would losing this event change a future character decision, relationship, causal explanation, mystery, or timeline?" If not, delete it. A routine morning, shower, meal, bedroom movement, wake-up, or interruption does not earn a dated entry. Merge multiple beats of the same consequential conversation into one outcome-focused entry. Do not retain a numbered scene-by-scene account simply because earlier checkpoints did.
- CHRONICLE DENSITY: Prefer a few compact, meaningful event clusters per arc rather than one entry per message or timestamp. Dates and exact times belong only where timing changes causality or a deadline. Preserve high-impact history even when old; do not impose an arbitrary entry limit or erase distinct timeline branches.
- DOSSIER/WEB FILTER: Keep relationship status, changed trust, significant revelations, persistent health needs, and character-specific motives when established. Do not keep food brands, exact bites, calzone anecdotes, fabric names, bite marks, temporary outfits, incidental touch, decorative room descriptions, or exact tub/TV dimensions. A childhood experience can explain careful feeding without recording what food was involved.
- GEOGRAPHY/ITEM FILTER: Keep access routes, security constraints, passcodes, operative devices and evidence when they matter. Remove apartment furnishings, decorative architecture, and inventories with no ongoing consequence. The availability of a private comfortable suite matters; its bathtub dimensions do not.
- TIME AUDIT: Before assigning "overdue", "expired", "completed", or "missed", compare the task's stated deadline to the latest established scene date AND time, accounting for time zones. If the scene is ~noon Oct 14 and a transport is scheduled for 14:00 Oct 14, that transport is UPCOMING and unaddressed, NOT overdue. If timing is unclear, say "pending, time unverified" rather than inventing passage of time. Keep 18:00 transponder spoof, noon Oct 15 cover, and 14:00 transport distinct; never attach one deadline to another.
- MYSTERY AUDIT: Include only explicitly raised or inherited genuinely unresolved questions. Do not manufacture ambiguities by treating two explicitly separate timeline branches as potentially the same. If a timeline distinction is established, retain it without inventing a reconciliation question.
- FINAL SELF-CHECK: Re-read the entire output for scene-by-scene trivia, duplicate facts, timeline conflation, and premature deadline status. Cut the trivia and correct statuses before returning the FULL database; never replace the output with a patch.
</retention_filter>`;
      const system = evaluateMacros(cfg.prompt, { char: S.char?.name || '', user: activePersona().name || 'User', vars: {} });
      const priorSignature = NDB.fingerprint(chat.messages, batch.end);
      const batchStartedAt = Date.now();
      let result;
      try {
        // Retry a malformed replacement once without advancing the checkpoint.
        // Keep the saved 0.14 system prompt untouched; only annotate this call.
        const validate = raw => NDB.checkedDatabase(raw);
        try {
          result = validate(await memCall(system, input, Math.max(1024, Number(cfg.maxOutputTokens) || 12000), cfg.model));
        } catch (validationError) {
          const repairInput = input + '\n\n<database_repair>\nThe previous replacement was rejected: ' + String(validationError.message || validationError).slice(0, 500) + '\nReturn a FULL standalone database with every required section. Replace shorthand such as "unchanged", "no change; see Chronicle", and "same as before" with concrete facts from the previous database. Do not omit prior facts merely because they were not mentioned in the new messages.\n</database_repair>';
          result = validate(await memCall(system, repairInput, Math.max(1024, Number(cfg.maxOutputTokens) || 12000), cfg.model));
        }
        // Continuity heuristics are advisory: headings, deadlines and task
        // wording may change legitimately. Request one repair, but never
        // reject a structurally valid checkpoint solely on heuristic flags.
        const continuity = NDB.continuityWarnings(working.text, result, batch.messages);
        if (continuity.length) {
          const retryInput = input + '\n\n<continuity_review>\nPlease verify these possible omissions against the original messages and previous database. Preserve the facts if still true; record completions, changes, and uncertainty accurately. Return the FULL corrected database, not a patch:\n- ' + continuity.join('\n- ') + '\n</continuity_review>';
          try {
            const repaired = validate(await memCall(system, retryInput, Math.max(1024, Number(cfg.maxOutputTokens) || 12000), cfg.model));
            result = repaired;
          } catch (reviewError) {
            // First draft already passed structural validation. Keep it
            // instead of blocking the rebuild on an optional review.
            console.warn('Narrative Database continuity review failed; retaining structurally valid draft:', reviewError);
          }
          const remaining = NDB.continuityWarnings(working.text, result, batch.messages);
          if (remaining.length) console.warn('Narrative Database possible continuity omissions (non-blocking):', remaining);
        }
      } catch (err) {
        throw new Error(`Messages ${working.covered + 1}–${batch.end}: ${err.message || err}`);
      }
      const batchSeconds = Math.round((Date.now() - batchStartedAt) / 1000);
      // Do not mark a batch covered if its original messages changed during generation.
      const signature = NDB.fingerprint(chat.messages, batch.end);
      if (signature !== priorSignature || batch.messages.some(m => !chat.messages.includes(m))) throw new Error('Chat changed during processing; retry with Rebuild.');
      working.text = result;
      working.covered = batch.end;
      working.signature = signature;
      working.checkpoints.push({ covered: batch.end, at: Date.now(), text: result, signature });
      // Bound backup growth; keep the most recent 20 versions for manual inspection/recovery.
      if (working.checkpoints.length > 20) working.checkpoints.shift();
      if (!rebuild) { chat.narrativeDb = structuredClone(working); await saveChat(chat); }
      else { chat.narrativeDbPending = structuredClone(working); await saveChat(chat); }
      S.dbProgress.done++;
      S.dbProgress.lastSeconds = batchSeconds;
      S.dbProgress.timings.push(batchSeconds);
      console.info('Narrative Database batch', S.dbProgress.done, 'of', S.dbProgress.total, 'took', batchSeconds, 'seconds; output ~', NDB.estimateTokens(result), 'tokens');
      updateDatabaseBanner();
      if ($('#ndb-sheet')) databaseSheet();
      if (!(flush || rebuild)) { succeeded = true; break; }
      if (working.covered >= chat.messages.length) { succeeded = true; break; }
    }
    if (succeeded && !S.dbCancel) {
      if (rebuild) { chat.narrativeDb = structuredClone(working); delete chat.narrativeDbPending; delete chat.narrativeDbLastError; delete chat.narrativeDbErrorBatch; await saveChat(chat); }
      else if (chat.narrativeDbLastError) { delete chat.narrativeDbLastError; delete chat.narrativeDbErrorBatch; await saveChat(chat); }
      if (!silent) toast('Narrative Database updated.');
    } else if (S.dbCancel && !silent) toast('Catch-up paused. Resume from last checkpoint.');
  } catch (e) {
    console.error('Narrative Database error', e);
    chat.narrativeDbLastError = String(e.message || e);
    chat.narrativeDbErrorBatch = (S.dbProgress?.done || 0) + 1;
    try { await saveChat(chat); } catch (saveError) { console.error('Could not save database error', saveError); }
    toast('Narrative Database stopped: ' + (e.message || e) + ' (error saved in Narrative Database settings)', 8000);
  } finally {
    S.dbBusy = false; S.dbProgress = null; S.dbCancel = false;
    updateDatabaseBanner();
    if ($('#ndb-sheet')) databaseSheet();
  }
}

function maybeDatabase(chat) {
  const cfg = S.settings.ext.database;
  if (!cfg.enabled || S.dbBusy) return;
  const state = chat.narrativeDb;
  if (NDB.isStale(chat.messages, state)) {
    if (!S.dbStaleWarned) S.dbStaleWarned = new Set();
    if (!S.dbStaleWarned.has(chat.id)) { S.dbStaleWarned.add(chat.id); toast('Narrative Database needs rebuilding after edits.', 6000); }
    return;
  }
  if (NDB.pendingTokens(chat.messages, state?.covered || 0) >= cfg.batchTokens) runDatabase(chat, { silent: true });
}

function memorySheet() {
  const cfg = S.settings.ext.memory;
  const chat = S.chat;
  const layers = (chat.mem && chat.mem.layers) || [];
  const ghosted = chat.messages.filter((m) => m.ghost).length;
  const live = chat.messages.filter((m) => !m.ghost).reduce((n, m) => n + MEM.estTokens(m.swipes[m.swipeIdx]), 0);
  const memText = MEM.assembleMemory(chat.mem);
  const cont = !chat.groupId && liveContinuity(chat);
  openSheet(`
    <div class="sheet-title" id="mem-sheet">Memory ${S.memBusy ? '<span class="muted small">· working…</span>' : ''}</div>
    ${cfg.enabled ? '' : '<p class="hint">Layered memory is off — turn it on in Settings → Extensions.</p>'}
    <div class="mem-stats">
      <div><b>${ghosted}</b>messages in memory</div>
      <div><b>≈${Math.round(live / 1000)}k</b>verbatim tokens</div>
      <div><b>${layers.map((l) => (l || []).length).join(' / ') || '0'}</b>memories per layer</div>
    </div>
    <div class="row wrap">
      <button class="btn" data-action="mem-force">Force summarize</button>
      <button class="btn" data-action="mem-slop" title="Summarize everything but the last two exchanges">Slop breaker</button>
      <button class="btn danger" data-action="mem-clear">Clear</button>
    </div>
    <h3 class="sheet-sub">Injected memory</h3>
    <div class="pv"><pre>${esc(memText || 'Nothing yet.')}</pre></div>
    ${cont ? `<h3 class="sheet-sub">Continuity (live state)</h3><div class="pv"><pre>${esc(MEM.renderContinuity(cont.state, cont.stale).replace(/\{\{user\}\}/g, activePersona().name || 'User'))}</pre></div>` : ''}
  `, 'tall');
}

/** Per-speaker avatar URLs as CSS variables, used by the portrait chat styles. */
function avatarCss() {
  const rules = [];
  const add = (id, src) => { const a = safeAvatar(src); if (a) rules.push(`.msg[data-sp="${id}"]{--av:url("${a}")}`); };
  add('user', activePersona().avatar);
  if (S.group) groupMembers().forEach((c) => add(c.id, c.avatar)); else if (S.char) add(S.char.id, S.char.avatar);
  let el = document.getElementById('av-css');
  if (!el) { el = document.createElement('style'); el.id = 'av-css'; document.head.appendChild(el); }
  el.textContent = rules.join('\n');
}

function summaryFor(chat) {
  const cfg = S.settings.ext.summarize;
  if (!chat.summary || !chat.summary.text) return null;
  return { text: chat.summary.text, position: cfg.enabled ? cfg.position : 'macro', depth: cfg.depth, role: cfg.role, template: cfg.template };
}

/** Background generation with the full chat context (SillyTavern's generateQuietPrompt). */
async function quietGenerate(quietPrompt, { onToken, maxTokens, signal, chat = S.chat } = {}) {
  const conn = activeConn();
  if (!connReady(conn)) throw new Error('Set up an API connection first (Settings → Connection).');
  let speaker = S.char;
  if (S.group && chat.groupId === S.group.id) {
    const lastChar = [...chat.messages].reverse().find((m) => m.role === 'assistant');
    speaker = S.members.get(lastChar && lastChar.charId) || activeMembers()[0] || S.char;
  }
  const { messages } = promptFor({ ...chat, vars: { ...(chat.vars || {}) } }, cardForSpeaker(speaker), chat.messages.slice(), { mode: 'quiet', quietPrompt });
  const preset = { ...S.settings.preset, stream: !!onToken && S.settings.preset.stream };
  if (maxTokens) preset.max_tokens = maxTokens;
  return generate(conn, preset, messages, { signal, onToken, ...genOptions('quiet') });
}

// ---------- Enhance My Reply ----------
async function enhanceDraft() {
  if (S.generating) return;
  const input = $('#send_textarea');
  const draft = input && input.value.trim();
  if (!draft) { toast('Write a draft before enhancing it.'); input && input.focus(); return; }
  const chat = S.chat;
  S.generating = chat.id;
  S.abort = new AbortController();
  updateSendButton();
  const btn = $('#enh-btn');
  if (btn) btn.classList.add('busy');
  try {
    const out = normalizeGeneratedText(await quietGenerate(buildEnhancementPrompt(draft, S.settings.ext.enhance), { signal: S.abort.signal }));
    if (!out) throw new Error('The model returned an empty reply.');
    S.enhanceOriginal = { chatId: chat.id, text: draft };
    if (S.chat === chat) { input.value = out; setDraft(chat.id, out); autosize(input); updateEnhanceButton(); }
    toast('Reply enhanced. Restore the original from ✨ if you want it back.', 4000);
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message || 'Could not enhance the reply.', 6000);
  } finally {
    S.generating = null;
    S.abort = null;
    if (btn) btn.classList.remove('busy');
    updateSendButton();
  }
}

function restoreDraft() {
  const o = S.enhanceOriginal;
  if (!o || o.chatId !== S.chat.id) return toast('No enhanced draft to restore.');
  const input = $('#send_textarea');
  input.value = o.text;
  setDraft(S.chat.id, o.text);
  S.enhanceOriginal = null;
  autosize(input);
  updateEnhanceButton();
  toast('Original draft restored.');
}

function updateEnhanceButton() {
  const b = $('#enh-btn');
  const input = $('#send_textarea');
  if (b && input) b.hidden = !S.settings.ext.enhance.enabled || !input.value.trim();
}

// ---------- Summarize ----------
async function summarizeChat(chat = S.chat, { silent = false } = {}) {
  if (S.summarizing) return;
  const cfg = S.settings.ext.summarize;
  if (!chat.messages.length) return;
  S.summarizing = true;
  if (!silent) toast('Summarizing…', 20000);
  try {
    const prompt = (cfg.prompt || '').replace(/\{\{words\}\}/gi, String(cfg.words || 200));
    const text = normalizeGeneratedText(await quietGenerate(prompt, { chat, maxTokens: Math.max(300, Math.round((cfg.words || 200) * 2.5)) }));
    if (!text) throw new Error('The model returned an empty summary.');
    chat.summary = { text, upTo: chat.messages.length, at: Date.now() };
    await saveChat(chat);
    toast('Summary updated', 2500);
    const box = $('#summary-text');
    if (box) box.value = text;
  } catch (e) {
    toast('Summary failed: ' + (e.message || e), 6000);
  } finally {
    S.summarizing = false;
  }
}

function maybeSummarize(chat) {
  const cfg = S.settings.ext.summarize;
  if (!cfg.enabled || !cfg.every) return;
  const since = chat.messages.length - ((chat.summary && chat.summary.upTo) || 0);
  if (since >= cfg.every) summarizeChat(chat, { silent: true });
}

function summarySheet() {
  const cfg = S.settings.ext.summarize;
  const sm = S.chat.summary;
  openSheet(`
    <div class="sheet-title">Summary</div>
    <p class="hint">${cfg.enabled ? `Updates automatically every ${cfg.every} messages${sm && sm.upTo ? ` (last at message ${sm.upTo})` : ''}.` : 'Summarize is off in Settings → Extensions, so this summary only reaches the AI through a {{summary}} macro in your preset.'}</p>
    <label class="field"><textarea id="summary-text" rows="9" placeholder="No summary yet.">${esc(sm ? sm.text : '')}</textarea></label>
    <div class="row wrap">
      <button class="btn" data-action="summary-now">Summarize now</button>
      <button class="btn primary" data-action="summary-save">Save</button>
    </div>`);
}

// ---------- Quick Replies & slash commands ----------
function qrBarHtml() {
  const btns = S.qr.filter((set) => set.visible !== false).flatMap((set) => set.buttons.map((b) => ({ ...b, setId: set.id })));
  if (!btns.length) return '';
  return `<div class="qr-bar">${btns.map((b) => `<button data-action="qr-run" data-set="${b.setId}" data-id="${b.id}" title="${esc(b.title || b.message)}">${esc(b.label || '…')}</button>`).join('')}</div>`;
}

function memberByName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return groupMembers().find((c) => c.name.toLowerCase() === n) || groupMembers().find((c) => c.name.toLowerCase().startsWith(n)) || null;
}

// Regex scripts set to "Slash commands" edit text that /send, /sendas and /sys add.
function slashRx(text) {
  const env = { char: S.char ? S.char.name : '', user: activePersona().name, vars: { ...((S.chat && S.chat.vars) || {}) } };
  return applyRegex(String(text ?? ''), scriptsFor(S.char), { placement: PLACEMENT.SLASH, macro: (t) => evaluateMacros(t, env) });
}

function scriptApi(chat) {
  const persist = () => { saveChat(chat); saveSettings(); };
  const push = async (msg) => { chat.messages.push({ id: db.uid(), swipeIdx: 0, ts: Date.now(), ...msg }); await saveChat(chat); if (S.chat === chat) renderMessages(true); };
  const lastSpeakerId = () => { const l = [...chat.messages].reverse().find((m) => m.role === 'assistant'); return l && l.charId; };
  return {
    macro: (t) => evaluateMacros(t, { char: (S.group ? (S.members.get(lastSpeakerId()) || S.char) : S.char).name, user: activePersona().name, group: S.group ? groupMembers().map((c) => c.name).join(', ') : undefined, vars: chat.vars || (chat.vars = {}), globals: S.settings.globalVars || (S.settings.globalVars = {}), summary: (chat.summary && chat.summary.text) || '' }),
    vars: () => chat.vars || (chat.vars = {}),
    globals: () => S.settings.globalVars || (S.settings.globalVars = {}),
    save: persist,
    send: (text) => push({ role: 'user', swipes: [slashRx(text)] }),
    sendAs: (name, text) => {
      if (S.group) {
        const c = memberByName(name) || S.members.get(lastSpeakerId()) || groupMembers()[0];
        return push({ role: 'assistant', swipes: [slashRx(text)], charId: c.id, name: c.name });
      }
      return push({ role: 'assistant', swipes: [slashRx(text)] });
    },
    sys: (text) => push({ role: 'system', swipes: [slashRx(text)], name: 'Narrator' }),
    trigger: async (name) => {
      if (S.group && chat.groupId === S.group.id) {
        const c = memberByName(name);
        if (c) await runGeneration('new', c.id); else await runGroupTurn('');
      } else await runGeneration('new');
    },
    gen: async (prompt) => normalizeGeneratedText(await quietGenerate(prompt, { chat })),
    genraw: async (prompt) => {
      const conn = activeConn();
      if (!connReady(conn)) throw new Error('Set up an API connection first.');
      return normalizeGeneratedText(await generate(conn, { ...S.settings.preset, stream: false }, [{ role: 'user', content: prompt }]));
    },
    impersonate: () => runImpersonate(),
    cont: () => runGeneration('continue', lastSpeakerId()),
    regen: () => runGeneration('swipe', lastSpeakerId()),
    setInput: (t) => { const i = $('#send_textarea'); if (i) { i.value = t; setDraft(chat.id, t); autosize(i); updateEnhanceButton(); } },
    input: async (p, def) => window.prompt(p || 'Input', def) ?? '',
    popup: async (t) => window.alert(t),
    echo: (t) => toast(t, 4000),
    preset: (name) => {
      const p = S.presets.find((x) => x.name.toLowerCase() === String(name).trim().toLowerCase());
      if (!p && String(name).trim().toLowerCase() !== 'simple') throw new Error(`No preset named "${name}"`);
      S.settings.activePreset = p ? p.id : null;
      if (p) applyPresetSamplers(p);
      saveSettings();
    },
    buttons: (text, labels) => new Promise((resolve) => {
      openSheet(`<div class="sheet-title">${esc(text || 'Choose')}</div><div class="btn-col">${labels.map((l, i) => `<button class="btn block" data-action="st-button" data-i="${i}">${esc(l)}</button>`).join('')}</div>`);
      S.buttonResolve = (i) => { S.buttonResolve = null; resolve(i == null ? '' : labels[i]); };
    }),
    runQr: async (label) => {
      const want = String(label || '').trim().toLowerCase();
      const b = S.qr.flatMap((set) => set.buttons).find((x) => (x.label || '').trim().toLowerCase() === want);
      if (!b) throw new Error(`No quick reply called "${label}"`);
      const text = (b.message || '').trim();
      if (text.startsWith('/')) return runScript(text, scriptApi(chat));
      await push({ role: 'user', swipes: [scriptApi(chat).macro(text)] });
      return text;
    },
    messages: (range, names) => {
      const list = chat.messages;
      let a = list.length - 1;
      let b = a;
      const m = String(range).match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (m) { a = +m[1]; b = m[2] !== undefined ? +m[2] : a; }
      return list.slice(Math.max(0, Math.min(a, b)), Math.max(a, b) + 1)
        .map((x) => `${names ? `${memNameOf(x)}: ` : ''}${x.swipes[x.swipeIdx] || ''}`).join('\n\n');
    },
    del: async (n) => {
      chat.messages.splice(Math.max(0, chat.messages.length - n), n);
      await saveChat(chat);
      if (S.chat === chat) renderMessages();
    },
    addSwipe: async (text) => {
      const m = [...chat.messages].reverse().find((x) => x.role === 'assistant');
      if (!m) throw new Error('No character message to add a swipe to.');
      m.swipes.push(text);
      m.swipeIdx = m.swipes.length - 1;
      await saveChat(chat);
      if (S.chat === chat) renderMessages();
    },
    custom: {
      imagine: (arg) => runImageGen(...imagineArgs(arg)),
      sd: (arg) => runImageGen(...imagineArgs(arg)),
      image: (arg) => runImageGen(...imagineArgs(arg)),
      speak: (arg) => { const m = [...chat.messages].reverse().find((x) => x.role === 'assistant'); if (arg && arg.trim()) { speakMessage({ id: 'cmd', role: 'system', swipes: [arg], swipeIdx: 0 }); } else if (m) speakMessage(m); },
      translate: async (arg) => translateText(arg, S.settings.ext.translate.target),
      hide: (arg) => setHidden(chat, arg, true),
      unhide: (arg) => setHidden(chat, arg, false),
      'sc-status': () => {
        const layers = (chat.mem && chat.mem.layers) || [];
        const t = `Memory: ${chat.messages.filter((m) => m.ghost).length} messages ghosted; memories per layer ${layers.map((l) => l.length).join('/') || 0}.`;
        toast(t, 5000);
        return t;
      },
      'sc-preview': () => { if (S.chat === chat) memorySheet(); return MEM.assembleMemory(chat.mem); },
      'sc-clear': () => { clearMemory(chat); toast('Memory cleared for this chat'); },
      chatstyle: (arg) => {
        const v = String(arg || '').trim().toLowerCase().replace(/style$/, '');
        if (!CHAT_STYLES[v]) throw new Error(`Chat styles: ${Object.keys(CHAT_STYLES).join(', ')}`);
        S.settings.appearance.chatStyle = v; saveSettings(); applyLook();
      },
      ...Object.fromEntries(Object.keys(CHAT_STYLES).map((k) => [`${k}style`, () => { S.settings.appearance.chatStyle = k; saveSettings(); applyLook(); }])),
    },
    persona: (name) => {
      const p = S.settings.personas.find((x) => x.name.toLowerCase() === String(name).trim().toLowerCase());
      if (!p) throw new Error(`No persona named "${name}"`);
      S.settings.activePersona = p.id;
      saveSettings();
      if (S.chat === chat) renderMessages();
    },
  };
}

async function runSlash(src) {
  const chat = S.chat;
  try {
    await runScript(src, scriptApi(chat));
  } catch (e) {
    toast(e.message || String(e), 6000);
  }
}

async function runQuickReply(setId, id) {
  const set = S.qr.find((x) => x.id === setId);
  const b = set && set.buttons.find((x) => x.id === id);
  if (!b || !b.message) return;
  if (S.generating) return toast('Wait for the current reply (or tap stop).');
  const text = b.message.trim();
  if (text.startsWith('/')) return runSlash(text);
  const input = $('#send_textarea');
  input.value = scriptApi(S.chat).macro(text);
  return sendMessage();
}

// ---------- group helpers ----------
const groupMembers = () => (S.group ? S.group.members.map((id) => S.members.get(id)).filter(Boolean) : []);
const activeMembers = () => groupMembers().filter((c) => !(S.group.muted || []).includes(c.id));

/** The character who wrote an assistant message (or null for user messages). */
function speakerOf(msg) {
  if (msg.role === 'user') return null;
  if (msg.role === 'system') return { id: 'narrator', name: msg.name || 'Narrator', avatar: null };
  if (S.group) return S.members.get(msg.charId) || { id: msg.charId, name: msg.name || '?', avatar: null };
  return S.char;
}

const ownMacros = (c, field) => String(c[field] || '').replace(/\{\{char\}\}|<BOT>/gi, c.name);

/** Card used to prompt a speaker. "Join" mode merges every member's definitions, like SillyTavern. */
function cardForSpeaker(speaker) {
  if (!S.group || S.group.mode !== 'join') return speaker;
  const ms = groupMembers();
  const join = (field, fmt) => ms.filter((c) => (c[field] || '').trim()).map((c) => fmt(c, ownMacros(c, field))).join('\n\n');
  return {
    ...speaker,
    description: join('description', (c, t) => `[${c.name}]\n${t}`),
    personality: join('personality', (c, t) => `${c.name}: ${t}`),
    scenario: (S.group.scenario || '').trim() || speaker.scenario,
    mes_example: join('mes_example', (c, t) => t),
    lorebooks: [...new Set(ms.flatMap((c) => c.lorebooks || []))],
    _embedded: ms.flatMap((c) => embeddedEntries(c)),
  };
}

/** Who answers after a user message ("natural order" uses mentions + talkativeness, like ST). */
function pickSpeakers(text) {
  const ms = activeMembers();
  if (!ms.length) return [];
  const strategy = S.group.strategy || 'natural';
  if (strategy === 'manual') return [];
  if (strategy === 'list') return ms;
  const lower = String(text || '').toLowerCase();
  const out = [];
  for (const c of ms) {
    const names = [c.name, c.name.split(/\s+/)[0]].filter((n) => n && n.length > 1);
    if (names.some((n) => new RegExp(`(^|[^\\p{L}])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(lower))) out.push(c);
  }
  for (const c of ms.slice().sort(() => Math.random() - 0.5)) {
    if (out.includes(c)) continue;
    const t = Number(c.extensions && c.extensions.talkativeness);
    if (Math.random() < (Number.isFinite(t) ? t : 0.5)) out.push(c);
  }
  if (!out.length) out.push(ms[Math.floor(Math.random() * ms.length)]);
  return out;
}

async function runGroupTurn(text) {
  const speakers = pickSpeakers(text);
  if (!speakers.length) { toast('Manual mode: tap ✨ and choose who speaks.'); return; }
  S.stopGroup = false;
  for (const c of speakers) {
    if (S.stopGroup || S.chat.groupId !== S.group.id) break;
    await runGeneration('new', c.id);
  }
}

// Avatars must be embedded raster images, never remote URLs or active SVG.
function safeAvatar(src) {
  return typeof src === 'string' && /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(src) ? src : null;
}

function avatarHtml(src, name, cls = 'av') {
  src = safeAvatar(src);
  return src
    ? `<img class="${cls}" src="${esc(src)}" alt="">`
    : `<div class="${cls} av-fallback" style="--h:${hue(name)}">${esc((name || '?').trim()[0]?.toUpperCase() || '?')}</div>`;
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString();
}

async function saveFile(blob, name) {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (isTouch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
}

const safeName = (s) => String(s || 'file').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);

function pickFile(id) {
  return new Promise((resolve) => {
    const input = $('#' + id);
    input.value = '';
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}

// ---------- sheets (bottom modals) ----------
function openSheet(html, cls = '') {
  closeSheet({ keepEntry: true });
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="backdrop" data-action="close-sheet"></div><div class="sheet ${cls}"><button class="icon-btn sm sheet-close" data-action="close-sheet" aria-label="Close">${ICONS.close}</button><div class="sheet-body">${html}</div></div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  // Give the sheet its own history entry, so the Android back button (or a back
  // swipe) closes the sheet instead of leaving the screen.
  if (sheetPopPending) sheetNeedsEntry = true;
  else if (!(history.state && history.state.sheet)) history.pushState({ sheet: true }, '');
  return wrap.querySelector('.sheet-body');
}
let sheetPopPending = false; // we called history.back() to drop a sheet's entry
let sheetNeedsEntry = false; // a new sheet opened while that was still in flight
function closeSheet(opts = {}) {
  if (S.buttonResolve) S.buttonResolve(null);
  const had = document.querySelector('.sheet-wrap');
  document.querySelectorAll('.sheet-wrap').forEach((w) => w.remove());
  if (had && !opts.fromPop && !opts.keepEntry && !sheetPopPending && history.state && history.state.sheet) {
    sheetPopPending = true;
    history.back();
  }
}
window.addEventListener('popstate', () => {
  if (sheetPopPending) {
    sheetPopPending = false;
    if (sheetNeedsEntry && document.querySelector('.sheet-wrap')) history.pushState({ sheet: true }, '');
    sheetNeedsEntry = false;
    if (goAfterPop) { const h = goAfterPop; goAfterPop = null; go(h); }
    return;
  }
  if (document.querySelector('.sheet-wrap')) closeSheet({ fromPop: true });
});

// ---------- viewport (on-screen keyboard handling) ----------
// iOS shrinks only the visual viewport; Android shrinks the whole window. Track the
// tallest height seen at the current width so the keyboard is detected on both.
let fullH = { w: 0, h: 0 };
function fitViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  const root = document.documentElement.style;
  root.setProperty('--app-h', `${h}px`);
  root.setProperty('--app-top', `${vv ? vv.offsetTop : 0}px`);
  if (fullH.w !== window.innerWidth) fullH = { w: window.innerWidth, h: 0 };
  fullH.h = Math.max(fullH.h, window.innerHeight);
  document.body.classList.toggle('kb-open', fullH.h - h > 120);
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', fitViewport);
  visualViewport.addEventListener('scroll', fitViewport);
}
window.addEventListener('resize', fitViewport);

// ---------- routing ----------
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { name: parts[0] || 'home', a: parts[1], b: parts[2] };
}
let goAfterPop = null; // a screen to open once the sheet's history entry is gone
const go = (hash) => {
  // A sheet was just closed and its history entry is still being removed: open
  // the screen after that, or the pending "back" would undo it.
  if (sheetPopPending) { goAfterPop = hash; return; }
  // Leaving from an open sheet: replace the sheet's history entry so Back doesn't land on it.
  if (history.state && history.state.sheet) {
    document.querySelectorAll('.sheet-wrap').forEach((w) => w.remove());
    location.replace(hash.startsWith('#') ? hash : `#${hash}`);
  } else location.hash = hash;
};

async function render() {
  const r = route();
  closeSheet();
  S.openActions = null;
  S.editing = null;
  document.documentElement.style.setProperty('--font', `${S.settings.ui.fontSize || 16}px`);
  if (r.name !== 'preset' && r.name !== 'lorebook' && r.name !== 'qr') app.dataset.view = '';
  if (r.name !== 'group') S.groupDraft = null;
  try {
    if (r.name === 'chat' && r.a) await renderChatView(r.a, r.b);
    else if (r.name === 'edit' && r.a) await renderEditView(r.a);
    else if (r.name === 'preset' && r.a) renderPresetView(r.a);
    else if (r.name === 'group' && r.a) await renderGroupEditor(r.a);
    else if (r.name === 'qr' && r.a) renderQrView(r.a);
    else if (r.name === 'search') await renderSearchView(r.a);
    else if (r.name === 'lorebook' && r.a) renderLorebookView(r.a);
    else if (r.name === 'settings') renderSettingsView(r.a);
    else await renderHome();
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 5000);
    if (r.name !== 'home') go('#/');
  }
}
window.addEventListener('hashchange', render);

// ---------- HOME ----------
const lib = () => S.settings.library || (S.settings.library = { sort: 'recent', favFirst: true, folders: [] });
const SORTS = { recent: 'Recent chats', name: 'Name A–Z', added: 'Newest added' };

async function renderHome() {
  const chars = await db.getAll('characters');
  const conn = activeConn();
  const L = lib();
  const q = (S.homeQuery || '').trim().toLowerCase();
  const byId = new Map(chars.map((c) => [c.id, c]));
  const groups = S.groups.map((g) => ({ ...g, isGroup: true, membersList: g.members.map((id) => byId.get(id)).filter(Boolean) }));
  const all = [...chars, ...groups];
  // tag counts (folders first)
  const counts = new Map();
  for (const c of all) for (const t of c.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  const folders = (L.folders || []).filter((f) => counts.has(f));
  const tagChips = [...counts.entries()].filter(([t]) => !folders.includes(t)).sort((a, b) => b[1] - a[1]).slice(0, 24);
  const tagOn = S.libTag || null;
  const inFolder = tagOn && folders.includes(tagOn);
  let list = all.filter((c) => {
    if (S.libFav && !c.fav) return false;
    if (tagOn && !(c.tags || []).includes(tagOn)) return false;
    if (q) {
      const hay = `${c.name} ${(c.tags || []).join(' ')} ${c.creator || ''} ${c.isGroup ? c.membersList.map((m) => m.name).join(' ') : ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    // characters inside a folder are hidden from the main list (like ST's tag folders)
    if (!tagOn && !q && !S.libFav && folders.some((f) => (c.tags || []).includes(f))) return false;
    return true;
  });
  const recent = (c) => c.lastChatAt || c.updatedAt || c.createdAt || 0;
  const cmp = { recent: (a, b) => recent(b) - recent(a), name: (a, b) => a.name.localeCompare(b.name), added: (a, b) => (b.createdAt || 0) - (a.createdAt || 0) }[L.sort] || ((a, b) => recent(b) - recent(a));
  list = list.sort((a, b) => (L.favFirst ? (b.fav ? 1 : 0) - (a.fav ? 1 : 0) : 0) || cmp(a, b));
  const showFolders = !tagOn && !q && !S.libFav && folders.length;
  app.innerHTML = `
    <header class="bar">
      <h1 class="title">${BUILD_NAME}</h1>
      <div class="spacer"></div>
      <button class="icon-btn" data-action="go" data-to="#/search" aria-label="Search chats">${ICONS.search}</button>
      <button class="icon-btn" data-action="import-files" aria-label="Import character">${ICONS.import}</button>
      <button class="icon-btn" data-action="new-menu" aria-label="New character or group">${ICONS.plus}</button>
      <button class="icon-btn" data-action="go" data-to="#/settings" aria-label="Settings">${ICONS.gear}</button>
    </header>
    <main class="scroll pad">
      ${isIOS && !isStandalone ? `<div class="banner">Install: tap <b>Share</b> ${ICONS.share} then <b>Add to Home Screen</b> for the full-screen app.</div>` : ''}
      ${!isIOS && !isStandalone && installPrompt ? `<button class="banner" data-action="install-app">Install: tap here to add <b>PocketTavern</b> to your home screen as a full-screen app.</button>` : ''}
      ${isAndroid && !isStandalone && !installPrompt ? `<div class="banner">Install: open the browser menu <b>⋮</b> and tap <b>Add to Home screen</b> (or <b>Install app</b>) for the full-screen app.</div>` : ''}
      ${!connReady(conn) ? `<button class="banner warn" data-action="go" data-to="#/settings/connection">No API connection yet — tap to set up OpenRouter, Claude or another API.</button>` : ''}
      ${all.length ? `
        <input class="search" type="search" placeholder="Search characters, tags, creators" value="${esc(S.homeQuery || '')}" data-input="home-search">
        <div class="chips">
          <button class="chip ${S.libFav ? 'on' : ''}" data-action="lib-fav">★ Favorites</button>
          <label class="chip sel">${ICONS.sort}<select data-change="lib-sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${L.sort === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          ${tagChips.map(([t, n]) => `<button class="chip ${tagOn === t ? 'on' : ''}" data-action="lib-tag" data-tag="${esc(t)}">${esc(t)} <span class="muted">${n}</span></button>`).join('')}
          ${counts.size ? `<button class="chip" data-action="tags-manage">${ICONS.edit} Tags</button>` : ''}
        </div>
        ${inFolder ? `<button class="crumb" data-action="lib-tag" data-tag="${esc(tagOn)}">${ICONS.back} ${ICONS.folder} ${esc(tagOn)}</button>` : ''}
        ${showFolders ? `<div class="folder-list">${folders.map((f) => `<button class="folder-item" data-action="lib-tag" data-tag="${esc(f)}">${ICONS.folder}<span class="grow">${esc(f)}</span><span class="muted">${counts.get(f)}</span></button>`).join('')}</div>` : ''}` : ''}
      <div class="char-list">
        ${list.map((c) => `
          <div class="char-item" role="button" tabindex="0" data-action="go" data-to="#/chat/${c.id}">
            ${c.isGroup ? groupAvatarHtml(c.membersList, 'lg') : avatarHtml(c.avatar, c.name, 'av lg')}
            <div class="ci-text">
              <div class="ci-name">${esc(c.name)}${c.isGroup ? ' <span class="badge">group</span>' : ''}</div>
              <div class="ci-desc">${esc(c.isGroup ? c.membersList.map((m) => m.name).join(', ') : macros(c.creator_notes || c.description, { char: c.name, user: activePersona().name }).replace(/\s+/g, ' ').slice(0, 140))}</div>
              ${(c.tags || []).length ? `<div class="ci-tags">${c.tags.slice(0, 4).map((t) => `<span class="badge">${esc(t)}</span>`).join('')}</div>` : ''}
            </div>
            <div class="ci-side">
              <button class="fav-btn ${c.fav ? 'on' : ''}" data-action="fav-toggle" data-id="${c.id}" data-group="${c.isGroup ? 1 : ''}" aria-label="${c.fav ? 'Unfavorite' : 'Favorite'}">★</button>
              <div class="ci-time">${timeAgo(c.lastChatAt)}</div>
            </div>
          </div>`).join('')}
        ${all.length && !list.length ? '<p class="muted center">Nothing matches.</p>' : ''}
      </div>
      ${!all.length ? `
        <div class="empty">
          <p>No characters yet.</p>
          <p class="muted">Import SillyTavern / TavernAI cards (PNG or JSON), paste a chub.ai link, or create your own.</p>
          <div class="row center">
            <button class="btn primary" data-action="import-files">Import card</button>
            <button class="btn" data-action="link-import">From a link</button>
            <button class="btn" data-action="go" data-to="#/edit/new">Create character</button>
          </div>
        </div>` : ''}
    </main>`;
}

function tagsSheet() {
  db.getAll('characters').then((chars) => {
    const counts = new Map();
    for (const c of [...chars, ...S.groups]) for (const t of c.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    const folders = lib().folders || [];
    openSheet(`<div class="sheet-title">Tags</div>
      <p class="hint">Turn a tag into a folder to tuck its characters away from the main list (like SillyTavern's tag folders). Edit a character's tags in Edit character.</p>
      ${[...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([t, n]) => `<div class="list-row">
        <span class="grow">${esc(t)} <span class="muted small">${n}</span></span>
        <span class="hint">Folder</span><label class="toggle mini"><input type="checkbox" data-folder-tag="${esc(t)}" ${folders.includes(t) ? 'checked' : ''}><i></i></label>
        <button class="icon-btn sm" data-action="tag-rename" data-tag="${esc(t)}" aria-label="Rename">${ICONS.edit}</button>
        <button class="icon-btn sm danger" data-action="tag-delete" data-tag="${esc(t)}" aria-label="Delete">${ICONS.trash}</button>
      </div>`).join('') || '<p class="muted">No tags yet.</p>'}`, 'tall');
  });
}

async function retag(from, to) {
  for (const c of await db.getAll('characters')) {
    if (!(c.tags || []).includes(from)) continue;
    c.tags = [...new Set(c.tags.map((t) => (t === from ? to : t)).filter(Boolean))];
    await db.put('characters', c);
  }
  let g = false;
  for (const x of S.groups) if ((x.tags || []).includes(from)) { x.tags = [...new Set(x.tags.map((t) => (t === from ? to : t)).filter(Boolean))]; g = true; }
  if (g) saveGroups();
  const L = lib();
  L.folders = (L.folders || []).map((f) => (f === from ? to : f)).filter(Boolean);
  if (S.libTag === from) S.libTag = to || null;
  saveSettings();
}

// ---------- search inside chats ----------
async function renderSearchView(chatId) {
  const scoped = chatId ? await db.get('chats', chatId) : null;
  app.innerHTML = `
    <header class="bar">
      <button class="icon-btn" data-action="go-back" aria-label="Back">${ICONS.back}</button>
      <h1 class="title">${scoped ? `Search “${esc(scoped.title)}”` : 'Search all chats'}</h1>
    </header>
    <main class="scroll pad">
      <input class="search" type="search" id="chat-search" placeholder="Words to find…" value="${esc(S.searchQuery || '')}" autocomplete="off">
      <div id="search-results" class="search-results"></div>
    </main>`;
  const input = $('#chat-search');
  let timer;
  const run = () => { clearTimeout(timer); timer = setTimeout(() => searchChats(input.value, chatId), 250); };
  input.addEventListener('input', () => { S.searchQuery = input.value; run(); });
  if (S.searchQuery) run();
  setTimeout(() => input.focus(), 50);
}

async function searchChats(query, chatId) {
  const box = $('#search-results');
  if (!box) return;
  const q = query.trim().toLowerCase();
  if (q.length < 2) { box.innerHTML = '<p class="muted">Type at least two letters.</p>'; return; }
  const chats = chatId ? [await db.get('chats', chatId)].filter(Boolean) : await db.getAll('chats');
  const chars = new Map((await db.getAll('characters')).map((c) => [c.id, c]));
  const groups = new Map(S.groups.map((g) => [g.id, g]));
  const hits = [];
  for (const chat of chats) {
    const owner = chars.get(chat.charId) || groups.get(chat.charId);
    if (!owner) continue;
    chat.messages.forEach((m, i) => {
      const text = m.swipes[m.swipeIdx] || '';
      const at = text.toLowerCase().indexOf(q);
      if (at < 0) return;
      const from = Math.max(0, at - 70);
      hits.push({ chat, owner, m, i, ts: m.ts || chat.updatedAt, pre: (from ? '…' : '') + text.slice(from, at), hit: text.slice(at, at + q.length), post: text.slice(at + q.length, at + q.length + 90) + '…' });
    });
  }
  hits.sort((a, b) => b.ts - a.ts);
  const who = (h) => (h.m.role === 'user' ? (activePersona().name || 'You') : h.m.name || h.owner.name);
  box.innerHTML = `<p class="muted small">${hits.length ? `${hits.length} match${hits.length === 1 ? '' : 'es'}${hits.length > 200 ? ' (showing 200)' : ''}` : 'No matches.'}</p>`
    + hits.slice(0, 200).map((h) => `<button class="search-hit" data-action="search-open" data-char="${h.owner.id}" data-chat="${h.chat.id}" data-msg="${h.m.id}">
        <span class="sh-meta">${esc(h.owner.name)} · ${esc(h.chat.title)} · ${esc(who(h))} · ${timeAgo(h.ts)}</span>
        <span class="sh-text">${esc(h.pre)}<mark>${esc(h.hit)}</mark>${esc(h.post)}</span>
      </button>`).join('');
}

// ---------- import from a link (chub.ai, or a direct card URL) ----------
function chubPath(input) {
  const t = String(input || '').trim();
  const m = t.match(/(?:chub\.ai|characterhub\.org)\/(?:characters\/)?([^/?#\s]+)\/([^/?#\s]+)/i);
  if (m) return `${m[1]}/${m[2]}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(t)) return t;
  return null;
}

async function cardFromChub(path) {
  const errors = [];
  // 1) the card PNG chub serves for every character (identical to "Download → PNG")
  try {
    const r = await fetch(`https://avatars.charhub.io/avatars/${path}/chara_card_v2.png`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    return parseCardFile(new File([blob], `${path.split('/')[1]}.png`, { type: 'image/png' }));
  } catch (e) { errors.push(`card image: ${e.message}`); }
  // 2) the public API (JSON definition + avatar)
  try {
    const r = await fetch(`https://api.chub.ai/api/characters/${path}?full=true`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const node = (await r.json()).node;
    if (!node || !node.definition) throw new Error('no character data');
    const d = node.definition;
    const card = normalizeCard({
      spec: 'chara_card_v2',
      data: {
        name: d.name || node.name, description: d.personality || '', personality: d.tavern_personality || '', scenario: d.scenario || '',
        first_mes: d.first_message || '', mes_example: d.example_dialogs || '', system_prompt: d.system_prompt || '',
        post_history_instructions: d.post_history_instructions || '', alternate_greetings: d.alternate_greetings || [],
        creator_notes: d.description || node.tagline || '', character_book: d.embedded_lorebook || undefined,
        tags: (node.topics || []).filter((x) => x !== 'ROOT'), creator: path.split('/')[0], extensions: d.extensions || {},
      },
    });
    let avatarBlob = null;
    const av = node.max_res_url || node.avatar_url;
    if (av) { try { const a = await fetch(av); if (a.ok) avatarBlob = await a.blob(); } catch { /* no avatar */ } }
    return { card, avatarBlob };
  } catch (e) { errors.push(`API: ${e.message}`); }
  const blocked = errors.some((x) => /Failed to fetch|Load failed|NetworkError/i.test(x));
  throw new Error(blocked
    ? "chub.ai didn't allow the download from inside the app. Open the character on chub.ai → Download → PNG, then import that file."
    : `Couldn't get that character from chub.ai (${errors.join('; ')}).`);
}

async function importFromLink(link) {
  const t = String(link || '').trim();
  let res;
  let base;
  const path = chubPath(t);
  if (path) {
    toast('Downloading from chub.ai…', 20000);
    res = await cardFromChub(path);
    base = path.split('/')[1];
  } else if (/^https:\/\//i.test(t)) {
    toast('Downloading…', 20000);
    let r;
    try { r = await fetch(t); } catch { throw new Error("That site didn't allow the download from inside the app. Download the card file and import it instead."); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    base = decodeURIComponent(t.split(/[?#]/)[0].split('/').pop() || 'card').replace(/\.[^.]+$/, '');
    res = await parseCardFile(new File([blob], `${base}.${/png/.test(blob.type) ? 'png' : 'json'}`, { type: blob.type }));
  } else {
    throw new Error('Paste a chub.ai character link (or creator/name), or a direct https link to a card PNG/JSON.');
  }
  const now = Date.now();
  const c = { id: db.uid(), ...res.card, fileName: base, avatar: res.avatarBlob ? await blobToAvatar(res.avatarBlob) : null, createdAt: now, updatedAt: now, source: t };
  if (res.card.extensions && res.card.extensions.fav) c.fav = true;
  await db.put('characters', c);
  toast(`Imported ${c.name}`);
  closeSheet();
  go(`#/chat/${c.id}`);
}

const looksRegex = (j) => (Array.isArray(j) ? j.length && j.every((x) => x && typeof x.findRegex === 'string')
  : !!j && (typeof j.findRegex === 'string' || Array.isArray(j.regex_scripts)));

// ---------- personas: import / export ----------
const PERSONA_MARK = 'pocketTavernPersona';
const isPersonaCard = (card) => !!(card && card.extensions && card.extensions[PERSONA_MARK]);
const isStPersonaBackup = (j) => !!(j && typeof j === 'object' && !Array.isArray(j) && j.personas && typeof j.personas === 'object' && !Array.isArray(j.personas) && (j.persona_descriptions || j.default_persona !== undefined));

/** Personas from one file: a persona/character card (.png/.json), a SillyTavern persona backup, or our own export. */
async function personasFromFile(f) {
  const buf = await f.arrayBuffer();
  if (isPng(buf)) {
    const { card, avatarBlob } = await parseCardFile(new File([buf], f.name, { type: 'image/png' }));
    return [{ name: card.name, description: card.description || '', avatar: avatarBlob ? await blobToAvatar(avatarBlob, 256) : null }];
  }
  let j;
  try { j = JSON.parse(new TextDecoder().decode(buf)); } catch { throw new Error(`${f.name}: not a persona, card or JSON file`); }
  if (isStPersonaBackup(j)) {
    const descs = j.persona_descriptions || {};
    return Object.entries(j.personas).map(([file, name]) => ({ name: String(name || baseName(file)), description: String((descs[file] || {}).description || ''), avatar: null, isDefault: file === j.default_persona }));
  }
  if (j && j.app === 'PocketTavern' && Array.isArray(j.personas)) {
    return j.personas.map((x) => ({ name: String(x.name || 'Persona'), description: String(x.description || ''), avatar: safeAvatar(x.avatar) }));
  }
  const { card } = await parseCardFile(new File([buf], f.name, { type: 'application/json' }));
  return [{ name: card.name, description: card.description || '', avatar: null }];
}

function addPersonas(list) {
  let added = 0, skipped = 0, last = null, def = null;
  // A brand-new app only has the blank "User" placeholder: replace it, like the zip import does.
  const ps = S.settings.personas;
  const placeholder = ps.length === 1 && ps[0].name === 'User' && !ps[0].description && !ps[0].avatar && !(ps[0].lorebooks || []).length ? ps[0] : null;
  for (const x of list) {
    const name = String(x.name || '').trim() || 'Persona';
    if (S.settings.personas.some((p) => p.name === name && (p.description || '') === (x.description || ''))) { skipped++; continue; }
    const p = { id: db.uid(), name, description: x.description || '', avatar: x.avatar ? safeAvatar(x.avatar) : null };
    S.settings.personas.push(p);
    last = p; added++;
    if (x.isDefault) def = p;
  }
  if (added && placeholder) {
    S.settings.personas = S.settings.personas.filter((x) => x !== placeholder);
    if (S.settings.activePersona === placeholder.id) S.settings.activePersona = (def || last).id;
  }
  if (def) S.settings.activePersona = def.id;
  return { added, skipped, last, def };
}

async function importPersonas() {
  const files = await pickFile('file-cards');
  if (!files.length) return;
  const all = [];
  const errs = [];
  for (const f of files) { try { all.push(...await personasFromFile(f)); } catch (e) { errs.push(e.message); } }
  const { added, skipped, last } = addPersonas(all);
  if (added === 1) S.settings.activePersona = last.id;
  saveSettings(true);
  rerenderSettings();
  toast([
    added ? `Imported ${added} persona${added === 1 ? '' : 's'}${added === 1 ? ` — “${last.name}” is now active` : ' — pick one under Active persona'}.` : '',
    skipped ? `${skipped} already here.` : '',
    !added && !skipped && !errs.length ? 'No personas found in that file.' : '',
    errs.join(' '),
  ].filter(Boolean).join(' '), errs.length ? 8000 : 4000);
}

async function exportPersona() {
  const p = activePersona();
  const card = {
    name: p.name, description: p.description || '', personality: '', scenario: '', first_mes: '', mes_example: '',
    creator_notes: 'A persona exported from PocketTavern. Import it with Import persona (PocketTavern), or use it as a character card.',
    tags: ['persona'], avatar: p.avatar, extensions: { [PERSONA_MARK]: true },
  };
  await saveFile(await exportCardPng(card), `${safeName(p.name)} (persona).png`);
}

/** Import anything SillyTavern exports: character cards, presets, lorebooks, regex scripts. */
async function importFiles() {
  const files = await pickFile('file-cards');
  const done = { chars: 0, presets: 0, books: 0, regex: 0 };
  let lastChar = null;
  let lastPreset = null;
  let lastBook = null;
  for (const f of files) {
    if (/\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed') {
      await importStZip(f);
      continue;
    }
    // Personas: a SillyTavern persona backup, our own export, or a card marked as a persona.
    try {
      const head = new Uint8Array(await f.slice(0, 1).arrayBuffer())[0];
      let personaList = null;
      if (head === 0x7b) {
        const j = JSON.parse(await f.text());
        if (isStPersonaBackup(j) || (j && j.app === 'PocketTavern' && Array.isArray(j.personas))) personaList = await personasFromFile(f);
        else if (isPersonaCard(j.data || j)) personaList = await personasFromFile(f);
      } else if (head === 0x89) {
        const { card } = await parseCardFile(f);
        if (isPersonaCard(card)) personaList = await personasFromFile(f);
      }
      if (personaList) {
        const r = addPersonas(personaList);
        if (r.added === 1) S.settings.activePersona = r.last.id;
        saveSettings(true);
        toast(r.added ? `Imported ${r.added} persona${r.added === 1 ? '' : 's'} (Settings → Persona).` : 'That persona is already here.');
        continue;
      }
    } catch { /* not a persona — handled below as a card, preset, lorebook… */ }
    try {
      const buf = await f.arrayBuffer();
      const base = f.name.replace(/\.[^.]+$/, '');
      let card = null;
      let avatarBlob = null;
      if (isPng(buf)) {
        ({ card, avatarBlob } = await parseCardFile(f));
      } else {
        let json;
        try { json = JSON.parse(new TextDecoder().decode(buf)); } catch { throw new Error(`${f.name}: not a PNG or JSON file`); }
        if (isSTPreset(json)) {
          const p = importSTPreset(json, base, db.uid());
          S.presets.push(p);
          lastPreset = p;
          done.presets++;
          continue;
        }
        if (looksRegex(json)) {
          const list = parseRegexFile(json);
          S.regex.push(...list);
          done.regex += list.length;
          continue;
        }
        const ins = importInstruct(json, base);
        if (ins && !isSTPreset(json)) {
          const t = { ...ins, id: db.uid() };
          S.settings.instruct.saved = [...(S.settings.instruct.saved || []), t];
          S.settings.instruct.template = t.id;
          saveSettings();
          done.instruct = (done.instruct || 0) + 1;
          continue;
        }
        const theme = importThemeFile(json, base);
        if (theme) {
          const a = S.settings.appearance;
          const t = { id: db.uid(), name: String(theme.name).replace(/^\[Moonlit\]\s*/, '').slice(0, 60), colors: { ...paletteOf({ theme: 'midnight', colors: {} }), ...theme.colors } };
          if (theme.css) {
            await db.put('kv', theme.css, `themecss:${t.id}`);
            t.hasCss = true;
            a.useThemeCss = confirm(`"${t.name}" comes with custom CSS from its author (${Math.round(theme.css.length / 1024)} KB, written for SillyTavern's layout).\n\nApply it? Most of it should carry over; some parts may look different on PocketTavern. Only use theme files from people you trust. You can turn it off any time in Settings → Appearance.`);
          }
          a.saved = [...(a.saved || []), t];
          a.theme = t.id; a.colors = {};
          if (theme.chatStyle) a.chatStyle = theme.chatStyle;
          if (theme.avatarShape) a.avatarShape = theme.avatarShape;
          if (typeof theme.timestamps === 'boolean') a.timestamps = theme.timestamps;
          await applyLook();
          saveSettings();
          done.themes = (done.themes || 0) + 1;
          continue;
        }
        if (Array.isArray(json.qrList)) {
          S.qr.push({ id: db.uid(), name: json.name || base, visible: true, buttons: json.qrList.map((q) => ({ id: db.uid(), label: String(q.label || q.title || 'QR'), title: String(q.title || ''), message: String(q.message || '') })) });
          done.qr = (done.qr || 0) + 1;
          continue;
        }
        if (json.entries && !json.spec && !json.first_mes) {
          const b = normalizeBook(json, base);
          const book = { id: db.uid(), name: base || b.name, global: false, scanDepth: b.scanDepth, entries: b.entries };
          S.lorebooks.push(book);
          lastBook = book;
          done.books++;
          continue;
        }
        card = normalizeCard(json);
      }
      const now = Date.now();
      const c = { id: db.uid(), ...card, fileName: base, avatar: avatarBlob ? await blobToAvatar(avatarBlob) : null, createdAt: now, updatedAt: now };
      if (card.extensions && (card.extensions.fav === true || card.extensions.fav === 'true')) c.fav = true;
      await db.put('characters', c);
      lastChar = c;
      done.chars++;
    } catch (e) {
      toast(e.message, 5000);
    }
  }
  if (done.presets) await savePresets(true);
  if (done.books) await saveLorebooks(true);
  if (done.regex) await saveRegex(true);
  if (done.qr) await saveQr(true);
  const parts = [];
  if (done.chars) parts.push(`${done.chars} character${done.chars > 1 ? 's' : ''}`);
  if (done.presets) parts.push(`${done.presets} preset${done.presets > 1 ? 's' : ''}`);
  if (done.books) parts.push(`${done.books} lorebook${done.books > 1 ? 's' : ''}`);
  if (done.regex) parts.push(`${done.regex} regex script${done.regex > 1 ? 's' : ''}`);
  if (done.qr) parts.push(`${done.qr} quick reply set${done.qr > 1 ? 's' : ''}`);
  if (done.instruct) parts.push(`${done.instruct} instruct template${done.instruct > 1 ? 's' : ''} (selected)`);
  if (done.themes) parts.push(`${done.themes} theme${done.themes > 1 ? 's' : ''} (applied)`);
  if (!parts.length) return;
  if (lastPreset && confirm(`Use preset "${lastPreset.name}" now?\n\nThis also applies its generation settings (max tokens, context size, temperature…).`)) {
    S.settings.activePreset = lastPreset.id;
    applyPresetSamplers(lastPreset);
    await saveSettings(true);
  }
  toast(`Imported ${parts.join(', ')}${lastBook ? '. Attach lorebooks to a persona or character, or make them global.' : ''}`, lastBook ? 6000 : 3000);
  if (done.chars === 1 && parts.length === 1) go(`#/chat/${lastChar.id}`);
  else render();
}

function applyPresetSamplers(p) {
  for (const [k, v] of Object.entries(p.samplers || {})) if (v !== undefined) S.settings.preset[k] = v;
  saveSettings();
}

function imagineArgs(arg) {
  const a = String(arg || '').trim();
  const low = a.toLowerCase();
  if (!a || ['scene', 'last'].includes(low)) return ['scene'];
  if (['char', 'character', 'you', 'face', 'portrait'].includes(low)) return ['char'];
  if (['me', 'user', 'persona'].includes(low)) return ['user'];
  return ['free', a];
}

/** /hide 3, /hide 2-5, /unhide (no argument = last message). Indexes are 0-based like SillyTavern's. */
function setHidden(chat, arg, hidden) {
  const n = chat.messages.length;
  if (!n) return;
  let a = n - 1;
  let b = n - 1;
  const m = String(arg || '').trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (m) { a = Number(m[1]); b = m[2] !== undefined ? Number(m[2]) : a; }
  for (let i = Math.max(0, Math.min(a, b)); i <= Math.min(n - 1, Math.max(a, b)); i++) chat.messages[i].hidden = hidden;
  saveChat(chat);
  if (S.chat === chat) renderMessages();
}

/** Import a zipped SillyTavern data folder. */
async function importStZip(file) {
  openSheet(`<div class="sheet-title">Importing SillyTavern data</div>
    <p id="imp-progress">Reading the zip…</p><div id="imp-result"></div>`, 'tall');
  const prog = (t) => { const el = $('#imp-progress'); if (el) el.textContent = t; };
  const log = [];
  const done = { chars: 0, chats: 0, groups: 0, groupChats: 0, personas: 0, books: 0, presets: 0, regex: 0, themes: 0, qr: 0, skipped: 0 };
  const lower = (x) => String(x || '').replace(/\.png$/i, '').toLowerCase();
  const span = (msgs) => msgs.reduce((r, m) => [Math.min(r[0], m.ts), Math.max(r[1], m.ts)], [Infinity, 0]);
  try {
    const z = classify(await openZip(file));
    let st = {};
    if (z.settings) { try { st = await readJson(file, z.settings); } catch { log.push('settings.json could not be read'); } }
    const wiS = st.world_info_settings || {};
    const wiCfg = wiS.world_info || st.world_info || {};
    const pu = st.power_user || {};
    const ext = st.extension_settings || {};
    if (!z.characters.length && !z.worlds.length && !z['OpenAI Settings'].length && !z.chats.length) {
      throw new Error("This zip doesn't look like a SillyTavern data folder (no characters, chats, worlds or presets folders found).");
    }

    // Lorebooks
    prog('Lorebooks…');
    const bookByName = new Map(S.lorebooks.map((b) => [b.name.toLowerCase(), b]));
    const globalSel = new Set((wiCfg.globalSelect || []).map((x) => String(x).toLowerCase()));
    for (const e of z.worlds) {
      if (!/\.json$/i.test(e.rel) || e.rel.includes('/')) continue;
      const name = baseName(e.rel);
      if (bookByName.has(name.toLowerCase())) { done.skipped++; continue; }
      try {
        const b = normalizeBook(await readJson(file, e), name);
        const book = { id: db.uid(), name, global: globalSel.has(name.toLowerCase()), scanDepth: b.scanDepth, entries: b.entries };
        S.lorebooks.push(book);
        bookByName.set(name.toLowerCase(), book);
        done.books++;
      } catch (err) { log.push(`Lorebook ${name}: ${err.message}`); }
    }
    await saveLorebooks(true);
    const P = S.settings.prompt;
    if (wiS.world_info_depth != null) P.wi_scan_depth = Number(wiS.world_info_depth) || P.wi_scan_depth;
    if (wiS.world_info_budget != null) P.wi_budget = Number(wiS.world_info_budget) || 0;
    if (wiS.world_info_recursive != null) P.wi_recursion = !!wiS.world_info_recursive;
    if (wiS.world_info_max_recursion_steps != null) P.wi_max_recursion = Number(wiS.world_info_max_recursion_steps) || 0;

    // Characters
    const existing = await db.getAll('characters');
    const charByFile = new Map(existing.filter((c) => c.fileName).map((c) => [c.fileName.toLowerCase(), c]));
    const charLore = new Map((wiCfg.charLore || []).map((x) => [lower(x.name), x.extraBooks || []]));
    // ST tags: settings.tags [{id, name, folder_type}] + tag_map { "Card.png": [ids] }
    const tagName = new Map((Array.isArray(st.tags) ? st.tags : []).map((t) => [t.id, t.name]));
    const tagMap = st.tag_map && typeof st.tag_map === 'object' ? st.tag_map : {};
    const stTagsFor = (file) => (tagMap[file] || tagMap[`${file}.png`] || []).map((id) => tagName.get(id)).filter(Boolean);
    const stFolders = (Array.isArray(st.tags) ? st.tags : []).filter((t) => t.folder_type && t.folder_type !== 'NONE').map((t) => t.name);
    if (stFolders.length) { const L = lib(); L.folders = [...new Set([...(L.folders || []), ...stFolders])]; }
    const cards = z.characters.filter((e) => !e.rel.includes('/') && /\.(png|json)$/i.test(e.rel));
    for (let i = 0; i < cards.length; i++) {
      const e = cards[i];
      prog(`Characters ${i + 1} of ${cards.length}…`);
      const base = baseName(e.rel);
      if (charByFile.has(base.toLowerCase())) { done.skipped++; continue; }
      try {
        const blob = await readEntry(file, e);
        const f = new File([blob], e.rel, { type: /\.png$/i.test(e.rel) ? 'image/png' : 'application/json' });
        const { card, avatarBlob } = await parseCardFile(f);
        const now = Date.now();
        const c = { id: db.uid(), ...card, fileName: base, avatar: avatarBlob ? await blobToAvatar(avatarBlob) : null, createdAt: now, updatedAt: now };
        const extra = (charLore.get(base.toLowerCase()) || []).map((n) => bookByName.get(String(n).toLowerCase())).filter(Boolean).map((b) => b.id);
        if (extra.length) c.lorebooks = extra;
        const stTags = stTagsFor(e.rel);
        if (stTags.length) c.tags = [...new Set([...(c.tags || []), ...stTags])];
        if (card.extensions && (card.extensions.fav === true || card.extensions.fav === 'true')) c.fav = true;
        await db.put('characters', c);
        charByFile.set(base.toLowerCase(), c);
        done.chars++;
      } catch (err) { log.push(`${e.rel}: ${err.message}`); }
    }

    // Expression sprites (characters/<character file name>/<emotion>.png)
    const spriteFiles = z.characters.filter((e) => e.rel.split('/').length === 2 && /\.(png|webp|jpe?g|gif)$/i.test(e.rel));
    const byFolder = new Map();
    for (const e of spriteFiles) {
      const folder = e.rel.split('/')[0].toLowerCase();
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder).push(e);
    }
    let spriteCount = 0;
    for (const [folder, list] of byFolder) {
      const c = charByFile.get(folder);
      if (!c) continue;
      const sp = { ...(await spritesOf(c.id)) };
      for (const e of list) {
        const label = baseName(e.rel).toLowerCase();
        if (sp[label]) continue;
        prog(`Expressions for ${c.name}…`);
        try { sp[label] = await blobToPng(await readEntry(file, e)); spriteCount++; } catch (err) { log.push(`${e.rel}: ${err.message}`); }
      }
      await saveSprites(c.id, sp);
    }
    done.sprites = spriteCount;

    // Chats (chats/<character file name>/<chat>.jsonl)
    const chatFiles = z.chats.filter((e) => /\.jsonl$/i.test(e.rel) && e.rel.includes('/'));
    const titles = new Map();
    for (let i = 0; i < chatFiles.length; i++) {
      const e = chatFiles[i];
      if (i % 3 === 0 || i === chatFiles.length - 1) prog(`Chats ${i + 1} of ${chatFiles.length}…`);
      const c = charByFile.get(e.rel.split('/')[0].toLowerCase());
      if (!c) { done.skipped++; continue; }
      if (!titles.has(c.id)) titles.set(c.id, new Set((await db.byIndex('chats', 'charId', c.id)).map((x) => x.title)));
      const title = baseName(e.rel).slice(0, 80);
      if (titles.get(c.id).has(title)) { done.skipped++; continue; }
      try {
        const { messages, meta } = parseStChat(await readText(file, e), { uid: db.uid });
        if (!messages.length) continue;
        const [from, to] = span(messages);
        const chat = { id: db.uid(), charId: c.id, title, createdAt: from, updatedAt: to, messages };
        const md = meta.chat_metadata || {};
        if (md.note_prompt) chat.authorsNote = { text: md.note_prompt, depth: Number(md.note_depth ?? 4), role: ['system', 'user', 'assistant'][Number(md.note_role) || 0] };
        if (md.variables && typeof md.variables === 'object') chat.vars = { ...md.variables };
        await db.put('chats', chat);
        if (!c.lastChatAt || to > c.lastChatAt) { c.lastChatAt = to; c.lastChatId = chat.id; await db.put('characters', c); }
        titles.get(c.id).add(title);
        done.chats++;
      } catch (err) { log.push(`${e.rel}: ${err.message}`); }
    }

    // Groups + group chats
    for (const e of z.groups.filter((x) => /\.json$/i.test(x.rel) && !x.rel.includes('/'))) {
      try {
        const g = await readJson(file, e);
        if (!g || !Array.isArray(g.members)) continue;
        if (S.groups.some((x) => x.name === g.name)) { done.skipped++; continue; }
        const members = g.members.map((m) => charByFile.get(lower(m))).filter(Boolean);
        if (members.length < 2) { log.push(`Group "${g.name}": members not found`); continue; }
        const now = Date.now();
        const group = {
          id: db.uid(), name: String(g.name || 'Group'), members: members.map((m) => m.id),
          muted: (g.disabled_members || []).map((m) => charByFile.get(lower(m))).filter(Boolean).map((m) => m.id),
          strategy: ['natural', 'list', 'manual'][Number(g.activation_strategy) || 0] || 'natural',
          mode: Number(g.generation_mode) >= 1 ? 'join' : 'swap', scenario: '', createdAt: now, updatedAt: now,
          fav: !!g.fav, tags: (tagMap[g.id] || []).map((id) => tagName.get(id)).filter(Boolean),
        };
        S.groups.push(group);
        done.groups++;
        const byName = (n) => { const m = members.find((x) => x.name.toLowerCase() === String(n || '').toLowerCase()); return m && m.id; };
        for (const chatName of [...new Set([...(g.chats || []), g.chat_id].filter(Boolean))]) {
          prog(`Group chats: ${group.name}…`);
          const ce = z['group chats'].find((x) => baseName(x.rel) === String(chatName));
          if (!ce) continue;
          const { messages } = parseStChat(await readText(file, ce), { uid: db.uid, memberByName: byName });
          if (!messages.length) continue;
          const [from, to] = span(messages);
          const chat = { id: db.uid(), charId: group.id, groupId: group.id, title: String(chatName).slice(0, 80), createdAt: from, updatedAt: to, messages };
          await db.put('chats', chat);
          if (!group.lastChatAt || to > group.lastChatAt) { group.lastChatAt = to; group.lastChatId = chat.id; }
          done.groupChats++;
        }
      } catch (err) { log.push(`${e.rel}: ${err.message}`); }
    }
    await saveGroups(true);

    // Personas
    const pNames = pu.personas || {};
    const pDescs = pu.persona_descriptions || {};
    const pFiles = Object.keys(pNames);
    if (pFiles.length) {
      prog('Personas…');
      const avatarEntry = new Map(z['User Avatars'].map((x) => [x.rel, x]));
      const ps = S.settings.personas;
      if (ps.length === 1 && ps[0].name === 'User' && !ps[0].description && !ps[0].avatar) S.settings.personas = [];
      for (const f of pFiles) {
        const name = String(pNames[f] || baseName(f));
        if (S.settings.personas.some((p) => p.name === name)) { done.skipped++; continue; }
        const d = pDescs[f] || {};
        const p = { id: db.uid(), name, description: String(d.description || ''), avatar: null };
        const ae = avatarEntry.get(f);
        if (ae) { try { p.avatar = await blobToAvatar(await readEntry(file, ae), 256); } catch { /* skip avatar */ } }
        if (d.lorebook) { const b = bookByName.get(String(d.lorebook).toLowerCase()); if (b) p.lorebooks = [b.id]; }
        for (const link of Array.isArray(d.connections) ? d.connections : []) {
          if (link && link.type === 'character') {
            const c = charByFile.get(lower(link.id));
            if (c) { c.personaId = p.id; await db.put('characters', c); }
          }
        }
        S.settings.personas.push(p);
        done.personas++;
        if (f === pu.default_persona || f === st.user_avatar) S.settings.activePersona = p.id;
      }
      if (!S.settings.personas.length) S.settings.personas = defaultSettings().personas;
      if (!S.settings.personas.some((p) => p.id === S.settings.activePersona)) S.settings.activePersona = S.settings.personas[0].id;
    }

    // Presets
    prog('Presets…');
    for (const e of z['OpenAI Settings'].filter((x) => /\.json$/i.test(x.rel) && !x.rel.includes('/'))) {
      const name = baseName(e.rel);
      if (S.presets.some((p) => p.name === name)) { done.skipped++; continue; }
      try {
        const json = await readJson(file, e);
        if (isSTPreset(json)) { S.presets.push(importSTPreset(json, name, db.uid())); done.presets++; }
      } catch (err) { log.push(`Preset ${name}: ${err.message}`); }
    }
    const activeName = st.oai_settings && st.oai_settings.preset_settings_openai;
    const active = activeName && S.presets.find((p) => p.name === activeName);
    if (active) { S.settings.activePreset = active.id; applyPresetSamplers(active); }
    // SillyTavern's sliders can differ from what's saved in the preset file; use
    // the values it was actually running with.
    const oai = st.oai_settings || {};
    const liveCtx = Number(oai.openai_max_context), liveMax = Number(oai.openai_max_tokens);
    if (liveCtx > 0) S.settings.preset.context_size = liveCtx;
    if (liveMax > 0) S.settings.preset.max_tokens = liveMax;
    await savePresets(true);

    // Regex (global scripts live in settings.json)
    for (const r of Array.isArray(ext.regex) ? ext.regex : []) {
      try {
        const sc = normalizeScript(r);
        if (S.regex.some((x) => x.scriptName === sc.scriptName && x.findRegex === sc.findRegex)) { done.skipped++; continue; }
        S.regex.push(sc);
        done.regex++;
      } catch { /* not a script */ }
    }
    await saveRegex(true);

    // Quick replies
    const visible = new Map(((ext.quickReplyV2 && ext.quickReplyV2.config && ext.quickReplyV2.config.setList) || []).map((x) => [x.set, x.isVisible !== false]));
    for (const e of z.QuickReplies.filter((x) => /\.json$/i.test(x.rel))) {
      try {
        const json = await readJson(file, e);
        if (!Array.isArray(json.qrList)) continue;
        const name = json.name || baseName(e.rel);
        if (S.qr.some((x) => x.name === name)) { done.skipped++; continue; }
        S.qr.push({ id: db.uid(), name, visible: visible.get(name) ?? false, buttons: json.qrList.map((q) => ({ id: db.uid(), label: String(q.label || q.title || 'QR'), title: String(q.title || ''), message: String(q.message || '') })) });
        done.qr++;
      } catch { /* skip */ }
    }
    await saveQr(true);

    // The active UI theme
    if (pu.theme) {
      const te = z.themes.find((x) => baseName(x.rel) === pu.theme);
      const a = S.settings.appearance;
      if (te && !(a.saved || []).some((t) => t.source === pu.theme || t.name === pu.theme)) {
        try {
          const theme = importThemeFile(await readJson(file, te), pu.theme);
          if (theme) {
            const t = { id: db.uid(), name: String(theme.name).slice(0, 60), source: pu.theme, colors: { ...paletteOf({ theme: 'midnight', colors: {} }), ...theme.colors } };
            if ((a.saved || []).some((x) => x.name === t.name)) { done.skipped++; throw Object.assign(new Error('dup'), { quiet: true }); }
            if (theme.css) {
              await db.put('kv', theme.css, `themecss:${t.id}`);
              t.hasCss = true;
              a.useThemeCss = confirm(`Your SillyTavern theme "${t.name}" has custom CSS from its author. Apply it here too?`);
            }
            a.saved = [...(a.saved || []), t];
            a.theme = t.id;
            a.colors = {};
            if (theme.chatStyle) a.chatStyle = theme.chatStyle;
            if (theme.avatarShape) a.avatarShape = theme.avatarShape;
            if (typeof theme.timestamps === 'boolean') a.timestamps = theme.timestamps;
            done.themes++;
          }
        } catch (err) { if (!err.quiet) log.push(`Theme: ${err.message}`); }
      }
    }

    // Instruct templates (for text-completion connections)
    for (const e of (z.instruct || []).filter((x) => /\.json$/i.test(x.rel) && !x.rel.includes('/'))) {
      try {
        const t = importInstruct(await readJson(file, e), baseName(e.rel));
        if (!t || (S.settings.instruct.saved || []).some((x) => x.name === t.name)) continue;
        S.settings.instruct.saved = [...(S.settings.instruct.saved || []), { ...t, id: db.uid() }];
        done.instruct = (done.instruct || 0) + 1;
      } catch { /* skip */ }
    }
    const activeIns = pu.instruct && pu.instruct.preset && (S.settings.instruct.saved || []).find((x) => x.name === pu.instruct.preset);
    if (activeIns) S.settings.instruct.template = activeIns.id;

    // Global variables
    if (ext.variables && ext.variables.global && typeof ext.variables.global === 'object') {
      S.settings.globalVars = { ...(S.settings.globalVars || {}), ...ext.variables.global };
    }
    await saveSettings(true);
    await applyLook();
  } catch (err) {
    log.unshift(err.message || String(err));
  }
  const rows = [
    ['Characters', done.chars], ['Expression sprites', done.sprites], ['Chats', done.chats], ['Group chats', done.groups ? `${done.groups} groups, ${done.groupChats} chats` : 0],
    ['Personas', done.personas], ['Lorebooks', done.books], ['Presets', done.presets], ['Regex scripts', done.regex],
    ['Quick reply sets', done.qr], ['Instruct templates', done.instruct], ['Theme', done.themes], ['Already here (skipped)', done.skipped],
  ].filter(([, v]) => v);
  prog(rows.length ? 'Done!' : 'Nothing was imported.');
  const box = $('#imp-result');
  if (box) {
    box.innerHTML = `${rows.map(([k, v]) => `<div class="list-row"><span class="grow">${k}</span><b>${esc(v)}</b></div>`).join('')}
      ${log.length ? `<h3 class="sheet-sub">Notes</h3><div class="pv"><pre>${esc(log.slice(0, 40).join('\n'))}${log.length > 40 ? `\n…and ${log.length - 40} more` : ''}</pre></div>` : ''}
      <button class="btn primary block" data-action="imp-done">Done</button>`;
  }
}

function groupAvatarHtml(members, size = 'lg') {
  const ms = members.slice(0, 4);
  if (!ms.length) return `<div class="av ${size} av-fallback" style="--h:260">G</div>`;
  return `<div class="av ${size} group-av n${ms.length}">${ms.map((c) => avatarHtml(c.avatar, c.name, 'gav')).join('')}</div>`;
}

const GROUP_STRATEGIES = { natural: 'Natural (mentions + talkativeness)', list: 'List (everyone, in order)', manual: 'Manual (you pick who speaks)' };

async function renderGroupEditor(id) {
  const chars = (await db.getAll('characters')).sort((a, b) => a.name.localeCompare(b.name));
  let g;
  if (S.groupDraft && (S.groupDraft.id === id || (id === 'new' && S.groupDraft.isNew))) g = S.groupDraft;
  else if (id === 'new') g = { id: db.uid(), name: '', members: [], muted: [], strategy: 'natural', mode: 'swap', scenario: '', isNew: true };
  else {
    const found = S.groups.find((x) => x.id === id);
    if (!found) throw new Error('Group not found');
    g = structuredClone(found);
  }
  S.groupDraft = g;
  const inGroup = new Set(g.members);
  const ordered = [...g.members.map((mid) => chars.find((c) => c.id === mid)).filter(Boolean), ...chars.filter((c) => !inGroup.has(c.id))];
  app.innerHTML = `
    <header class="bar">
      <button class="icon-btn" data-action="go-back" aria-label="Back">${ICONS.back}</button>
      <h1 class="title">${g.isNew ? 'New group' : 'Edit group'}</h1>
      <div class="spacer"></div>
      <button class="btn sm primary" data-action="group-save">Save</button>
    </header>
    <main class="scroll pad form">
      <label class="field"><span class="label">Group name</span><input id="g-name" value="${esc(g.name)}" placeholder="e.g. The Grim Jackals" autocomplete="off"></label>
      <div class="field"><span class="label">Members <span class="hint">(tick to add · ↑ to reorder · mute to skip their turns)</span></span>
        ${ordered.map((c) => {
          const on = inGroup.has(c.id);
          return `<div class="list-row">
            <label class="check grow"><input type="checkbox" data-g-member="${c.id}" ${on ? 'checked' : ''}> ${avatarHtml(c.avatar, c.name, 'av sm')} ${esc(c.name)}</label>
            ${on ? `<button class="btn sm" data-action="g-up" data-id="${c.id}" aria-label="Move up">↑</button>
              <label class="check small"><input type="checkbox" data-g-mute="${c.id}" ${(g.muted || []).includes(c.id) ? 'checked' : ''}> mute</label>` : ''}
          </div>`;
        }).join('') || '<p class="muted">Import some characters first.</p>'}
      </div>
      <label class="field"><span class="label">Who replies</span><select id="g-strategy">
        ${Object.entries(GROUP_STRATEGIES).map(([k, v]) => `<option value="${k}" ${g.strategy === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select><span class="hint">Talkativeness comes from each card (default 50%). You can always make anyone speak from the ✨ menu.</span></label>
      <label class="field"><span class="label">Character cards</span><select id="g-mode">
        <option value="swap" ${g.mode !== 'join' ? 'selected' : ''}>Swap: only the speaker's card is sent</option>
        <option value="join" ${g.mode === 'join' ? 'selected' : ''}>Join: every member's card is sent</option>
      </select></label>
      <label class="field"><span class="label">Group scenario <span class="hint">(optional, overrides cards' scenarios)</span></span><textarea id="g-scenario" rows="3">${esc(g.scenario || '')}</textarea></label>
      ${g.isNew ? '' : `<button class="btn danger block" data-action="group-delete">${ICONS.trash} Delete group</button>`}
      <div class="bottom-space"></div>
    </main>`;
}

function collectGroupDraft() {
  const g = S.groupDraft;
  g.name = $('#g-name').value.trim();
  g.strategy = $('#g-strategy').value;
  g.mode = $('#g-mode').value;
  g.scenario = $('#g-scenario').value;
  const checked = new Set([...document.querySelectorAll('[data-g-member]')].filter((x) => x.checked).map((x) => x.dataset.gMember));
  g.members = [...g.members.filter((id) => checked.has(id)), ...[...checked].filter((id) => !g.members.includes(id))];
  g.muted = [...document.querySelectorAll('[data-g-mute]')].filter((x) => x.checked).map((x) => x.dataset.gMute).filter((id) => checked.has(id));
  return g;
}

// ---------- CHAT ----------
function greetingMessage(char) {
  const swipes = [char.first_mes, ...(char.alternate_greetings || [])].filter((s) => s && s.trim());
  if (!swipes.length) return [];
  return [{ id: db.uid(), role: 'assistant', swipes, swipeIdx: 0, ts: Date.now(), greeting: true }];
}

async function createChat(char) {
  const now = Date.now();
  const group = S.groups.find((g) => g.id === char.id);
  let messages;
  if (group) {
    messages = group.members.map((id) => S.members.get(id)).filter(Boolean)
      .flatMap((c) => greetingMessage(c).map((m) => ({ ...m, charId: c.id, name: c.name })));
  } else messages = greetingMessage(char);
  const chat = {
    id: db.uid(), charId: char.id, ...(group ? { groupId: group.id } : {}),
    title: new Date(now).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    createdAt: now, updatedAt: now,
    messages,
  };
  await db.put('chats', chat);
  return chat;
}

// Unsent text in the message box, per chat. Kept apart from the chat itself
// (which is reloaded whenever the chat screen opens) and saved on the device,
// so leaving the chat, changing the model or closing the app doesn't lose it.
let drafts = {};
let draftTimer = 0;
function getDraft(chat) {
  if (!chat) return '';
  if ('draftInput' in chat) { // older versions kept it on the chat itself
    if (chat.draftInput && !(chat.id in drafts)) setDraft(chat.id, chat.draftInput);
    delete chat.draftInput;
  }
  return drafts[chat.id] || '';
}
function setDraft(chatId, text) {
  if (!chatId) return;
  if (text) drafts[chatId] = text; else delete drafts[chatId];
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDrafts, 400);
}
function saveDrafts() {
  clearTimeout(draftTimer);
  return db.put('kv', drafts, 'drafts').catch((e) => console.warn('Saving draft failed', e));
}
addEventListener('pagehide', saveDrafts);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveDrafts(); });

async function saveChat(chat) {
  chat.updatedAt = Date.now();
  await db.put('chats', chat);
  const g = S.groups.find((x) => x.id === chat.charId);
  if (g) {
    g.lastChatAt = chat.updatedAt;
    g.lastChatId = chat.id;
    saveGroups();
    if (S.char && S.char.id === g.id) { S.char.lastChatAt = g.lastChatAt; S.char.lastChatId = g.lastChatId; }
    return;
  }
  const c = await db.get('characters', chat.charId);
  if (c) {
    c.lastChatAt = chat.updatedAt;
    c.lastChatId = chat.id;
    await db.put('characters', c);
    if (S.char && S.char.id === c.id) { S.char.lastChatAt = c.lastChatAt; S.char.lastChatId = c.lastChatId; }
  }
}

async function loadGroup(group) {
  S.group = group;
  S.members = new Map();
  for (const id of group.members) {
    const c = await db.get('characters', id);
    if (c) S.members.set(id, c);
  }
}

async function renderChatView(charId, chatId) {
  const group = S.groups.find((g) => g.id === charId);
  let char;
  if (group) {
    await loadGroup(group);
    const ms = groupMembers();
    char = { id: group.id, name: group.name, avatar: (ms[0] || {}).avatar || null, isGroup: true, lastChatId: group.lastChatId };
  } else {
    S.group = null;
    S.members = new Map();
    char = await db.get('characters', charId);
  }
  if (!char) throw new Error('Character not found');
  S.char = char;
  // Persona locked to this character (like SillyTavern's persona lock)
  if (!group && char.personaId && char.personaId !== S.settings.activePersona && S.settings.personas.some((p) => p.id === char.personaId)) {
    S.settings.activePersona = char.personaId;
    saveSettings();
    setTimeout(() => toast(`Persona: ${activePersona().name}`), 50);
  }
  S.chats = (await db.byIndex('chats', 'charId', charId)).sort((a, b) => b.updatedAt - a.updatedAt);
  let chat = chatId ? S.chats.find((c) => c.id === chatId) : (S.chats.find((c) => c.id === char.lastChatId) || S.chats[0]);
  if (!chat) {
    chat = await createChat(char);
    S.chats.unshift(chat);
  }
  // Keep the in-memory object if this chat is currently generating, so streaming continues to update it.
  if (S.chat && S.chat.id === chat.id && S.generating === chat.id) chat = S.chat;
  S.chat = chat;
  const conn = activeConn();
  app.innerHTML = `
    <header class="bar chat-bar" id="top-bar">
      <button class="icon-btn" data-action="go" data-to="#/" aria-label="Back">${ICONS.back}</button>
      <button class="chat-title" data-action="chat-menu">
        ${group ? groupAvatarHtml(groupMembers(), 'sm') : avatarHtml(char.avatar, char.name, 'av sm')}
        <span class="ct-text"><span class="ct-name">${esc(char.name)}</span><span class="ct-sub">${esc(group ? groupMembers().map((c) => c.name).join(', ') : (conn ? (conn.model || 'no model') : 'no connection'))}</span></span>
      </button>
      <button class="icon-btn" data-action="chat-menu" aria-label="Chat menu">${ICONS.dots}</button>
    </header>
    <div id="ndb-running-banner" class="ndb-running-banner" role="status" aria-live="polite" hidden></div>
    <div id="sheld">
      <div id="expr-panel" class="expr-panel" data-action="expr-toggle" hidden></div>
      <main class="scroll messages" id="chat"></main>
      <div id="attach-row" class="attach-row" hidden></div>
      ${qrBarHtml()}
      <footer class="composer" id="send_form">
        <div id="leftSendForm"><button class="qa-btn" id="options_button" data-action="quick-actions" aria-label="More actions">${ICONS.wand}</button>${S.settings.ext.vision.enabled ? `<button class="qa-btn" id="attach_button" data-action="attach" aria-label="Attach an image">${ICONS.image}</button>` : ''}</div>
        <textarea id="send_textarea" rows="1" placeholder="Message ${esc(char.name)}" enterkeyhint="${S.settings.ui.enterSends ? 'send' : 'enter'}"></textarea>
        <div id="rightSendForm">
          <button class="enh-btn" id="enh-btn" data-action="enhance" aria-label="Enhance reply" title="Enhance reply" hidden>✨</button>
          <button class="send-btn" id="send_but" data-action="send" aria-label="Send">${ICONS.send}</button>
        </div>
      </footer>
    </div>`;
  updateDatabaseBanner();
  const input = $('#send_textarea');
  input.value = getDraft(S.chat);
  autosize(input);
  input.addEventListener('input', () => { autosize(input); setDraft(S.chat.id, input.value); updateEnhanceButton(); });
  updateEnhanceButton();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (S.settings.ui.enterSends || !isTouch)) {
      e.preventDefault();
      sendMessage();
    }
  });
  renderMessages(true);
  updateSendButton();
  renderAttachRow();
  updateExpressionPanel();
  if (S.jumpTo && S.jumpTo.chatId === S.chat.id) {
    const el = $(`#chat .mes[data-id="${S.jumpTo.msgId}"]`);
    S.jumpTo = null;
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2400); }
  }
}

function renderAttachRow() {
  const row = $('#attach-row');
  if (!row) return;
  const imgs = (S.pending && S.pending.chatId === S.chat.id) ? S.pending.images : [];
  row.hidden = !imgs.length;
  row.innerHTML = imgs.map((src, i) => `<div class="att"><img src="${esc(src)}" alt=""><button data-action="attach-remove" data-i="${i}" aria-label="Remove">×</button></div>`).join('');
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.35)) + 'px';
}

function ctxNames() {
  return { char: S.char.name, user: activePersona().name || 'User' };
}

function msgHtml(msg, isLast) {
  const isUser = msg.role === 'user';
  const persona = activePersona();
  const speaker = speakerOf(msg);
  const name = isUser ? persona.name : speaker.name;
  const avatar = isUser ? persona.avatar : speaker.avatar;
  const raw = msg.swipes[msg.swipeIdx] || '';
  const generatingThis = S.generating === S.chat.id && isLast && !isUser;
  const reasoning = showThinking() ? (msg.reasoning && msg.reasoning[msg.swipeIdx]) || '' : '';
  const editing = S.editing === msg.id;
  const n = msg.swipes.length;
  const imgs = Array.isArray(msg.images) ? msg.images.filter(X.isSafeImageSrc) : [];
  const imagesHtml = imgs.length ? `<div class="mes-images">${imgs.map((src, i) => `<img class="mes-img" src="${esc(src)}" alt="" data-action="view-image" data-id="${msg.id}" data-i="${i}">`).join('')}</div>` : '';
  let body;
  if (editing) {
    body = `<textarea class="edit-box" id="edit-box">${esc(raw)}</textarea>
      <div class="row end"><button class="btn sm" data-action="edit-cancel">Cancel</button><button class="btn sm primary" data-action="edit-save" data-id="${msg.id}">Save</button></div>`;
  } else {
    const who = `is_user="${isUser}"`;
    body = raw ? `<div class="text mes_text" data-mid="${msg.id}" ${who}></div>`
      : (imgs.length ? '' : `<div class="text mes_text" ${who}>${generatingThis ? `<span class="typing"><i></i><i></i><i></i></span>${msg.generated ? ' <span class="muted small">creating an image…</span>' : ''}` : '<span class="muted">(empty)</span>'}</div>`);
  }
  const swipes = (msg.role === 'assistant' && !msg.generated && isLast && !editing && (n > 1 || !msg.greeting))
    ? `<div class="swipes">
        <button class="sw-btn swipe_left" data-action="swipe" data-dir="-1" ${msg.swipeIdx === 0 || generatingThis ? 'disabled' : ''} aria-label="Previous swipe">${ICONS.left}</button>
        <span class="swipes-counter">${msg.swipeIdx + 1}/${n}</span>
        <button class="sw-btn swipe_right" data-action="swipe" data-dir="1" ${generatingThis ? 'disabled' : ''} aria-label="Next swipe">${ICONS.right}</button>
      </div>` : '';
  const actions = S.openActions === msg.id && !editing ? `
    <div class="msg-actions">
      <button data-action="msg-edit" data-id="${msg.id}">${ICONS.edit}<span>Edit</span></button>
      <button data-action="msg-copy" data-id="${msg.id}">${ICONS.copy}<span>Copy</span></button>
      ${S.settings.ext.tts.enabled && raw ? `<button data-action="msg-speak" data-id="${msg.id}">${ICONS.speaker}<span>${speaking === msg.id ? 'Stop' : 'Speak'}</span></button>` : ''}
      ${S.settings.ext.translate.enabled && raw ? `<button data-action="msg-translate" data-id="${msg.id}">${ICONS.globe}<span>${msg.tr && msg.tr[msg.swipeIdx] ? (msg.showOriginal ? 'Show translation' : 'Show original') : 'Translate'}</span></button>` : ''}
      <button data-action="msg-hide" data-id="${msg.id}">${ICONS.eye}<span>${msg.hidden ? 'Unhide' : 'Hide'}</span></button>
      ${n > 1 ? `<button data-action="msg-del-swipe" data-id="${msg.id}">${ICONS.trash}<span>Delete swipe</span></button>` : ''}
      <span class="tok-count">≈${MEM.estTokens(raw)} tokens</span>
      ${!isUser && isLast ? `<button data-action="msg-regen" data-id="${msg.id}">${ICONS.refresh}<span>Redo</span></button>` : ''}
      <button data-action="msg-branch" data-id="${msg.id}">${ICONS.branch}<span>Branch</span></button>
      <button class="danger" data-action="msg-delete" data-id="${msg.id}">${ICONS.trash}<span>Delete</span></button>
    </div>` : '';
  const sp = isUser ? 'user' : (speaker && speaker.id) || '';
  const live = msg.audit && msg.audit.swipe === msg.swipeIdx;
  const isLiveAudit = live && S.liveAuditId === msg.id;
  // Markup mirrors SillyTavern's (#chat .mes .mes_block .ch_name .name_text …) so ST UI themes' custom CSS applies.
  const mesid = S.chat.messages.indexOf(msg);
  const when = msg.ts ? new Date(msg.ts).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  return `<div class="msg mes ${isUser ? 'user' : msg.role === 'system' ? 'sys smallSysMes' : 'char'}${msg.ghost || msg.hidden ? ' ghost' : ''}${isLast ? ' last_mes' : ''}" data-id="${msg.id}" data-sp="${esc(sp)}" mesid="${mesid}" swipeid="${msg.swipeIdx}" is_user="${isUser}" is_system="${msg.role === 'system'}" ch_name="${esc(name)}"${avatar ? '' : ' data-noav'}>
      <div class="mesAvatarWrapper"><div class="avatar">${avatarHtml(avatar, name, 'av sm')}</div></div>
      <div class="bubble mes_block" data-action="toggle-msg" data-id="${msg.id}">
        <div class="name ch_name"><div class="flex-container"><div class="alignItemsBaseline"><span class="name_text">${esc(name)}</span>${msg.ghost ? '<span class="ghost-tag" title="Covered by long-term memory; not sent to the AI">👻 in memory</span>' : ''}${msg.hidden ? '<span class="ghost-tag" title="Hidden from the AI">🙈 hidden</span>' : ''}${live ? `<span class="audit-tag" title="Continuity audited">✓${isLiveAudit ? ' ●' : ''}</span>` : ''}</div>${when ? `<small class="timestamp">${esc(when)}</small>` : ''}<small class="mesIDDisplay">#${mesid}</small></div></div>
        ${reasoning && !editing ? reasoningHtml(applyRegex(reasoning, scriptsFor(S.char), { placement: PLACEMENT.REASONING, isMarkdown: true }), generatingThis && !raw) : ''}
        ${imagesHtml}
        ${body}
        ${swipes}
      </div>
      ${actions}
    </div>`;
}

// Thinking is only shown when "Request & show reasoning" is on. Off, it stays
// hidden even if the model or API sends it anyway (or writes a <think> block).
const showThinking = () => !!(S.settings.preset && S.settings.preset.show_thoughts);

function reasoningHtml(text, thinking) {
  return `<details class="reasoning" ${thinking ? 'open' : ''}><summary>${thinking ? 'Thinking…' : 'Thought process'}</summary><div class="r-body">${esc(text)}</div></details>`;
}

function displayHtml(msg) {
  const msgs = S.chat.messages;
  const depth = msgs.length - 1 - msgs.indexOf(msg);
  const who = speakerOf(msg) || S.char;
  const env = { char: who.name, user: activePersona().name || 'User', vars: { ...(S.chat.vars || {}) } };
  const macro = (t) => evaluateMacros(t, env);
  const tr = msg.tr && msg.tr[msg.swipeIdx];
  let text = macro((tr && !msg.showOriginal ? tr.text : msg.swipes[msg.swipeIdx]) || '');
  text = applyRegex(text, scriptsFor(S.members.get(msg.charId) || S.char), { placement: msg.role === 'user' ? PLACEMENT.USER : PLACEMENT.AI, isMarkdown: true, depth, macro });
  return formatMessage(text);
}

function hydrateMessages(box) {
  box.querySelectorAll('.text[data-mid]').forEach((el) => {
    const msg = findMsg(el.dataset.mid);
    if (msg) renderInto(el, displayHtml(msg));
  });
}

function renderMessages(scrollBottom = false) {
  const box = $('#chat');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  // Remember where the reader is: the message being edited/opened, or else the
  // first one on screen, and how far it sits from the top of the chat. Redrawing
  // empties the chat for a moment, which would otherwise reset the scroll to the top.
  const boxTop = box.getBoundingClientRect().top;
  const focusId = S.editing || S.openActions;
  let anchor = focusId && box.querySelector(`.msg[data-id="${CSS.escape(focusId)}"]`);
  if (!anchor || anchor.getBoundingClientRect().bottom < boxTop || anchor.getBoundingClientRect().top > boxTop + box.clientHeight) {
    anchor = [...box.querySelectorAll('.msg[data-id]')].find((el) => el.getBoundingClientRect().bottom > boxTop + 1) || null;
  }
  const anchorId = anchor && anchor.dataset.id;
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - boxTop : 0;
  const msgs = S.chat.messages;
  const lc = liveContinuity(S.chat);
  S.liveAuditId = lc ? lc.msg.id : null;
  avatarCss();
  box.innerHTML = msgs.length
    ? msgs.map((m, i) => msgHtml(m, i === msgs.length - 1)).join('')
    : `<div class="empty muted">Say hello to ${esc(S.char.name)}.</div>`;
  hydrateMessages(box);
  const eb = $('#edit-box');
  if (eb) autosize(eb);
  const again = anchorId && box.querySelector(`.msg[data-id="${CSS.escape(anchorId)}"]`);
  // At the bottom: keep following the newest message (unless editing).
  if (scrollBottom || (nearBottom && !S.editing)) box.scrollTop = box.scrollHeight;
  else if (again) pinScroll(box, anchorId, anchorOffset, !!eb);
  if (eb) eb.focus({ preventScroll: true });
}

// Hold a message at the same spot on screen after a redraw. Re-applied for a
// moment because pictures and styled HTML can finish laying out a little later,
// and done instantly even when a theme turns on smooth scrolling.
let pinToken = 0;
function pinScroll(box, id, offset, editing) {
  const token = ++pinToken;
  let stop = false;
  const cancel = () => { stop = true; };
  box.addEventListener('touchstart', cancel, { once: true, passive: true });
  box.addEventListener('wheel', cancel, { once: true, passive: true });
  const apply = () => {
    if (stop || token !== pinToken) return;
    const el = box.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    const prev = box.style.scrollBehavior;
    box.style.scrollBehavior = 'auto';
    const b = box.getBoundingClientRect();
    box.scrollTop += el.getBoundingClientRect().top - b.top - offset;
    // Editing a long message you tapped near its end: show the top of the edit box.
    const eb = editing && el.querySelector('#edit-box');
    if (eb) { const r = eb.getBoundingClientRect(); if (r.top < b.top) box.scrollTop += r.top - b.top - 12; }
    box.style.scrollBehavior = prev;
  };
  apply();
  requestAnimationFrame(() => { apply(); requestAnimationFrame(apply); });
  [120, 350, 700].forEach((ms) => setTimeout(apply, ms));
  setTimeout(() => { box.removeEventListener('touchstart', cancel); box.removeEventListener('wheel', cancel); }, 800);
}

let streamRaf = 0;
function updateStreamingMessage(msg) {
  if (streamRaf) return;
  streamRaf = requestAnimationFrame(() => {
    streamRaf = 0;
    const box = $('#chat');
    if (!box || !S.generating || !S.chat || !S.chat.messages.includes(msg)) return;
    const el = box.querySelector(`.msg[data-id="${msg.id}"] .text`);
    if (!el) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const r = showThinking() ? (msg.reasoning && msg.reasoning[msg.swipeIdx]) || '' : '';
    if (r) {
      let d = box.querySelector(`.msg[data-id="${msg.id}"] details.reasoning`);
      if (!d) {
        el.insertAdjacentHTML('beforebegin', reasoningHtml(r, true));
        d = box.querySelector(`.msg[data-id="${msg.id}"] details.reasoning`);
      }
      d.querySelector('.r-body').textContent = r;
      const hasText = !!(msg.swipes[msg.swipeIdx] || '').trim();
      d.querySelector('summary').textContent = hasText ? 'Thought process' : 'Thinking…';
      if (hasText && d.dataset.autoClosed !== '1') { d.open = false; d.dataset.autoClosed = '1'; }
    }
    if ((msg.swipes[msg.swipeIdx] || '').length) renderInto(el, displayHtml(msg) + '<span class="cursor"></span>');
    if (nearBottom) box.scrollTop = box.scrollHeight;
  });
}

function updateSendButton() {
  const btn = $('#send_but');
  if (!btn) return;
  const busy = S.generating && S.chat && S.generating === S.chat.id;
  btn.innerHTML = busy ? ICONS.stop : ICONS.send;
  btn.classList.toggle('stop', !!busy);
  btn.dataset.action = busy ? 'stop' : 'send';
}

async function sendMessage() {
  if (S.generating) return toast('Wait for the current reply (or tap stop).');
  const input = $('#send_textarea');
  const text = input.value.trim();
  const chat = S.chat;
  if (text.startsWith('/') && /^\/[a-z#]/i.test(text)) {
    input.value = '';
    setDraft(chat.id, '');
    autosize(input);
    updateEnhanceButton();
    return runSlash(text);
  }
  unlockAudio();
  const images = (S.pending && S.pending.chatId === chat.id) ? S.pending.images.slice() : [];
  if (text || images.length) {
    const env = { char: S.char.name, user: activePersona().name, vars: { ...(chat.vars || {}) } };
    let finalText = applyRegex(text, scriptsFor(S.char), { placement: PLACEMENT.USER, macro: (t) => evaluateMacros(t, env) });
    const tcfg = S.settings.ext.translate;
    let original = null;
    if (tcfg.enabled && tcfg.input && finalText) {
      toast('Translating…', 10000);
      try { original = finalText; finalText = await translateText(finalText, tcfg.inputTarget || 'English'); toast('Translated', 1200); } catch (e) { toast('Translation failed, sending as written: ' + e.message, 5000); original = null; }
    }
    const um = { id: db.uid(), role: 'user', swipes: [finalText], swipeIdx: 0, ts: Date.now() };
    if (images.length) um.images = images;
    if (original) um.tr = { 0: { lang: 'original', text: original } };
    chat.messages.push(um);
    S.pending = null;
    renderAttachRow();
    input.value = '';
    setDraft(chat.id, '');
    autosize(input);
    updateEnhanceButton();
    await saveChat(chat);
    renderMessages(true);
  } else if (!chat.messages.length && !S.group) {
    return;
  }
  // Empty send with no pending user message: the character(s) just carry on (like SillyTavern).
  if (S.group && chat.groupId === S.group.id) await runGroupTurn(text);
  else await runGeneration('new');
}

/**
 * mode: 'new' (append a reply), 'swipe' (add an alternative to the last reply),
 *       'regen' (replace current swipe), 'continue' (extend the last reply)
 * speakerId: which group member speaks (group chats only)
 */
async function runGeneration(mode, speakerId) {
  const conn = activeConn();
  if (!connReady(conn)) {
    toast('Set up an API connection first (Settings → Connection).', 4000);
    return;
  }
  const chat = S.chat;
  const last = chat.messages[chat.messages.length - 1];
  let speaker = S.char;
  if (S.group && chat.groupId === S.group.id) {
    const id = speakerId || (mode !== 'new' && last && last.charId) || (activeMembers()[0] || {}).id;
    speaker = S.members.get(id);
    if (!speaker) { toast('No group member to speak.'); return; }
  }
  const char = cardForSpeaker(speaker);
  let msg;
  if (mode === 'new') {
    msg = { id: db.uid(), role: 'assistant', swipes: [''], swipeIdx: 0, ts: Date.now() };
    if (S.group && chat.groupId === S.group.id) { msg.charId = speaker.id; msg.name = speaker.name; }
    chat.messages.push(msg);
  } else {
    msg = last;
    if (!msg || msg.role !== 'assistant') return;
    if (msg.generated) { toast("That's a generated image — use ✨ → Generate image for another."); return; }
    if (mode === 'swipe') {
      msg.swipes.push('');
      msg.swipeIdx = msg.swipes.length - 1;
    } else if (mode === 'regen') msg.swipes[msg.swipeIdx] = '';
    msg.greeting = false;
  }
  if (!msg.reasoning) msg.reasoning = [];
  const idx = msg.swipeIdx;
  const original = mode === 'continue' ? (msg.swipes[idx] || '') : '';
  const postfix = mode === 'continue' && original && !/\s$/.test(original) ? continuePostfix() : '';
  const history = mode === 'continue' ? chat.messages.slice() : chat.messages.slice(0, chat.messages.indexOf(msg));
  let recall = '';
  try { recall = await computeRecall(chat, history); } catch (e) { toast(e.message, 5000); }
  const { messages, vars, timed, stats } = promptFor(chat, char, history, { mode: mode === 'continue' ? 'continue' : 'normal', recall });
  // Once per chat (per session): say so when the AI can barely see the chat.
  if (stats && stats.total > 4 && stats.included <= 2 && !(S.contextWarned || (S.contextWarned = new Set())).has(chat.id)) {
    S.contextWarned.add(chat.id);
    setTimeout(() => toast(`Heads up: the AI can only see the last ${stats.included} message${stats.included === 1 ? '' : 's'} of this chat, so it will forget recent details. Raise Context size in Settings → Generation (⋯ → View prompt shows why).`, 9000), 300);
  }
  chat.vars = vars;
  chat.wiTimed = timed;
  const prevReasoning = msg.reasoning[idx] || '';
  S.generating = chat.id;
  S.abort = new AbortController();
  S.openActions = null;
  renderMessages(true);
  updateSendButton();
  let failed = null;
  try {
    let produced = '';
    const text = await generate(conn, S.settings.preset, messages, {
      signal: S.abort.signal,
      ...genOptions(mode === 'continue' ? 'continue' : 'reply', speaker),
      onToken: (t, r) => {
        produced = t;
        msg.swipes[idx] = original + postfix + (original ? t : t.replace(/^\s+/, ''));
        if (r) msg.reasoning[idx] = r;
        updateStreamingMessage(msg);
      },
    });
    let out = (text || produced || '').replace(/^\s+/, '');
    // Group replies sometimes start with "Name:" — drop it.
    if (S.group && speaker.name) out = out.replace(new RegExp(`^${speaker.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`), '');
    msg.swipes[idx] = original ? original + (out ? postfix + out : '') : out;
    if (msg.swipes[idx] && out) {
      const env = { char: char.name, user: activePersona().name, vars: { ...(chat.vars || {}) } };
      msg.swipes[idx] = applyRegex(msg.swipes[idx], scriptsFor(char), { placement: PLACEMENT.AI, macro: (t) => evaluateMacros(t, env) });
    }
    if (msg.reasoning && msg.reasoning[idx]) {
      const env = { char: char.name, user: activePersona().name, vars: { ...(chat.vars || {}) } };
      msg.reasoning[idx] = applyRegex(msg.reasoning[idx], scriptsFor(char), { placement: PLACEMENT.REASONING, macro: (t) => evaluateMacros(t, env) });
    }
  } catch (e) {
    if (e.name !== 'AbortError') failed = e;
  } finally {
    S.generating = null;
    S.abort = null;
    cancelAnimationFrame(streamRaf);
    streamRaf = 0;
  }
  if (mode === 'continue' && !(msg.reasoning[idx] || '').trim()) msg.reasoning[idx] = prevReasoning;
  if (!msg.swipes[idx].trim()) {
    // Nothing generated: roll back the empty message / swipe.
    if (mode === 'new') chat.messages.splice(chat.messages.indexOf(msg), 1);
    else if (mode === 'swipe') {
      msg.swipes.splice(idx, 1);
      msg.reasoning.splice(idx, 1);
      msg.swipeIdx = Math.max(0, msg.swipes.length - 1);
    }
  }
  msg.ts = Date.now();
  await saveChat(chat);
  if (S.chat === chat) { renderMessages(); updateSendButton(); }
  if (failed) {
    console.error(failed);
    toast(failed.message || String(failed), 8000);
    S.stopGroup = true;
  } else if (msg.swipes[idx] && msg.swipes[idx].trim()) {
    maybeSummarize(chat);
    if (S.settings.ext.database.enabled) maybeDatabase(chat);
    else runAuditor(chat, msg).then(() => runMemory(chat, 'auto'));
    const ex = S.settings.ext;
    if (ex.expressions.enabled && ex.expressions.auto) classifyExpression(chat, msg);
    const afterTranslate = ex.translate.enabled && ex.translate.auto ? translateMessage(msg, chat) : Promise.resolve();
    if (ex.tts.enabled && ex.tts.auto && S.chat === chat) afterTranslate.then(() => speakMessage(msg));
  }
}

function continuePostfix() {
  const p = activePreset();
  const v = p ? (p.continue_postfix ?? (p.raw && p.raw.continue_postfix)) : undefined;
  return typeof v === 'string' ? v : ' ';
}

/** Write the user's next message with the AI, into the input box (ST "Impersonate"). */
async function runImpersonate() {
  if (S.generating) return;
  const conn = activeConn();
  if (!connReady(conn)) { toast('Set up an API connection first (Settings → Connection).', 4000); return; }
  const chat = S.chat;
  let speaker = S.char;
  if (S.group && chat.groupId === S.group.id) {
    const lastChar = [...chat.messages].reverse().find((m) => m.role !== 'user');
    speaker = S.members.get(lastChar && lastChar.charId) || activeMembers()[0];
    if (!speaker) return;
  }
  const { messages } = promptFor({ ...chat, vars: { ...(chat.vars || {}) } }, cardForSpeaker(speaker), chat.messages.slice(), { mode: 'impersonate' });
  const input = $('#send_textarea');
  S.generating = chat.id;
  S.abort = new AbortController();
  updateSendButton();
  input.value = '';
  input.placeholder = 'Writing as you…';
  try {
    const text = await generate(conn, S.settings.preset, messages, {
      signal: S.abort.signal,
      ...genOptions('impersonate', speaker),
      onToken: (t) => { if (S.chat === chat) { input.value = t.replace(/^\s+/, ''); autosize(input); } },
    });
    const name = activePersona().name;
    const out = (text || input.value || '').replace(/^\s+/, '').replace(new RegExp(`^${(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`), '');
    if (S.chat === chat) { input.value = out; setDraft(chat.id, out); autosize(input); }
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message || String(e), 8000);
  } finally {
    S.generating = null;
    S.abort = null;
    input.placeholder = `Message ${S.char.name}`;
    updateSendButton();
  }
}

function findMsg(id) {
  return S.chat.messages.find((m) => m.id === id);
}

async function swipe(dir) {
  if (S.generating) return;
  const msg = S.chat.messages[S.chat.messages.length - 1];
  if (!msg || msg.role !== 'assistant' || msg.generated) return;
  if (dir < 0) {
    if (msg.swipeIdx > 0) msg.swipeIdx--;
  } else if (msg.swipeIdx < msg.swipes.length - 1) {
    msg.swipeIdx++;
  } else {
    // Swiping right past the last alternative generates a new one (greetings just cycle).
    if (msg.greeting) return;
    return runGeneration('swipe', msg.charId);
  }
  await saveChat(S.chat);
  renderMessages();
}

// Horizontal swipe gesture on the last character message.
let touchStart = null;
document.addEventListener('touchstart', (e) => {
  const bubble = e.target.closest('#chat .msg.char:last-child .bubble');
  touchStart = bubble && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (!touchStart || S.editing) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart.x;
  const dy = t.clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) > 70 && Math.abs(dy) < 40) swipe(dx < 0 ? 1 : -1);
}, { passive: true });

function chatMenu() {
  const chats = S.chats.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  openSheet(`
    <div class="sheet-head">
      ${S.group ? groupAvatarHtml(groupMembers(), 'md') : avatarHtml(S.char.avatar, S.char.name, 'av md')}
      <div><div class="sh-title">${esc(S.char.name)}</div><div class="muted small">${chats.length} chat${chats.length === 1 ? '' : 's'}</div></div>
    </div>
    <div class="menu-grid">
      <button data-action="new-chat">${ICONS.plus}<span>New chat</span></button>
      <button data-action="go" data-to="#/${S.group ? 'group' : 'edit'}/${S.char.id}">${ICONS.edit}<span>Edit ${S.group ? 'group' : 'character'}</span></button>
      <button data-action="view-prompt">${ICONS.eye}<span>View prompt</span></button>
      <button data-action="go" data-to="#/search/${S.chat.id}">${ICONS.search}<span>Search this chat</span></button>
      ${activePreset() ? `<button data-action="go" data-to="#/preset/${activePreset().id}">${ICONS.sliders}<span>Prompt toggles</span></button>` : ''}
      ${S.group ? '' : `<button data-action="persona-lock">${ICONS.user}<span>${S.char.personaId === S.settings.activePersona ? `Unlock persona` : `Lock persona “${esc(activePersona().name)}”`}</span></button>`}
      <button data-action="export-chat">${ICONS.download}<span>Export chat</span></button>
      ${S.group ? '' : `<button data-action="import-chat">${ICONS.import}<span>Import ST chat</span></button>`}
      <button data-action="go" data-to="#/settings">${ICONS.gear}<span>Settings</span></button>
    </div>
    <h3 class="sheet-sub">Chats</h3>
    <div class="chat-list">
      ${chats.map((c) => {
        const last = c.messages[c.messages.length - 1];
        const preview = last ? macros(last.swipes[last.swipeIdx] || '', ctxNames()).replace(/\s+/g, ' ').slice(0, 90) : '';
        return `<div class="chat-row ${c.id === S.chat.id ? 'current' : ''}">
          <button class="chat-open" data-action="open-chat" data-id="${c.id}">
            <div class="cr-title">${esc(c.title)} <span class="muted small">· ${c.messages.length} msgs · ${timeAgo(c.updatedAt)}</span></div>
            <div class="cr-preview muted">${esc(preview)}</div>
          </button>
          <button class="icon-btn sm" data-action="rename-chat" data-id="${c.id}" aria-label="Rename">${ICONS.edit}</button>
          <button class="icon-btn sm danger" data-action="delete-chat" data-id="${c.id}" aria-label="Delete">${ICONS.trash}</button>
        </div>`;
      }).join('')}
    </div>`);
}

function quickActions() {
  const presets = S.presets;
  const last = S.chat.messages[S.chat.messages.length - 1];
  const note = S.chat.authorsNote;
  openSheet(`
    <div class="menu-grid">
      <button data-action="qa-continue" ${!last || last.role === 'user' ? 'disabled' : ''}>${ICONS.forward}<span>Continue</span></button>
      <button data-action="qa-impersonate">${ICONS.user}<span>Impersonate</span></button>
      <button data-action="qa-regen" ${!last || last.role === 'user' ? 'disabled' : ''}>${ICONS.refresh}<span>Regenerate</span></button>
      ${S.settings.ext.image.enabled ? `<button data-action="qa-image">${ICONS.image}<span>Generate image</span></button>` : ''}
      <button data-action="qa-note">${ICONS.note}<span>Author's Note${note && note.text && note.text.trim() ? ' •' : ''}</span></button>
      ${S.settings.ext.enhance.enabled ? `<button data-action="enhance">✨<span>Enhance draft</span></button>` : ''}
      ${S.enhanceOriginal && S.enhanceOriginal.chatId === S.chat.id ? `<button data-action="restore-draft">${ICONS.back}<span>Restore draft</span></button>` : ''}
      <button data-action="qa-summary">${ICONS.note}<span>Summary${S.chat.summary && S.chat.summary.text ? ' •' : ''}</span></button>
      ${S.settings.ext.memory.enabled || S.chat.mem ? `<button data-action="qa-memory">${ICONS.layers}<span>Memory</span></button>` : ''}
      ${S.settings.ext.database.enabled || S.chat.narrativeDb ? `<button data-action="qa-database">${ICONS.note}<span>Narrative Database</span></button>` : ''}
      <button data-action="view-prompt">${ICONS.eye}<span>View prompt</span></button>
      ${activePreset() ? `<button data-action="go" data-to="#/preset/${activePreset().id}">${ICONS.sliders}<span>Prompt toggles</span></button>` : ''}
    </div>
    ${S.group ? `
      <h3 class="sheet-sub">Make someone speak</h3>
      <div class="speak-row">
        ${groupMembers().map((c) => `<button data-action="speak" data-id="${c.id}">${avatarHtml(c.avatar, c.name, 'av md')}<span>${esc(c.name)}</span></button>`).join('')}
      </div>` : ''}
    <label class="field"><span class="label">Preset</span>
      <select data-change="select-preset">
        <option value="">Simple (built-in)</option>
        ${presets.map((x) => `<option value="${x.id}" ${S.settings.activePreset === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
      </select></label>
  `);
}

function authorsNoteSheet() {
  const n = S.chat.authorsNote || { text: '', depth: 4, role: 'system' };
  openSheet(`
    <div class="sheet-title">Author's Note</div>
    <p class="hint">Saved with this chat and inserted into the prompt every turn, ${'at'} the depth you choose (0 = after the last message). Macros work.</p>
    <label class="field"><textarea id="an-text" rows="6" placeholder="e.g. [Style: slow burn. {{char}} is hiding a secret.]">${esc(n.text)}</textarea></label>
    <div class="row wrap">
      <label class="field" style="width:110px"><span class="label">Depth</span><input id="an-depth" inputmode="numeric" value="${n.depth ?? 4}"></label>
      <label class="field grow"><span class="label">Role</span><select id="an-role">${['system', 'user', 'assistant'].map((r) => `<option ${n.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
    </div>
    <button class="btn primary block" data-action="an-save">Save</button>
  `);
}

function viewPrompt() {
  const history = S.chat.messages;
  const { messages, stats } = promptFor({ ...S.chat, vars: { ...(S.chat.vars || {}) } }, S.char, history);
  openSheet(`
    <div class="sheet-title">Prompt preview</div>
    <p class="muted small">Preset: <b>${esc(stats.preset)}</b>. ≈${stats.system} tokens of prompts/character info, ≈${stats.history} tokens of chat history.
      ${stats.included}/${stats.total} messages fit in the ${S.settings.preset.context_size}-token context.
      ${stats.worldInfo ? `${stats.worldInfo} lorebook entr${stats.worldInfo === 1 ? 'y' : 'ies'} active (≈${stats.worldInfoTokens} tokens).` : ''}</p>
    ${stats.total > 3 && stats.included < Math.min(stats.total, 6) ? `<p class="banner warn">The AI can only see the last ${stats.included} message${stats.included === 1 ? '' : 's'}. Older ones are cut to fit the ${S.settings.preset.context_size}-token context (≈${stats.reply} more are kept free for the reply). Raise <b>Context size</b> in Settings → Generation, use shorter replies, or turn off lorebooks you don't need.</p>` : ''}
    ${stats.worldInfoList && stats.worldInfoList.length ? `<details class="pv-lore"><summary class="muted small">Lorebook entries sent (${stats.worldInfoList.length})</summary><ul class="small">${stats.worldInfoList.map((e) => `<li>${esc(e.name)} <span class="muted">≈${e.tokens}</span></li>`).join('')}</ul></details>` : ''}
    ${messages.map((m) => `<div class="pv"><div class="pv-role">${m.role}</div><pre>${esc(m.content)}</pre></div>`).join('')}
  `, 'tall');
}

// Portable content fingerprint. Message IDs are regenerated on JSONL import, so
// Narrative Database checkpoints cannot use their old ID-based signatures.
function portableChatFingerprint(messages) {
  let hash = 2166136261;
  const mix = value => {
    for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  };
  for (const m of messages) {
    mix(m.role); mix('|'); mix(m.hidden ? '1' : '0'); mix('|');
    // SillyTavern JSONL exports user turns as one selected message, not swipes.
    const selected = (m.swipes || [])[m.swipeIdx || 0] ?? '';
    mix(JSON.stringify(m.role === 'user' ? [selected] : (m.swipes || [])));
    mix('|'); mix(m.role === 'user' ? 0 : (m.swipeIdx || 0)); mix('\n');
  }
  return (hash >>> 0).toString(16);
}

function exportChat(includeMemory = false) {
  const persona = activePersona();
  const metadata = {};
  if (includeMemory) {
    const chat = S.chat;
    metadata.pockettavern_memory = {
      version: 1,
      messageCount: chat.messages.length,
      messageFingerprint: portableChatFingerprint(chat.messages),
      ...(chat.narrativeDb?.text ? { narrativeDb: structuredClone(chat.narrativeDb) } : {}),
      ...(chat.summary?.text ? { summary: structuredClone(chat.summary) } : {}),
      ...(chat.authorsNote?.text ? { authorsNote: structuredClone(chat.authorsNote) } : {}),
    };
  }
  const lines = [JSON.stringify({ user_name: persona.name, character_name: S.char.name, create_date: new Date(S.chat.createdAt).toISOString(), chat_metadata: metadata })];
  for (const m of S.chat.messages) {
    const isUser = m.role === 'user';
    lines.push(JSON.stringify({
      name: isUser ? persona.name : (speakerOf(m) || S.char).name,
      is_user: isUser,
      is_system: !!m.hidden,
      ...(m.role === 'system' ? { extra: { type: 'narrator' } } : {}),
      send_date: new Date(m.ts || Date.now()).toISOString(),
      mes: m.swipes[m.swipeIdx] || '',
      ...(isUser ? {} : { swipes: m.swipes, swipe_id: m.swipeIdx }),
    }));
  }
  const suffix = includeMemory ? ' - with memory' : '';
  saveFile(new Blob([lines.join('\n')], { type: 'application/jsonl' }), `${safeName(S.char.name)} - ${safeName(S.chat.title)}${suffix}.jsonl`);
}

function exportChatChoice() {
  if (!S.chat?.narrativeDb?.text) return exportChat();
  openSheet(`
    <div class="sheet-title">Export Chat</div>
    <p class="hint">Choose a standard SillyTavern-compatible chat file, or include the saved Narrative Database and running summary for restoration in PocketTavern.</p>
    <div class="row wrap">
      <button class="btn" data-action="export-chat-standard">Export Chat</button>
      <button class="btn primary" data-action="export-chat-memory">Export with Summary Data</button>
    </div>
    <p class="hint">Both files use JSONL. Other apps may ignore the extra PocketTavern metadata.</p>
  `);
}

function restoreExportedChatMemory(chat, md) {
  const bundle = md?.pockettavern_memory;
  if (!bundle || bundle.version !== 1) return false;
  // Only restore checkpoints if the exported message contents and order survived.
  if (bundle.messageCount !== chat.messages.length ||
      bundle.messageFingerprint !== portableChatFingerprint(chat.messages)) return false;
  const src = bundle.narrativeDb;
  if (src && typeof src.text === 'string' && src.text.trim()) {
    const covered = Number(src.covered);
    if (Number.isInteger(covered) && covered >= 0 && covered <= chat.messages.length) {
      const checkpoints = Array.isArray(src.checkpoints) ? src.checkpoints
        .filter(c => c && typeof c.text === 'string' && Number.isInteger(c.covered) && c.covered >= 0 && c.covered <= covered)
        .slice(-20).map(c => ({...c, signature: NDB.fingerprint(chat.messages, c.covered)})) : [];
      chat.narrativeDb = {
        text: src.text, covered, checkpoints,
        signature: NDB.fingerprint(chat.messages, covered),
        at: Number(src.at) || Date.now(),
      };
    }
  }
  const summary = bundle.summary;
  if (summary && typeof summary.text === 'string' && summary.text.trim()) {
    chat.summary = {text: summary.text, upTo: Number.isInteger(summary.upTo)
      ? Math.max(0, Math.min(summary.upTo, chat.messages.length)) : chat.messages.length, at: Number(summary.at) || Date.now()};
  }
  if (bundle.authorsNote && typeof bundle.authorsNote.text === 'string') {
    chat.authorsNote = {
      text: bundle.authorsNote.text,
      depth: Number(bundle.authorsNote.depth) || 4,
      role: ['system','assistant','user'].includes(bundle.authorsNote.role) ? bundle.authorsNote.role : 'system',
    };
  }
  return !!(chat.narrativeDb || chat.summary);
}

async function importChat() {
  const [file] = await pickFile('file-chat');
  if (!file) return;
  try {
    const { messages: msgs, meta } = parseStChat(await file.text(), { uid: db.uid });
    if (!msgs.length) throw new Error('No messages found in that file');
    const now = Date.now();
    const chat = { id: db.uid(), charId: S.char.id, title: file.name.replace(/\.jsonl?$/i, '').slice(0, 60), createdAt: now, updatedAt: now, messages: msgs };
    const restored = restoreExportedChatMemory(chat, meta?.chat_metadata);
    await saveChat(chat);
    toast(`Imported ${msgs.length} messages${restored ? ' with summary data' : ''}`);
    go(`#/chat/${S.char.id}/${chat.id}`);
  } catch (e) {
    toast('Import failed: ' + e.message, 5000);
  }
}

// ---------- CHARACTER EDITOR ----------
const EDIT_FIELDS = [
  ['name', 'Name', 'input'],
  ['description', 'Description', 'Who the character is: appearance, background, personality. Supports {{char}} and {{user}}.'],
  ['first_mes', 'First message', 'The greeting that starts every new chat.'],
  ['personality', 'Personality summary', ''],
  ['scenario', 'Scenario', 'The situation the chat starts in.'],
  ['mes_example', 'Example dialogue', 'Separate examples with <START>.'],
  ['system_prompt', 'System prompt override', 'Replaces the main prompt for this character. Use {{original}} to include the main prompt.'],
  ['post_history_instructions', 'Post-history instructions', 'Sent after the chat history (a.k.a. jailbreak / author’s note). {{original}} includes the global one.'],
  ['creator_notes', 'Creator notes', 'Not sent to the AI.'],
];

async function fillSpriteGrid(charId) {
  const grid = $('#sprite-grid');
  if (!grid) return;
  const sp = await spritesOf(charId);
  const keys = Object.keys(sp).sort();
  grid.innerHTML = keys.length ? keys.map((k) => `<figure><img src="${esc(X.isSafeImageSrc(sp[k]) ? sp[k] : '')}" alt=""><figcaption>${esc(k)}</figcaption></figure>`).join('') : '<span class="hint">No sprites yet. They also come over from a SillyTavern zip import.</span>';
}

async function renderEditView(id) {
  if (!S.draft || S.draft._for !== id) {
    if (id === 'new') {
      S.draft = { _for: id, id: db.uid(), name: '', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', system_prompt: '', post_history_instructions: '', creator_notes: '', alternate_greetings: [], tags: [], creator: '', character_version: '', character_book: null, extensions: {}, avatar: null, isNew: true };
    } else {
      const c = await db.get('characters', id);
      if (!c) throw new Error('Character not found');
      S.draft = { ...structuredClone(c), _for: id };
    }
  }
  const d = S.draft;
  const book = d.character_book && d.character_book.entries;
  const bookCount = book ? (Array.isArray(book) ? book.length : Object.keys(book).length) : 0;
  const cardRx = Array.isArray(d.extensions && d.extensions.regex_scripts) ? d.extensions.regex_scripts.length : 0;
  app.innerHTML = `
    <header class="bar">
      <button class="icon-btn" data-action="edit-back" aria-label="Back">${ICONS.back}</button>
      <h1 class="title">${d.isNew ? 'New character' : 'Edit character'}</h1>
      <div class="spacer"></div>
      <button class="btn sm primary" data-action="char-save">Save</button>
    </header>
    <main class="scroll pad form">
      <div class="avatar-edit">
        <button class="avatar-pick" data-action="char-avatar" aria-label="Change avatar">${avatarHtml(d.avatar, d.name || '?', 'av xl')}<span class="small muted">Tap to change</span></button>
      </div>
      ${EDIT_FIELDS.map(([k, label, hint]) => `
        <label class="field">
          <span class="label">${label}</span>
          ${hint === 'input'
            ? `<input data-draft="${k}" value="${esc(d[k])}" autocomplete="off">`
            : `<textarea data-draft="${k}" rows="${k === 'description' || k === 'first_mes' ? 6 : 3}">${esc(d[k])}</textarea>`}
          ${hint && hint !== 'input' ? `<span class="hint">${esc(hint)}</span>` : ''}
        </label>`).join('')}
      <div class="field">
        <span class="label">Alternate greetings <span class="muted small">(swipe on the first message)</span></span>
        <div id="alt-greetings">
          ${(d.alternate_greetings || []).map((g, i) => `
            <div class="alt-row"><textarea data-alt="${i}" rows="3">${esc(g)}</textarea>
            <button class="icon-btn sm danger" data-action="alt-del" data-i="${i}" aria-label="Remove">${ICONS.trash}</button></div>`).join('')}
        </div>
        <button class="btn sm" data-action="alt-add">${ICONS.plus} Add greeting</button>
      </div>
      <div class="field"><span class="label">Character's Note <span class="hint">(inserted into the chat at a depth every turn; SillyTavern's depth prompt)</span></span>
        <textarea data-draft-dp="prompt" rows="3">${esc((d.extensions && d.extensions.depth_prompt && d.extensions.depth_prompt.prompt) || '')}</textarea>
        <div class="row wrap">
          <label class="field" style="width:100px"><span class="label">Depth</span><input data-draft-dp="depth" inputmode="numeric" value="${esc((d.extensions && d.extensions.depth_prompt && d.extensions.depth_prompt.depth) ?? 4)}"></label>
          <label class="field grow"><span class="label">Role</span><select data-draft-dp="role">${['system', 'user', 'assistant'].map((r) => `<option ${((d.extensions && d.extensions.depth_prompt && d.extensions.depth_prompt.role) || 'system') === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
        </div></div>
      <label class="field inline"><span class="label">Talkativeness<span class="hint">0–1, how often they speak up in group chats</span></span><input data-draft-talk inputmode="decimal" value="${esc((d.extensions && d.extensions.talkativeness) ?? 0.5)}"></label>
      ${S.settings.ext.tts.enabled ? `<div class="field"><span class="label">Voice <span class="hint">(text-to-speech)</span></span>
        <div class="row"><input data-draft="ttsVoice" value="${esc(d.ttsVoice || '')}" placeholder="Default voice" autocapitalize="off"><button class="btn" data-action="voices-char">Pick</button></div></div>` : ''}
      <div class="field"><span class="label">Expressions <span class="hint">(sprites named after emotions, e.g. joy.png, anger.png, neutral.png)</span></span>
        <div class="sprite-grid" id="sprite-grid"></div>
        <div class="row wrap"><button class="btn sm" data-action="sprites-add">${ICONS.plus} Add sprites</button><button class="btn sm danger" data-action="sprites-clear">Remove all</button></div></div>
      <label class="field"><span class="label">Persona for this character</span><select data-draft-persona>
        <option value="">No lock (use the current persona)</option>
        ${S.settings.personas.map((p) => `<option value="${p.id}" ${d.personaId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select></label>
      <label class="field"><span class="label">Tags <span class="muted small">(comma separated)</span></span>
        <input data-draft-tags value="${esc((d.tags || []).join(', '))}" autocomplete="off"></label>
      <label class="field"><span class="label">Creator</span><input data-draft="creator" value="${esc(d.creator)}" autocomplete="off"></label>
      <div class="field"><span class="label">Lorebooks</span>
        ${bookCount ? `<label class="check"><input type="checkbox" data-draft-flag="embedded" ${d.disableEmbeddedBook ? '' : 'checked'}> Embedded lorebook (${bookCount} entr${bookCount === 1 ? 'y' : 'ies'})</label>` : ''}
        ${S.lorebooks.map((b) => `<label class="check"><input type="checkbox" data-draft-book="${b.id}" ${(d.lorebooks || []).includes(b.id) ? 'checked' : ''}> ${esc(b.name)}${b.global ? ' <span class="hint">(global, always on)</span>' : ''}</label>`).join('')}
        ${!bookCount && !S.lorebooks.length ? '<span class="hint">No lorebooks yet. Import one from the home screen or Settings → Lorebooks.</span>' : ''}
      </div>
      ${cardRx ? `<div class="field"><span class="label">Regex</span><label class="check"><input type="checkbox" data-draft-flag="cardRegex" ${d.runCardRegex === false ? '' : 'checked'}> Run this card's ${cardRx} regex script${cardRx === 1 ? '' : 's'}</label></div>` : ''}
      ${d.isNew ? '' : `
      <div class="row wrap">
        <button class="btn" data-action="char-export-png">${ICONS.download} Export PNG card</button>
        <button class="btn" data-action="char-export-json">${ICONS.download} Export JSON</button>
        <button class="btn" data-action="char-duplicate">${ICONS.copy} Duplicate</button>
      </div>
      <button class="btn danger block" data-action="char-delete">${ICONS.trash} Delete character</button>`}
      <div class="bottom-space"></div>
    </main>`;
  fillSpriteGrid(d.id);
}

function collectDraft() {
  const d = S.draft;
  document.querySelectorAll('[data-draft]').forEach((el) => { d[el.dataset.draft] = el.value; });
  const tags = document.querySelector('[data-draft-tags]');
  if (tags) d.tags = tags.value.split(',').map((t) => t.trim()).filter(Boolean);
  const alts = [...document.querySelectorAll('[data-alt]')].map((el) => el.value);
  d.alternate_greetings = alts;
  const dpText = document.querySelector('[data-draft-dp="prompt"]');
  if (dpText) {
    d.extensions = { ...(d.extensions || {}) };
    const depth = Number(document.querySelector('[data-draft-dp="depth"]').value);
    d.extensions.depth_prompt = { prompt: dpText.value, depth: Number.isFinite(depth) ? depth : 4, role: document.querySelector('[data-draft-dp="role"]').value };
    const talk = Number(document.querySelector('[data-draft-talk]').value);
    if (Number.isFinite(talk)) d.extensions.talkativeness = Math.max(0, Math.min(1, talk));
    d.personaId = document.querySelector('[data-draft-persona]').value || null;
  }
  const books = document.querySelectorAll('[data-draft-book]');
  if (books.length) d.lorebooks = [...books].filter((el) => el.checked).map((el) => el.dataset.draftBook);
  const emb = document.querySelector('[data-draft-flag="embedded"]');
  if (emb) d.disableEmbeddedBook = !emb.checked;
  const crx = document.querySelector('[data-draft-flag="cardRegex"]');
  if (crx) d.runCardRegex = crx.checked;
  return d;
}

async function saveDraft() {
  const d = collectDraft();
  d.name = (d.name || '').trim();
  if (!d.name) return toast('The character needs a name.');
  const { _for, isNew, ...c } = d;
  c.alternate_greetings = c.alternate_greetings.filter((g) => g.trim());
  c.updatedAt = Date.now();
  if (isNew) c.createdAt = c.updatedAt;
  await db.put('characters', c);
  S.draft = null;
  toast('Saved');
  go(`#/chat/${c.id}`);
}

// ---------- SETTINGS ----------
// Saved keys are never shown again: just the last 4 characters as a hint.
const secretHint = (key, ph = '') => (key ? `Saved key ••••${String(key).slice(-4)} — type to replace` : ph);
function settingsField(label, path, type = 'number', attrs = '', hint = '') {
  const val = getPath(path);
  if (type === 'checkbox') {
    return `<label class="toggle"><span><span class="label">${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</span>
      <input type="checkbox" data-bind="${path}" ${val ? 'checked' : ''}><i></i></label>`;
  }
  if (type === 'textarea') {
    return `<label class="field"><span class="label">${label}</span><textarea data-bind="${path}" rows="5">${esc(val)}</textarea>${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
  }
  return `<label class="field ${type === 'number' ? 'inline' : ''}"><span class="label">${label}${hint ? `<span class="hint">${hint}</span>` : ''}</span>
    <input type="${type === 'number' ? 'text' : type}" ${type === 'number' ? 'inputmode="decimal" data-num' : ''} data-bind="${path}" value="${esc(val)}" ${attrs} autocomplete="off" autocapitalize="off" spellcheck="false"></label>`;
}

function getPath(path) {
  const [head, ...rest] = path.split('.');
  let obj = head === 'conn' ? activeConn() : head === 'persona' ? activePersona() : S.settings[head];
  for (const k of rest) obj = obj == null ? undefined : obj[k];
  return obj;
}
function setPath(path, value) {
  const [head, ...rest] = path.split('.');
  let obj = head === 'conn' ? activeConn() : head === 'persona' ? activePersona() : S.settings[head];
  if (!obj) return;
  for (const k of rest.slice(0, -1)) obj = obj[k];
  obj[rest[rest.length - 1]] = value;
}

/** Settings for the built-in versions of ST's bundled extensions. Inputs use data-x="group.key". */
function extSections() {
  const e = S.settings.ext;
  const tog = (path, label, hint = '') => { const [g, k] = path.split('.'); return `<label class="toggle"><span><span class="label">${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</span><input type="checkbox" data-x-toggle="${path}" ${e[g][k] ? 'checked' : ''}><i></i></label>`; };
  const txt = (path, label, hint = '', type = 'text', ph = '') => { const [g, k] = path.split('.'); return `<label class="field"><span class="label">${label}${hint ? ` <span class="hint">${hint}</span>` : ''}</span><span class="row"><input ${type === 'password' ? 'type="password" data-secret' : 'type="text"'} data-x="${path}" ${type === 'password' ? '' : `value="${esc(e[g][k] ?? '')}"`} placeholder="${esc(type === 'password' ? secretHint(e[g][k], ph) : ph)}" autocomplete="off" autocapitalize="off" spellcheck="false">${type === 'password' && e[g][k] ? `<button class="btn sm" data-action="secret-clear" data-path="ext.${path}">Remove</button>` : ''}</span></label>`; };
  const sel = (path, label, opts) => { const [g, k] = path.split('.'); return `<label class="field inline"><span class="label">${label}</span><select data-x-select="${path}">${Object.entries(opts).map(([v, l]) => `<option value="${v}" ${String(e[g][k]) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`; };
  return `
    <h4 class="sub">📷 Images in chat</h4>
    ${tog('vision.enabled', 'Attach photos', 'Adds a 🖼 button by the message box; photos go to vision models')}
    ${e.vision.enabled ? txt('vision.maxImages', 'Images sent per request', '(newest first)') : ''}

    <h4 class="sub">🎨 Image generation</h4>
    ${tog('image.enabled', 'Enabled', '✨ → Generate image, or /imagine scene | char | me | your description')}
    ${e.image.enabled ? `
      ${sel('image.provider', 'Service', { openrouter: 'OpenRouter (image models)', openai: 'OpenAI-compatible', pollinations: 'Pollinations (free, no key)' })}
      ${e.image.provider !== 'pollinations' ? txt('image.model', 'Model', '', 'text', e.image.provider === 'openrouter' ? 'google/gemini-2.5-flash-image' : 'gpt-image-1') : ''}
      ${e.image.provider === 'openai' ? txt('image.baseUrl', 'Base URL', '', 'text', 'https://api.openai.com/v1') : ''}
      ${e.image.provider !== 'pollinations' ? txt('image.apiKey', 'API key', e.image.provider === 'openrouter' ? '(blank = your OpenRouter connection)' : '', 'password') : ''}
      ${sel('image.aspect', 'Shape', { '1:1': 'Square', '2:3': 'Portrait', '3:2': 'Landscape', '9:16': 'Tall', '16:9': 'Wide' })}
      ${txt('image.style', 'Style', '(added to every prompt)', 'text', 'e.g. anime, soft lighting, detailed')}
      ${txt('image.negative', 'Avoid', '', 'text', 'e.g. text, watermark, extra fingers')}
      ${tog('image.writePrompt', 'Let the AI polish custom descriptions')}` : ''}

    <h4 class="sub">🔊 Text-to-speech</h4>
    ${tog('tts.enabled', 'Enabled', 'Adds “Speak” to messages')}
    ${e.tts.enabled ? `
      ${sel('tts.provider', 'Voices', { browser: 'Built-in (free, on device)', openai: 'OpenAI-compatible', elevenlabs: 'ElevenLabs' })}
      ${e.tts.provider === 'openai' ? txt('tts.baseUrl', 'Base URL', '', 'text', 'https://api.openai.com/v1') + txt('tts.model', 'Model', '', 'text', 'gpt-4o-mini-tts') : ''}
      ${e.tts.provider === 'elevenlabs' ? txt('tts.model', 'Model', '', 'text', 'eleven_multilingual_v2') : ''}
      ${e.tts.provider !== 'browser' ? txt('tts.apiKey', 'API key', '', 'password') : ''}
      <div class="field"><span class="label">Default voice</span><div class="row"><input data-x="tts.defaultVoice" value="${esc(e.tts.defaultVoice)}" autocapitalize="off"><button class="btn" data-action="voices-default">Pick</button></div></div>
      <div class="field"><span class="label">Narrator voice</span><div class="row"><input data-x="tts.narratorVoice" value="${esc(e.tts.narratorVoice)}" autocapitalize="off"><button class="btn" data-action="voices-narrator">Pick</button></div></div>
      ${txt('tts.rate', 'Speed', '(1 = normal)')}
      ${tog('tts.auto', 'Read new replies automatically')}
      ${tog('tts.dialogueOnly', 'Only read "dialogue"')}
      ${tog('tts.skipActions', 'Skip *actions*')}
      <button class="btn sm" data-action="tts-test">Test voice</button>
      <p class="hint">Give each character their own voice in Edit character.</p>` : ''}

    <h4 class="sub">🌐 Translation</h4>
    ${tog('translate.enabled', 'Enabled', 'Uses your chat model (or the one below); adds “Translate” to messages')}
    ${e.translate.enabled ? `
      ${txt('translate.target', 'Translate replies into', '', 'text', 'English')}
      ${tog('translate.auto', 'Translate new replies automatically', 'The AI still sees the original')}
      ${tog('translate.input', 'Translate my messages before sending')}
      ${e.translate.input ? txt('translate.inputTarget', 'Send my messages in', '', 'text', 'English') : ''}
      ${txt('translate.model', 'Model', '(optional; blank = chat model)')}` : ''}

    <h4 class="sub">🎭 Character expressions</h4>
    ${tog('expressions.enabled', 'Enabled', 'Shows the speaker’s sprite above the chat, matched to the mood of the reply')}
    ${e.expressions.enabled ? `
      ${tog('expressions.auto', 'Detect the mood after each reply', 'One tiny extra request per reply')}
      ${txt('expressions.model', 'Model', '(optional; a cheap fast one is ideal)')}
      <p class="hint">Add sprites in Edit character (files named joy.png, anger.png, neutral.png…) — they also come over from a SillyTavern zip. Tap the sprite to shrink it.</p>` : ''}

    <h4 class="sub">🔎 Chat recall <span class="muted small">(Vector Storage)</span></h4>
    ${tog('recall.enabled', 'Enabled', 'Brings relevant older moments back into the prompt')}
    ${e.recall.enabled ? `
      ${sel('recall.mode', 'Matching', { keyword: 'Keywords (free, on device)', embeddings: 'Embeddings (OpenAI-compatible)' })}
      ${e.recall.mode === 'embeddings' ? txt('recall.embBase', 'Embeddings URL', '', 'text', 'https://api.openai.com/v1') + txt('recall.embModel', 'Embeddings model', '', 'text', 'text-embedding-3-small') + txt('recall.embKey', 'API key', '', 'password') : ''}
      ${txt('recall.topK', 'Moments to recall')}
      ${txt('recall.skipRecent', 'Ignore the last N messages', '(they are already in the prompt)')}
      ${txt('recall.depth', 'Insert at depth')}
      ${txt('recall.minScore', 'Minimum match', '(0–1)')}` : ''}
    <hr class="sep">`;
}

function renderSettingsView(open) {
  const conn = activeConn();
  const persona = activePersona();
  const p = S.settings.preset;
  const sec = (id, title, body) => `<details class="section" data-sec="${id}" ${open === id ? 'open' : ''}><summary>${title}</summary><div class="sec-body">${body}</div></details>`;
  const connBody = `
    ${S.settings.connections.length ? `<div class="field"><span class="label">Profile</span>
      <div class="row"><select class="grow" data-change="select-conn">
        ${S.settings.connections.map((c) => `<option value="${c.id}" ${conn && c.id === conn.id ? 'selected' : ''}>${esc(c.name || PROVIDERS[c.provider].label)}</option>`).join('')}
      </select><button class="btn" data-action="conn-new">${ICONS.plus} New</button></div></div>` : `<button class="btn primary block" data-action="conn-new">${ICONS.plus} Add a connection</button>`}
    ${conn ? `
      ${settingsField('Name', 'conn.name', 'text')}
      <label class="field"><span class="label">Provider</span>
        <select data-change="conn-provider">
          ${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${conn.provider === k ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select></label>
      ${conn.provider === 'textcomp' ? `<label class="field"><span class="label">Server</span><select data-change="text-server">
          <option value="">Choose to fill in the usual address…</option>
          ${TEXT_SERVERS.map(([n, u], i) => `<option value="${i}">${esc(n)} (${esc(u)})</option>`).join('')}
        </select><span class="hint">Your phone needs an <b>https</b> address that reaches the server (a tunnel such as KoboldCpp's Remote Tunnel or Cloudflare Tunnel), and the server must allow browser (CORS) requests.</span></label>` : ''}
      ${PROVIDERS[conn.provider].needsUrl ? settingsField('Base URL', 'conn.baseUrl', 'url', 'placeholder="https://api.example.com/v1"', conn.provider === 'textcomp' ? 'Ends in /v1 (we add /completions).' : 'The URL that ends in /v1 (we add /chat/completions). Must be https and allow browser (CORS) requests.') : ''}
      <label class="field"><span class="label">API key${conn.provider === 'openrouter' ? '<span class="hint">Get one at openrouter.ai/keys</span>' : conn.provider === 'anthropic' ? '<span class="hint">Get one at console.anthropic.com</span>' : ''}</span>
        <span class="row"><input type="password" data-bind="conn.apiKey" data-secret id="api-key" placeholder="${esc(secretHint(conn.apiKey, 'sk-…'))}" autocomplete="off" autocapitalize="off" spellcheck="false">${conn.apiKey ? `<button class="btn sm" data-action="secret-clear" data-path="conn.apiKey">Remove</button>` : ''}</span></label>
      <div class="field"><span class="label">Model</span>
        <div class="row"><input data-bind="conn.model" value="${esc(conn.model)}" placeholder="${conn.provider === 'anthropic' ? 'claude-opus-5-5' : conn.provider === 'openrouter' ? 'anthropic/claude-opus-5.5' : 'model id'}" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="btn" data-action="browse-models">Browse</button></div></div>
      <div class="row wrap">
        <button class="btn primary" data-action="test-conn">Test connection</button>
        <button class="btn danger" data-action="delete-conn">Delete profile</button>
      </div>
      <p class="hint">Keys are stored only on this device and sent only to the provider you choose.</p>` : '<p class="muted">Add a connection to start chatting.</p>'}`;

  const ins = S.settings.instruct;
  const curT = currentInstruct();
  const savedT = (ins.saved || []).find((t) => t.id === ins.template);
  const fmtBody = `
    <p class="hint">Used by <b>Text completion</b> connections (local models). Chat APIs like OpenRouter and Claude format messages themselves and ignore this.</p>
    <label class="field"><span class="label">Instruct template</span><select data-change="instruct-template">
      ${Object.entries(INSTRUCT_TEMPLATES).map(([k, t]) => `<option value="${k}" ${ins.template === k ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
      ${(ins.saved || []).map((t) => `<option value="${t.id}" ${ins.template === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
    </select><span class="hint">Pick the one your model was trained on (it's usually on the model's page).</span></label>
    <details class="section"><summary>${savedT ? 'Edit template' : 'Template details'}</summary><div class="sec-body">
      ${INSTRUCT_FIELDS.map(([k, label]) => `<label class="field"><span class="label">${label}</span><textarea rows="1" data-ins="${k}" ${savedT ? '' : 'readonly'} spellcheck="false">${esc(curT[k] || '')}</textarea></label>`).join('')}
      <label class="field inline"><span class="label">Character names</span><select data-ins-select="names_behavior" ${savedT ? '' : 'disabled'}>
        ${[['force', 'Group chats only'], ['always', 'Always'], ['none', 'Never']].map(([v, l]) => `<option value="${v}" ${curT.names_behavior === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${savedT ? '' : '<p class="hint">Built-in templates are read-only — tap “Copy to edit”.</p>'}
      <div class="row wrap">
        <button class="btn sm" data-action="ins-copy">Copy to edit</button>
        ${savedT ? '<button class="btn sm danger" data-action="ins-delete">Delete</button>' : ''}
      </div>
    </div></details>
    <button class="btn" data-action="import-files">${ICONS.import} Import SillyTavern instruct template</button>`;

  const genBody = `
    ${settingsField('Max response tokens', 'preset.max_tokens')}
    ${settingsField('Context size (tokens)', 'preset.context_size', 'number', '', 'Older messages are dropped to fit')}
    <div class="cost-est hint" id="cost-est">${costEstimateHtml()}</div>
    ${settingsField('Stream replies', 'preset.stream', 'checkbox')}
    ${settingsField('Temperature', 'preset.temperature')}
    ${settingsField('Top P', 'preset.top_p')}
    ${settingsField('Top K', 'preset.top_k', 'number', '', '0 = off')}
    ${settingsField('Min P', 'preset.min_p', 'number', '', '0 = off')}
    ${settingsField('Frequency penalty', 'preset.frequency_penalty')}
    ${settingsField('Presence penalty', 'preset.presence_penalty')}
    ${settingsField('Repetition penalty', 'preset.repetition_penalty', 'number', '', '1 = off')}
    ${settingsField('Request & show reasoning', 'preset.show_thoughts', 'checkbox', '', "Shows the model's thinking in a box above replies (OpenRouter reasoning models; Claude 4.6 or newer). Off: thinking is never shown, even if the model sends it.")}
    ${settingsField('Auto-parse <think> blocks', 'preset.reasoning_parse', 'checkbox', '', 'Moves reasoning that a model writes at the start of its reply into the Thought process box')}
    <div class="row wrap">
      <label class="field grow"><span class="label">Reasoning prefix</span><input data-bind="preset.reasoning_prefix" value="${esc(p.reasoning_prefix || '<think>')}" autocapitalize="off" spellcheck="false"></label>
      <label class="field grow"><span class="label">Reasoning suffix</span><input data-bind="preset.reasoning_suffix" value="${esc(p.reasoning_suffix || '</think>')}" autocapitalize="off" spellcheck="false"></label>
    </div>
    ${settingsField('Stop when the AI writes as you', 'preset.stop_on_names', 'checkbox', '', 'Cuts the reply at a new line starting with “{{user}}:” (and other group members)')}
    ${settingsField('Custom stopping strings', 'preset.stop_strings', 'textarea', '', 'One per line. \\n = new line. Macros work, e.g. \\n{{user}}:')}
    <h4 class="sub">Claude (direct API)</h4>
    ${settingsField('Send temperature to Claude', 'preset.claude_sampling', 'checkbox', '', 'Only for older Claude models — current ones reject sampling settings.')}
    <label class="field inline"><span class="label">Reasoning effort<span class="hint">Claude direct, and OpenRouter (low–high)</span></span>
      <select data-bind="preset.claude_effort">
        ${['', 'low', 'medium', 'high', 'xhigh', 'max'].map((e) => `<option value="${e}" ${p.claude_effort === e ? 'selected' : ''}>${e || 'model default'}</option>`).join('')}
      </select></label>
    <button class="btn sm" data-action="reset-preset">Reset to defaults</button>`;

  const preset = activePreset();
  const presetBody = `
    <label class="field"><span class="label">Active preset</span>
      <select data-change="select-preset">
        <option value="">Simple (built-in)</option>
        ${S.presets.map((x) => `<option value="${x.id}" ${preset && preset.id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
      </select></label>
    ${preset ? `
      <p class="hint">${preset.order.filter((o) => o.enabled).length} of ${preset.order.length} prompts enabled.</p>
      <div class="row wrap">
        <button class="btn primary" data-action="go" data-to="#/preset/${preset.id}">${ICONS.sliders} Prompts & toggles</button>
        <button class="btn" data-action="preset-apply-samplers" data-id="${preset.id}">Apply its generation settings</button>
        <button class="btn" data-action="preset-export" data-id="${preset.id}">${ICONS.download} Export</button>
        <button class="btn danger" data-action="preset-delete" data-id="${preset.id}">${ICONS.trash} Delete</button>
      </div>` : '<p class="hint">Simple uses the main and post-history prompts from the Prompts section below. Import a SillyTavern chat-completion preset to use its full prompt manager.</p>'}
    <button class="btn" data-action="import-files">${ICONS.import} Import SillyTavern preset</button>`;

  const lorebookBody = `
    ${S.lorebooks.map((b) => {
      const where = [b.global ? 'global' : '', S.settings.personas.filter((x) => (x.lorebooks || []).includes(b.id)).map((x) => 'persona: ' + x.name).join(', ')].filter(Boolean).join(' · ');
      return `<div class="list-row">
        <button class="grow lr-btn" data-action="go" data-to="#/lorebook/${b.id}">
          <span class="lr-title">${esc(b.name)}</span>
          <span class="hint">${b.entries.length} entr${b.entries.length === 1 ? 'y' : 'ies'}${where ? ' · ' + esc(where) : ''}</span>
        </button>
        <span class="hint">Global</span>
        <label class="toggle mini"><input type="checkbox" data-lb-global="${b.id}" ${b.global ? 'checked' : ''}><i></i></label>
      </div>`;
    }).join('') || '<p class="muted">No lorebooks yet.</p>'}
    <p class="hint">Global lorebooks apply to every chat. You can also attach a lorebook to a persona (Persona section) or to a character (Edit character). Cards with embedded lorebooks work automatically.</p>
    <div class="row wrap">
      <button class="btn" data-action="import-files">${ICONS.import} Import</button>
      <button class="btn" data-action="lb-new">${ICONS.plus} New lorebook</button>
    </div>`;

  const regexBody = `
    ${S.regex.map((r, i) => `<div class="list-row">
      <label class="toggle mini"><input type="checkbox" data-rx-toggle="${i}" ${r.disabled ? '' : 'checked'}><i></i></label>
      <button class="grow lr-btn" data-action="rx-edit" data-i="${i}">
        <span class="lr-title">${esc(r.scriptName)}</span>
        <span class="hint">${r.placement.map((x) => PLACEMENT_LABELS[x] || x).join(', ')}${r.markdownOnly ? ' · chat display' : ''}${r.promptOnly ? ' · outgoing prompt' : ''}</span>
      </button>
    </div>`).join('') || '<p class="muted">No regex scripts yet.</p>'}
    <p class="hint">Scripts embedded in character cards run too (toggle per character in Edit character).</p>
    <div class="row wrap">
      <button class="btn" data-action="import-files">${ICONS.import} Import</button>
      <button class="btn" data-action="rx-new">${ICONS.plus} New script</button>
    </div>`;

  const promptBody = `
    <p class="hint">The main and post-history prompts are used by the Simple preset. The two “Use character’s…” switches and the scan depth apply to every preset.</p>
    ${settingsField('Main prompt', 'prompt.main', 'textarea', '', 'Sent first, before the character description.')}
    <button class="btn sm" data-action="reset-main">Reset main prompt</button>
    ${settingsField('Post-history instructions', 'prompt.post_history', 'textarea', '', 'Sent after the chat history, every turn (a.k.a. jailbreak / author’s note).')}
    ${settingsField('Use character’s system prompt', 'prompt.prefer_card_system', 'checkbox', '', 'If a card has one, it replaces the main prompt.')}
    ${settingsField('Use character’s post-history instructions', 'prompt.prefer_card_post_history', 'checkbox')}
    ${settingsField('Lorebook scan depth', 'prompt.wi_scan_depth', 'number', '', 'How many recent messages are scanned for keywords')}
    ${settingsField('Lorebook budget (% of context)', 'prompt.wi_budget', 'number', '', '0 = no limit. Lower-order entries are dropped first')}
    ${settingsField('Recursive lorebook scan', 'prompt.wi_recursion', 'checkbox', '', 'Entries can trigger other entries')}
    ${settingsField('Max recursion steps', 'prompt.wi_max_recursion', 'number', '', '0 = unlimited')}`;

  const personaBody = `
    <label class="field"><span class="label">Active persona</span>
      <select data-change="select-persona">
        ${S.settings.personas.map((x) => `<option value="${x.id}" ${x.id === persona.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
        <option value="__new">+ New persona…</option>
      </select></label>
    <div class="row"><button class="avatar-pick" data-action="persona-avatar">${avatarHtml(persona.avatar, persona.name, 'av lg')}</button>
      <div class="grow">${settingsField('Your name', 'persona.name', 'text')}</div></div>
    ${settingsField('Description', 'persona.description', 'textarea', '', 'Who you are in the story. Sent to the AI.')}
    <div class="field"><span class="label">Lorebooks for this persona</span>
      ${S.lorebooks.map((b) => `<label class="check"><input type="checkbox" data-persona-book="${b.id}" ${(persona.lorebooks || []).includes(b.id) ? 'checked' : ''}> ${esc(b.name)}</label>`).join('') || '<span class="hint">No lorebooks imported yet.</span>'}
    </div>
    <div class="row wrap">
      <button class="btn sm" data-action="persona-import">${ICONS.import} Import persona</button>
      <button class="btn sm" data-action="persona-export">${ICONS.download} Export persona</button>
      ${S.settings.personas.length > 1 ? '<button class="btn sm danger" data-action="delete-persona">Delete persona</button>' : ''}
    </div>
    <p class="hint">Import a persona file, a SillyTavern persona backup (.json), or any character card (.png/.json) to use as yourself. Export saves this persona as a card others can import.</p>`;

  const en = S.settings.ext.enhance;
  const mm = S.settings.ext.memory;
  const ap = S.settings.appearance;
  const pal = paletteOf(ap);
  const apBody = `
    <label class="field"><span class="label">Theme</span><select data-ap-select="theme">
      ${Object.entries(THEMES).map(([k, t]) => `<option value="${k}" ${ap.theme === k ? 'selected' : ''}>${t.name}</option>`).join('')}
      ${(ap.saved || []).map((t) => `<option value="${t.id}" ${ap.theme === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
    </select></label>
    <span class="label">Chat style</span>
    <div class="style-grid">
      ${Object.entries(CHAT_STYLES).map(([k, v]) => `<button class="${ap.chatStyle === k ? 'on' : ''}" data-action="ap-style" data-v="${k}"><b>${v.label}</b><span>${v.hint}</span></button>`).join('')}
    </div>
    ${(ap.saved || []).some((t) => t.id === ap.theme && t.hasCss) ? `<label class="toggle"><span><span class="label">Use this theme's custom CSS</span><span class="hint">Written for SillyTavern's layout; most of it carries over. Turn off if something looks broken.</span></span><input type="checkbox" data-ap-toggle="useThemeCss" ${ap.useThemeCss !== false ? 'checked' : ''}><i></i></label>` : ''}
    <label class="toggle"><span><span class="label">Show timestamps</span></span><input type="checkbox" data-ap-toggle="timestamps" ${ap.timestamps ? 'checked' : ''}><i></i></label>
    <label class="field inline"><span class="label">Avatar shape</span><select data-ap-select="avatarShape">
      ${Object.entries(AVATAR_SHAPES).map(([k, v]) => `<option value="${k}" ${ap.avatarShape === k ? 'selected' : ''}>${v}</option>`).join('')}
    </select></label>
    <details class="section"><summary>Colors</summary><div class="sec-body">
      ${COLOR_FIELDS.map(([k, label]) => `<div class="color-row"><span class="swatch" style="background:${esc(pal[k])}"></span><span class="label">${label}</span>
        <input type="text" data-ap-color="${k}" value="${esc((ap.colors || {})[k] || '')}" placeholder="${esc(pal[k])}" autocapitalize="off" spellcheck="false"></div>`).join('')}
      <p class="hint">Any CSS color: #hex, rgb(), rgba() with transparency…</p>
      <button class="btn sm" data-action="ap-reset-colors">Reset to theme colors</button>
    </div></details>
    <div class="field"><span class="label">Background image</span>
      <div class="row wrap"><button class="btn sm" data-action="ap-bg">${ap.bgImage ? 'Change' : 'Choose'} image</button>${ap.bgImage ? '<button class="btn sm danger" data-action="ap-bg-remove">Remove</button>' : ''}</div></div>
    ${ap.bgImage ? `<label class="field inline"><span class="label">Darken<span class="hint">0–1</span></span><input inputmode="decimal" data-ap-num="bgDim" value="${ap.bgDim}"></label>
      <label class="field inline"><span class="label">Blur<span class="hint">px</span></span><input inputmode="numeric" data-ap-num="bgBlur" value="${ap.bgBlur}"></label>` : ''}
    <details class="section"><summary>Custom CSS</summary><div class="sec-body">
      <textarea data-ap-css rows="6" spellcheck="false" placeholder=".bubble { border-radius: 4px; }">${esc(ap.customCss || '')}</textarea>
    </div></details>
    <div class="row wrap">
      <button class="btn" data-action="ap-save">Save as theme</button>
      <button class="btn" data-action="ap-export">${ICONS.download} Export</button>
      <button class="btn" data-action="import-files">${ICONS.import} Import theme</button>
      ${(ap.saved || []).some((t) => t.id === ap.theme) ? `<button class="btn danger" data-action="ap-delete">${ICONS.trash} Delete theme</button>` : ''}
    </div>
    <p class="hint">Imports SillyTavern UI themes and Moonlit Echoes presets (e.g. “[Moonlit] Glimmer”). Exports load in SillyTavern too. Chat styles also switch with /echostyle, /whisperstyle… or /chatstyle name.</p>`;
  const sm = S.settings.ext.summarize;
  const nd = S.settings.ext.database;
  const tog = (attr, key, on, label, hint = '') => `<label class="toggle"><span><span class="label">${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</span><input type="checkbox" ${attr}="${key}" ${on ? 'checked' : ''}><i></i></label>`;
  const extBody = `
    <h4 class="sub">✨ Enhance My Reply</h4>
    ${tog('data-ext-enhance-toggle', 'enabled', en.enabled, 'Enabled', 'Shows ✨ next to the message box when you have a draft')}
    <label class="field"><span class="label">Enhancement prompt</span><textarea data-ext-enhance="prompt" rows="6">${esc(en.prompt)}</textarea></label>
    <button class="btn sm" data-action="enhance-reset">Reset prompt</button>
    ${ENHANCE_TOGGLES.map(([k, label, hint]) => tog('data-ext-enhance-toggle', k, en[k], label, hint)).join('')}
    <p class="hint">Uses the chat context plus your current connection, model, preset and generation settings. The result replaces your draft but isn't sent.</p>
    <h4 class="sub">📝 Summarize</h4>
    ${tog('data-ext-sum-toggle', 'enabled', sm.enabled, 'Enabled', 'Keeps a running summary of each chat and adds it to the prompt')}
    <label class="field inline"><span class="label">Update every<span class="hint">messages</span></span><input inputmode="numeric" data-ext-sum="every" value="${sm.every}"></label>
    <label class="field inline"><span class="label">Summary length<span class="hint">words</span></span><input inputmode="numeric" data-ext-sum="words" value="${sm.words}"></label>
    <label class="field inline"><span class="label">Insert</span><select data-ext-sum-select="position">
      ${[['top', 'At the top of the prompt'], ['depth', 'In chat @ depth'], ['macro', 'Only via {{summary}}']].map(([k, v]) => `<option value="${k}" ${sm.position === k ? 'selected' : ''}>${v}</option>`).join('')}
    </select></label>
    ${sm.position === 'depth' ? `<label class="field inline"><span class="label">Depth</span><input inputmode="numeric" data-ext-sum="depth" value="${sm.depth}"></label>` : ''}
    <label class="field"><span class="label">Injection template</span><input data-ext-sum="template" value="${esc(sm.template)}"></label>
    <label class="field"><span class="label">Summary prompt</span><textarea data-ext-sum="prompt" rows="5">${esc(sm.prompt)}</textarea></label>
    <p class="hint">Edit or refresh a chat's summary from ✨ → Summary. Your preset can use it anywhere with {{summary}}.</p>
    ${extSections()}
    <h4 class="sub">📚 Narrative Database <span class="muted small">(cumulative continuity)</span></h4>
    ${tog('data-ext-ndb-toggle', 'enabled', nd.enabled, 'Enabled', 'Third memory mode: structured rolling database, independently stored from Summaryception and Summarize')}
    <label class="field inline"><span class="label">Update every (new RP tokens)<span class="hint">Default 8,000. The banner at the top of chat stays visible while an update runs.</span></span><input inputmode="numeric" data-ext-ndb="batchTokens" value="${nd.batchTokens}"></label>
    <label class="field inline"><span class="label">Keep verbatim (recent RP tokens)</span><input inputmode="numeric" data-ext-ndb="recentTokens" value="${nd.recentTokens}"></label>
    <label class="field inline"><span class="label">Max database output tokens</span><input inputmode="numeric" data-ext-ndb="maxOutputTokens" value="${nd.maxOutputTokens}"></label>
    <label class="field"><span class="label">Summarizer model (optional, blank = current model)</span><input data-ext-ndb="model" value="${esc(nd.model)}" autocapitalize="off"></label>
    <label class="field inline"><span class="label">Insert database</span><select data-ext-ndb-select="position">
      ${[['before','Before the main prompt'],['prompt','After the main prompt'],['chat','In chat @ depth']].map(([k,v])=>`<option value="${k}" ${nd.position===k?'selected':''}>${v}</option>`).join('')}
    </select></label>
    ${nd.position === 'chat' ? `<label class="field inline"><span class="label">Depth</span><input inputmode="numeric" data-ext-ndb="depth" value="${nd.depth}"></label>` : ''}
    <details class="section"><summary>Database update prompt and injection template</summary><div class="sec-body">
      <label class="field"><span class="label">Complete database update prompt</span><textarea rows="12" data-ext-ndb="prompt">${esc(nd.prompt)}</textarea></label>
      <label class="field"><span class="label">Injection template (use {{database}})</span><textarea rows="3" data-ext-ndb="template">${esc(nd.template)}</textarea></label>
      <button class="btn ndb-reset-prompt-btn" data-action="ndb-reset-prompt">Restore default update prompt (0.22.7 · same 0.14 prompt)</button>
      <p class="hint">Version 0.22.7 preserves the original 0.14 update prompt. Validation rejects incomplete-memory placeholders, automatically retries a malformed response once, checks protected continuity, and retains the last good checkpoint on failure. The Recent Log may be empty. Saved custom prompts are unchanged.</p>
    </div></details>
    <div id="ndb-settings-progress" class="ndb-running-banner" hidden></div>
    <button class="btn ndb-manage-btn" data-action="qa-database">Manage Narrative Database / Rebuild from Chat History</button>
    <p class="hint">Choose only one memory mode at a time. Switching modes retains each mode's stored data. Narrative Database does not modify the original messages.</p>
    <h4 class="sub">🧠 Layered memory <span class="muted small">(Summaryception)</span></h4>
    ${tog('data-ext-mem-toggle', 'enabled', mm.enabled, 'Enabled', 'Recent chat stays word-for-word; older chat becomes layered memories and is “ghosted” (still visible to you, not sent)')}
    <label class="field inline"><span class="label">Memory mode</span><select data-ext-mem-select="mode">
      ${Object.entries(MEM.MEMORY_MODES).map(([k, v]) => `<option value="${k}" ${mm.mode === k ? 'selected' : ''}>${v.label}${v.verbatim ? ` (${v.verbatim / 1000}k + ${v.queued / 1000}k)` : ''}</option>`).join('')}
    </select></label>
    ${mm.mode === 'custom' ? `
      <label class="field inline"><span class="label">Verbatim tokens</span><input inputmode="numeric" data-ext-mem="verbatim" value="${mm.verbatim}"></label>
      <label class="field inline"><span class="label">Queued tokens<span class="hint">overflow before summarizing</span></span><input inputmode="numeric" data-ext-mem="queued" value="${mm.queued}"></label>` : ''}
    <label class="field inline"><span class="label">Memory budget<span class="hint">tokens of injected memory</span></span><input inputmode="numeric" data-ext-mem="memoryBudget" value="${mm.memoryBudget}"></label>
    <label class="field inline"><span class="label">Insert memory</span><select data-ext-mem-select="position">
      ${[['before', 'Before the prompt'], ['prompt', 'After the main prompt'], ['chat', 'In chat @ depth'], ['macro', 'Only via {{summaryception_memory}}']].map(([k, v]) => `<option value="${k}" ${mm.position === k ? 'selected' : ''}>${v}</option>`).join('')}
    </select></label>
    ${mm.position === 'chat' ? `<label class="field inline"><span class="label">Depth</span><input inputmode="numeric" data-ext-mem="depth" value="${mm.depth}"></label>` : ''}
    <label class="field"><span class="label">Summarizer model <span class="hint">(optional, same connection; blank = chat model)</span></span><input data-ext-mem="model" value="${esc(mm.model)}" placeholder="e.g. a cheaper, fast model" autocapitalize="off"></label>
    ${tog('data-ext-mem-toggle', 'auditor', mm.auditor, 'Continuity Auditor', 'After each reply (1:1 chats), tracks scene, bonds (sparks/grudge → hug, handhold, kiss…), agendas and secrets in an <active_continuity> block')}
    ${mm.auditor ? `<label class="field"><span class="label">Auditor model <span class="hint">(optional; a fast one is best)</span></span><input data-ext-mem="auditorModel" value="${esc(mm.auditorModel)}" autocapitalize="off"></label>` : ''}
    <details class="section"><summary>Memory prompts</summary><div class="sec-body">
      <label class="field"><span class="label">Layer 0 summary</span><textarea data-ext-mem="l0Prompt" rows="7">${esc(mm.l0Prompt)}</textarea></label>
      <label class="field"><span class="label">Merge (deeper layers)</span><textarea data-ext-mem="mergePrompt" rows="6">${esc(mm.mergePrompt)}</textarea></label>
      <label class="field"><span class="label">Continuity auditor</span><textarea data-ext-mem="auditorPrompt" rows="8">${esc(mm.auditorPrompt)}</textarea></label>
      <button class="btn sm" data-action="mem-reset-prompts">Reset prompts</button>
    </div></details>
    <p class="hint">Manage a chat's memory from ✨ → Memory, or with /sc-status, /sc-preview, /sc-clear.</p>
    <p class="hint">Other SillyTavern extensions can't be installed directly (they run code inside SillyTavern itself), but popular ones can be rebuilt here — ask!</p>`;

  const qrBody = `
    ${S.qr.map((q) => `<div class="list-row">
      <button class="grow lr-btn" data-action="go" data-to="#/qr/${q.id}">
        <span class="lr-title">${esc(q.name)}</span>
        <span class="hint">${q.buttons.length} button${q.buttons.length === 1 ? '' : 's'}</span>
      </button>
      <span class="hint">Show</span>
      <label class="toggle mini"><input type="checkbox" data-qr-toggle="${q.id}" ${q.visible !== false ? 'checked' : ''}><i></i></label>
    </div>`).join('') || '<p class="muted">No quick reply sets yet.</p>'}
    <div class="row wrap">
      <button class="btn" data-action="import-files">${ICONS.import} Import ST set</button>
      <button class="btn" data-action="qr-new">${ICONS.plus} New set</button>
    </div>`;

  const uiBody = `
    ${settingsField('Enter key sends', 'ui.enterSends', 'checkbox', '', 'Off: use the send button on phones')}
    ${settingsField('Font size', 'ui.fontSize')}
    ${settingsField('Allow external media', 'ui.allowExternalMedia', 'checkbox', '', 'Off (like SillyTavern): images, video and fonts from other websites inside messages and themes are blocked, so a card or prompt can\'t use them to track you or leak chat text. Turn on if a card\'s pictures are hosted online. The app reloads.')}`;

  const dataBody = `
    <div class="field"><span class="label">Move over from SillyTavern</span>
      <span class="hint">Zip your SillyTavern data folder (SillyTavern/data/default-user — on Windows: right-click → Send to → Compressed folder; on Mac: right-click → Compress), send it to your phone, then import it here. Characters, chats, group chats, personas, lorebooks, presets, regex, your active theme and quick replies come over in one go. Anything you already have is skipped.</span>
      <button class="btn primary" data-action="import-zip">${ICONS.import} Import SillyTavern data (.zip)</button>
    </div>
    <div class="row wrap">
      <button class="btn" data-action="backup-export">${ICONS.download} Export backup / sync file</button>
      <button class="btn" data-action="backup-import">${ICONS.import} Restore / sync from file</button>
    </div>
    <p class="hint"><b>Using two devices?</b> Export here and save the file to cloud storage like iCloud Drive or Google Drive (or send it over with AirDrop / Quick Share). On the other device, “Restore / sync from file” merges it in — for every character, chat, preset or lorebook the newer copy wins and nothing is deleted. Then export there and sync back the same way. Deletions don't carry over.</p>
    <p class="hint" id="storage-info">Everything is stored on this device only. Export a backup now and then.</p>
    <button class="btn danger sm" data-action="wipe">Delete all data</button>`;

  app.innerHTML = `
    <header class="bar">
      <button class="icon-btn" data-action="go-back" aria-label="Back">${ICONS.back}</button>
      <h1 class="title">Settings</h1>
    </header>
    <main class="scroll pad">
      ${sec('connection', 'API connection', connBody)}
      ${sec('preset', 'Preset (prompt manager)', presetBody)}
      ${sec('generation', 'Generation', genBody)}
      ${sec('formatting', 'Formatting (text completion)', fmtBody)}
      ${sec('persona', 'Persona (you)', personaBody)}
      ${sec('lorebooks', 'Lorebooks', lorebookBody)}
      ${sec('regex', 'Regex scripts', regexBody)}
      ${sec('qr', 'Quick replies', qrBody)}
      ${sec('ext', 'Extensions', extBody)}
      ${sec('prompt', 'Prompts (Simple preset)', promptBody)}
      ${sec('appearance', 'Appearance', apBody)}
      ${sec('ui', 'Interface', uiBody)}
      ${sec('data', 'Data & backup', dataBody)}
      <p class="muted small center">${BUILD_NAME} — ${VERSION}</p>
      <div class="bottom-space"></div>
    </main>`;

  updateDatabaseBanner();
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(async (est) => {
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      const el = $('#storage-info');
      if (el) el.textContent = `Stored on this device only: ${(est.usage / 1048576).toFixed(1)} MB used${persisted ? ', protected from automatic cleanup' : ''}. Export a backup now and then.`;
    }).catch(() => {});
  }
}

function rerenderSettings() {
  const open = [...document.querySelectorAll('details.section[open]')].map((d) => d.dataset.sec)[0];
  const scroll = $('main.scroll')?.scrollTop || 0;
  renderSettingsView(open);
  document.querySelectorAll('details.section').forEach((d) => { if (d.dataset.sec === open) d.open = true; });
  const m = $('main.scroll');
  if (m) m.scrollTop = scroll;
}

function newConnection() {
  const c = { id: db.uid(), name: 'OpenRouter', provider: 'openrouter', baseUrl: '', apiKey: '', model: '' };
  S.settings.connections.push(c);
  S.settings.activeConnection = c.id;
  saveSettings();
}

// ---------- cost estimate (like SillyTavern's "Max prompt cost") ----------
// Prices come from OpenRouter's model list (dollars per token), fetched once and
// kept on the device for a day.
let priceCache = null; // { at, models: { id: [in, out] } }
let priceLoading = null;
function loadPrices() {
  if (priceLoading) return priceLoading;
  const conn = activeConn();
  if (!conn || conn.provider !== 'openrouter') return Promise.resolve(null);
  priceLoading = (async () => {
    if (!priceCache) { try { priceCache = await db.get('kv', 'model-prices'); } catch { priceCache = null; } }
    if (!priceCache || Date.now() - priceCache.at > 864e5) {
      const list = await listModels(conn);
      priceCache = { at: Date.now(), models: Object.fromEntries(list.filter((m) => m.inPrice != null).map((m) => [m.id, [m.inPrice, m.outPrice || 0]])) };
      db.put('kv', priceCache, 'model-prices').catch(() => {});
    }
    return priceCache;
  })().catch(() => null).finally(() => { priceLoading = null; });
  return priceLoading;
}

const money = (x) => (x === 0 ? '$0' : x < 0.001 ? '<$0.001' : `$${x < 0.1 ? x.toFixed(3) : x.toFixed(2)}`);

function costEstimateHtml() {
  const conn = activeConn();
  if (!conn || conn.provider !== 'openrouter') return '';
  const model = String(conn.model || '').trim();
  if (!model) return '';
  if (!priceCache) {
    loadPrices().then((c) => { const el = $('#cost-est'); if (c && el) el.innerHTML = costEstimateHtml(); });
    return 'Estimated cost: loading prices…';
  }
  const pr = priceCache.models[model];
  if (!pr) return `No price listed on OpenRouter for <b>${esc(model)}</b>.`;
  const [inP, outP] = pr;
  if (!inP && !outP) return 'This model is <b>free</b> on OpenRouter.';
  const P = S.settings.preset;
  const ctx = Number(P.context_size) || 0;
  const reply = Number(P.max_tokens) || 0;
  const maxPrompt = Math.max(0, ctx - reply) * inP;
  const maxReply = reply * outP;
  let now = '';
  if (S.chat && S.char) {
    try {
      const { stats } = promptFor({ ...S.chat, vars: { ...(S.chat.vars || {}) } }, S.char, S.chat.messages);
      const sent = (stats.system || 0) + (stats.history || 0);
      now = `<br>Your current chat (${esc(S.char.name)}) sends ≈${sent.toLocaleString()} tokens: <b>≈${money(sent * inP)}</b> per message, plus the reply.`;
    } catch { /* no estimate */ }
  }
  return `<b>Max prompt cost: ${money(maxPrompt)}</b> · max reply cost: ${money(maxReply)} · up to <b>${money(maxPrompt + maxReply)}</b> per message.${now}
    <br><span class="muted">Prices for ${esc(model)}: $${+(inP * 1e6).toFixed(3)} in / $${+(outP * 1e6).toFixed(3)} out per million tokens. Thinking is billed like reply tokens. Estimates only.</span>`;
}

async function browseModels() {
  const conn = activeConn();
  if (!conn) return;
  const sheet = openSheet('<div class="sheet-title">Models</div><p class="muted">Loading…</p>', 'tall');
  try {
    const models = await listModels(conn);
    models.sort((a, b) => a.id.localeCompare(b.id));
    S.models = models;
    sheet.innerHTML = `
      <div class="sheet-title">Models <span class="muted small">(${models.length})</span></div>
      <input class="search" type="search" placeholder="Search models" data-input="model-search" autocomplete="off" autocapitalize="off">
      <div class="model-list" id="model-list"></div>`;
    renderModelList('');
  } catch (e) {
    sheet.innerHTML = `<div class="sheet-title">Models</div><p class="error">${esc(e.message)}</p><p class="muted">Checking the connection…</p>`;
    const why = /Network error/.test(e.message) ? await diagnose(conn) : '';
    sheet.innerHTML = `<div class="sheet-title">Models</div><p class="error">${esc(e.message)}</p>${why ? `<p>${esc(why)}</p>` : ''}<p class="muted">You can still type a model id manually.</p>`;
  }
}

function renderModelList(q) {
  const list = $('#model-list');
  if (!list) return;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const items = S.models.filter((m) => terms.every((t) => (m.id + ' ' + m.name).toLowerCase().includes(t))).slice(0, 300);
  const cur = activeConn()?.model;
  list.innerHTML = items.map((m) => `
    <button class="model-item ${m.id === cur ? 'current' : ''}" data-action="pick-model" data-id="${esc(m.id)}" data-ctx="${m.ctx || ''}">
      <span class="mi-name">${esc(m.name)}</span>
      <span class="mi-meta muted small">${esc(m.id)}${m.ctx ? ` · ${Math.round(m.ctx / 1000)}k ctx` : ''}${m.price ? ` · ${esc(m.price)}` : ''}</span>
    </button>`).join('') || '<p class="muted">No matches.</p>';
}

async function testConnection() {
  const conn = activeConn();
  if (!conn) return;
  toast('Testing…', 20000);
  try {
    const text = await generate(conn, { ...S.settings.preset, max_tokens: 200, stream: false }, [
      { role: 'system', content: 'You are a connection test.' },
      { role: 'user', content: 'Reply with just the word OK.' },
    ], { textFormat: isTextConn(conn) ? textFormatter('quiet') : null });
    toast(`Connected ✓ ${text ? '— model said: ' + text.trim().slice(0, 60) : ''}`, 4000);
  } catch (e) {
    if (!/Network error/.test(e.message)) { toast(e.message, 8000); return; }
    toast('Checking the connection…', 10000);
    const why = await diagnose(conn);
    openSheet(`<div class="sheet-title">Connection problem</div><p class="error">${esc(e.message)}</p><p>${esc(why)}</p>
      <p class="hint">Quick check: open <b>${esc(PROVIDERS[conn.provider] && !PROVIDERS[conn.provider].needsUrl ? PROVIDERS[conn.provider].base + '/models' : 'your server address')}</b> in your phone's browser. If it shows text, your phone can reach it.</p>`);
    $('#toast').classList.remove('show');
  }
}

// ---------- PRESET (prompt manager) ----------
function presetById(id) {
  const p = S.presets.find((x) => x.id === id);
  if (!p) throw new Error('Preset not found');
  return p;
}

function renderPresetView(id) {
  const p = presetById(id);
  S.pmId = id;
  const byId = new Map(p.prompts.map((x) => [x.identifier, x]));
  const q = (S.pmQuery || '').toLowerCase();
  const scroll = $('main.scroll')?.scrollTop || 0;
  const wasSame = app.dataset.view === 'preset:' + id;
  app.dataset.view = 'preset:' + id;
  app.innerHTML = `
    <header class="bar">
      <button class="icon-btn" data-action="go-back" aria-label="Back">${ICONS.back}</button>
      <h1 class="title">${esc(p.name)}</h1>
      <div class="spacer"></div>
      <button class="icon-btn" data-action="pm-add" aria-label="Add prompt">${ICONS.plus}</button>
    </header>
    <main class="scroll pad">
      ${S.settings.activePreset !== id ? `<button class="banner warn" data-action="preset-activate" data-id="${id}">This preset isn't active. Tap to use it.</button>` : ''}
      <p class="hint">Switch prompts on and off like SillyTavern's prompt manager. Tap a name to read or edit it.</p>
      ${(() => { const n = (p.raw?.extensions?.regex_scripts || []).length; return n ? `<label class="toggle"><span><span class="label">Run this preset's ${n} regex script${n === 1 ? '' : 's'}</span><span class="hint">Bundled in the preset file, like SillyTavern's preset regex.</span></span><input type="checkbox" data-preset-rx="1" ${p.runPresetRegex === false ? '' : 'checked'}><i></i></label>` : ''; })()}
      <input class="search" type="search" placeholder="Search prompts" value="${esc(S.pmQuery || '')}" data-input="pm-search">
      <div class="pm-list">
        ${p.order.map((o, i) => {
          const x = byId.get(o.identifier);
          if (!x || (q && !x.name.toLowerCase().includes(q))) return '';
          const header = /^\s*[═─━—=]{2,}/.test(x.name);
          const badges = [
            AUTO_SLOTS.has(x.identifier) ? '<span class="badge slot">auto</span>' : '',
            x.role && x.role !== 'system' ? `<span class="badge">${x.role}</span>` : '',
            x.injection_position === 1 ? `<span class="badge">@${x.injection_depth}</span>` : '',
            !AUTO_SLOTS.has(x.identifier) && x.content ? `<span class="badge muted">${Math.ceil(x.content.length / 3.5)}t</span>` : '',
          ].join('');
          return `<div class="pm-row ${o.enabled ? '' : 'off'} ${header ? 'hdr' : ''}">
            <label class="toggle mini"><input type="checkbox" data-pm-toggle="${i}" ${o.enabled ? 'checked' : ''}><i></i></label>
            <button class="pm-name" data-action="pm-edit" data-i="${i}"><span class="pm-title">${esc(x.name)}</span>${badges}</button>
          </div>`;
        }).join('')}
      </div>
      <div class="row wrap">
        <button class="btn" data-action="pm-add">${ICONS.plus} Add prompt</button>
        <button class="btn" data-action="preset-export" data-id="${id}">${ICONS.download} Export</button>
      </div>
      <div class="bottom-space"></div>
    </main>`;
  if (wasSame) $('main.scroll').scrollTop = scroll;
}

function pmEdit(i) {
  const p = presetById(S.pmId);
  const o = p.order[i];
  const x = p.prompts.find((y) => y.identifier === o.identifier);
  const auto = AUTO_SLOTS.has(x.identifier);
  openSheet(`
    <div class="sheet-title">${esc(x.name)}</div>
    ${auto ? `<p class="hint">This slot is filled automatically with the ${esc(MARKER_LABELS[x.identifier] || x.identifier)}.</p>` : `
      <label class="field"><span class="label">Name</span><input id="pm-name" value="${esc(x.name)}"></label>
      <div class="row wrap">
        <label class="field grow"><span class="label">Role</span><select id="pm-role">
          ${['system', 'user', 'assistant'].map((r) => `<option ${x.role === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select></label>
        <label class="field grow"><span class="label">Position</span><select id="pm-pos">
          <option value="0" ${x.injection_position !== 1 ? 'selected' : ''}>In prompt order</option>
          <option value="1" ${x.injection_position === 1 ? 'selected' : ''}>In chat @ depth</option>
        </select></label>
        <label class="field" style="width:90px"><span class="label">Depth</span><input id="pm-depth" inputmode="numeric" value="${x.injection_depth ?? 4}"></label>
      </div>
      <label class="field"><span class="label">Content</span><textarea id="pm-content" rows="14">${esc(x.content)}</textarea>
        <span class="hint">Macros like {{char}}, {{user}}, {{setvar::name::value}}, {{getvar::name}}, {{random::a::b}}, {{trim}} work.</span></label>`}
    <div class="row wrap">
      <button class="btn sm" data-action="pm-move" data-i="${i}" data-dir="-1">Move up</button>
      <button class="btn sm" data-action="pm-move" data-i="${i}" data-dir="1">Move down</button>
      ${!auto ? `<button class="btn sm danger" data-action="pm-delete" data-i="${i}">${ICONS.trash} Delete</button>` : ''}
    </div>
    ${!auto ? `<button class="btn primary block" data-action="pm-save" data-i="${i}">Save</button>` : ''}
  `, 'tall');
}

// ---------- LOREBOOK editor ----------
function bookById(id) {
  const b = S.lorebooks.find((x) => x.id === id);
  if (!b) throw new Error('Lorebook not found');
  return b;
}

function entryTitle(e) {
  return e.comment || e.keys.join(', ') || '(untitled entry)';
}

function renderLorebookView(id) {
  const b = bookById(id);
  S.lbId = id;
  const q = (S.lbQuery || '').toLowerCase();
  const scroll = $('main.scroll')?.scrollTop || 0;
  const wasSame = app.dataset.view === 'lorebook:' + id;
  app.dataset.view = 'lorebook:' + id;
  app.innerHTML = `
    <header class="bar">
      <button class="icon-btn" data-action="go-back" aria-label="Back">${ICONS.back}</button>
      <h1 class="title">Lorebook</h1>
      <div class="spacer"></div>
      <button class="icon-btn" data-action="le-add" aria-label="Add entry">${ICONS.plus}</button>
    </header>
    <main class="scroll pad">
      <label class="field"><span class="label">Name</span><input data-lb-name value="${esc(b.name)}" autocomplete="off"></label>
      <label class="toggle"><span><span class="label">Global</span><span class="hint">Active in every chat</span></span>
        <input type="checkbox" data-lb-global="${b.id}" ${b.global ? 'checked' : ''}><i></i></label>
      <input class="search" type="search" placeholder="Search entries" value="${esc(S.lbQuery || '')}" data-input="lb-search">
      <div class="pm-list">
        ${b.entries.map((e, i) => {
          if (q && !(entryTitle(e) + ' ' + e.keys.join(' ') + ' ' + e.content).toLowerCase().includes(q)) return '';
          const meta = [
            e.constant ? '<span class="badge slot">always</span>' : (e.keys.length ? `<span class="badge">${esc(e.keys.slice(0, 3).join(', '))}${e.keys.length > 3 ? '…' : ''}</span>` : '<span class="badge muted">no keys</span>'),
            e.group ? `<span class="badge">group: ${esc(e.group)}${e.groupOverride ? ' ★' : ''}</span>` : '',
            e.characterFilter && e.characterFilter.names.length ? `<span class="badge">${e.characterFilter.isExclude ? 'not ' : ''}${e.characterFilter.names.length} char</span>` : '',
            e.position === 4 ? `<span class="badge">@${e.depth}</span>` : '',
            e.sticky ? `<span class="badge">sticky ${e.sticky}</span>` : '',
            e.cooldown ? `<span class="badge">cooldown ${e.cooldown}</span>` : '',
            e.delay ? `<span class="badge">delay ${e.delay}</span>` : '',
          ].join('');
          return `<div class="pm-row ${e.enabled ? '' : 'off'}">
            <label class="toggle mini"><input type="checkbox" data-le-toggle="${i}" ${e.enabled ? 'checked' : ''}><i></i></label>
            <button class="pm-name" data-action="le-edit" data-i="${i}"><span class="pm-title">${esc(entryTitle(e))}</span>${meta}</button>
          </div>`;
        }).join('') || '<p class="muted">No entries.</p>'}
      </div>
      <div class="row wrap">
        <button class="btn" data-action="le-add">${ICONS.plus} Add entry</button>
        <button class="btn" data-action="lb-export">${ICONS.download} Export</button>
        <button class="btn danger" data-action="lb-delete">${ICONS.trash} Delete lorebook</button>
      </div>
      <div class="bottom-space"></div>
    </main>`;
  if (wasSame) $('main.scroll').scrollTop = scroll;
}

function leEdit(i) {
  const b = bookById(S.lbId);
  const e = b.entries[i];
  const f = e.characterFilter || { isExclude: false, names: [] };
  const chk = (id, on, label, hint = '') => `<label class="toggle"><span><span class="label">${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</span><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i></i></label>`;
  openSheet(`
    <div class="sheet-title">${esc(entryTitle(e))}</div>
    <label class="field"><span class="label">Title / memo</span><input id="le-comment" value="${esc(e.comment)}"></label>
    <label class="field"><span class="label">Content</span><textarea id="le-content" rows="8">${esc(e.content)}</textarea></label>
    ${chk('le-constant', e.constant, 'Always active', 'Ignore keywords; always insert (still subject to groups & filters)')}
    <label class="field"><span class="label">Keywords <span class="hint">(comma separated, /regex/ allowed)</span></span><input id="le-keys" value="${esc(e.keys.join(', '))}" autocapitalize="off"></label>
    <label class="field"><span class="label">Secondary keywords <span class="hint">(optional)</span></span><input id="le-secondary" value="${esc(e.secondary.join(', '))}" autocapitalize="off"></label>
    <div class="row wrap">
      <label class="field grow"><span class="label">Secondary logic</span><select id="le-logic">${Object.entries(LOGIC).map(([k, v]) => `<option value="${k}" ${e.selectiveLogic === +k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field" style="width:90px"><span class="label">Order</span><input id="le-order" inputmode="numeric" value="${e.order}"></label>
    </div>
    <div class="row wrap">
      <label class="field grow"><span class="label">Position</span><select id="le-position">${Object.entries(POSITIONS).map(([k, v]) => `<option value="${k}" ${e.position === +k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field" style="width:80px"><span class="label">Depth</span><input id="le-depth" inputmode="numeric" value="${e.depth}"></label>
      <label class="field" style="width:120px"><span class="label">Role</span><select id="le-role">${['system', 'user', 'assistant'].map((r, k) => `<option value="${k}" ${e.role === k ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
    </div>
    <div class="row wrap">
      <label class="field grow"><span class="label">Inclusion group</span><input id="le-group" value="${esc(e.group)}" autocapitalize="off"></label>
      <label class="field" style="width:110px"><span class="label">Probability %</span><input id="le-prob" inputmode="numeric" value="${e.probability}"></label>
    </div>
    ${chk('le-override', e.groupOverride, 'Group priority', 'Wins its inclusion group over non-priority entries')}
    <label class="field"><span class="label">Only for characters <span class="hint">(comma separated names; empty = all)</span></span><input id="le-chars" value="${esc(f.names.join(', '))}"></label>
    ${chk('le-exclude', f.isExclude, 'Exclude those characters instead')}
    ${chk('le-whole', e.matchWholeWords, 'Match whole words only')}
    ${chk('le-case', e.caseSensitive, 'Case sensitive')}
    ${chk('le-persona', e.matchPersonaDescription, 'Also scan the persona description')}
    <div class="row wrap">
      <label class="field grow"><span class="label">Sticky</span><input id="le-sticky" inputmode="numeric" value="${e.sticky || 0}"></label>
      <label class="field grow"><span class="label">Cooldown</span><input id="le-cooldown" inputmode="numeric" value="${e.cooldown || 0}"></label>
      <label class="field grow"><span class="label">Delay</span><input id="le-delay" inputmode="numeric" value="${e.delay || 0}"></label>
    </div>
    <p class="hint">Sticky: stays active for N more messages after triggering. Cooldown: can't trigger again for N messages. Delay: needs at least N messages in the chat.</p>
    <div class="row wrap">
      <button class="btn danger" data-action="le-delete" data-i="${i}">${ICONS.trash} Delete entry</button>
    </div>
    <button class="btn primary block" data-action="le-save" data-i="${i}">Save</button>
  `, 'tall');
}

function regexEdit(i) {
  const r = i === -1 ? normalizeScript({ scriptName: 'New script', findRegex: '', placement: [2] }) : S.regex[i];
  const chk = (id, on, label, hint = '') => `<label class="toggle"><span><span class="label">${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</span><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i></i></label>`;
  openSheet(`
    <div class="sheet-title">${i === -1 ? 'New regex script' : esc(r.scriptName)}</div>
    <label class="field"><span class="label">Script name</span><input id="rx-name" value="${esc(r.scriptName)}"></label>
    <label class="field"><span class="label">Find regex</span><input id="rx-find" value="${esc(r.findRegex)}" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="/pattern/g"></label>
    <label class="field"><span class="label">Replace with <span class="hint">({{match}}, $1, $2, $&lt;name&gt;, macros)</span></span><textarea id="rx-replace" rows="4" spellcheck="false">${esc(r.replaceString)}</textarea></label>
    <label class="field"><span class="label">Trim out <span class="hint">(one per line, removed from each match first)</span></span><textarea id="rx-trim" rows="2">${esc(r.trimStrings.join('\n'))}</textarea></label>
    <details class="rx-test"><summary>Test mode</summary>
      <label class="field"><span class="label">Try it on</span><textarea id="rx-test-in" rows="3" spellcheck="false" placeholder="Type or paste some text…"></textarea></label>
      <div class="field"><span class="label">Result</span><pre id="rx-test-out" class="rx-test-out"></pre></div>
    </details>
    <div class="field"><span class="label">Affects</span>
      ${Object.entries(PLACEMENT_LABELS).map(([k, v]) => `<label class="check"><input type="checkbox" data-rx-place="${k}" ${r.placement.includes(+k) ? 'checked' : ''}> ${v}</label>`).join('')}
    </div>
    <h4 class="sub">Other options</h4>
    ${chk('rx-disabled', r.disabled, 'Disabled')}
    ${chk('rx-edit', r.runOnEdit, 'Run on edit', 'Also runs when you edit a message')}
    <label class="field"><span class="label">Macros in find regex</span><select id="rx-subst">
      ${[[0, "Don't substitute"], [1, 'Substitute (raw)'], [2, 'Substitute (escaped)']].map(([v, l]) => `<option value="${v}" ${r.substituteRegex === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
    <h4 class="sub">Ephemerality</h4>
    <p class="hint">With both off, the script changes the saved message itself.</p>
    ${chk('rx-md', r.markdownOnly, 'Alter chat display', 'Changes how messages look on screen; the AI still sees the original')}
    ${chk('rx-prompt', r.promptOnly, 'Alter outgoing prompt', 'Changes what is sent to the AI; the screen shows the original')}
    <div class="row wrap">
      <label class="field grow"><span class="label">Min depth</span><input id="rx-min" inputmode="numeric" value="${r.minDepth ?? ''}" placeholder="Unlimited"></label>
      <label class="field grow"><span class="label">Max depth</span><input id="rx-max" inputmode="numeric" value="${r.maxDepth ?? ''}" placeholder="Unlimited"></label>
    </div>
    <div class="row wrap">
      ${i !== -1 ? `<button class="btn" data-action="rx-export" data-i="${i}">${ICONS.download} Export</button><button class="btn danger" data-action="rx-delete" data-i="${i}">${ICONS.trash} Delete</button>` : ''}
    </div>
    <button class="btn primary block" data-action="rx-save" data-i="${i}">Save</button>
  `, 'tall');
}

/** The script as currently filled in on the editor sheet. */
function rxFromForm(base) {
  return normalizeScript({
    ...base,
    scriptName: $('#rx-name').value.trim() || 'Regex',
    findRegex: $('#rx-find').value,
    replaceString: $('#rx-replace').value,
    trimStrings: $('#rx-trim').value.split('\n').filter((x) => x !== ''),
    placement: [...document.querySelectorAll('[data-rx-place]')].filter((x) => x.checked).map((x) => +x.dataset.rxPlace),
    disabled: $('#rx-disabled').checked,
    markdownOnly: $('#rx-md').checked,
    promptOnly: $('#rx-prompt').checked,
    runOnEdit: $('#rx-edit').checked,
    substituteRegex: Number($('#rx-subst').value) || 0,
    minDepth: numOrNull($('#rx-min').value),
    maxDepth: numOrNull($('#rx-max').value),
  });
}

function updateRxTest() {
  const out = $('#rx-test-out');
  const inp = $('#rx-test-in');
  if (!out || !inp) return;
  if (!inp.value) { out.textContent = ''; return; }
  try {
    const sc = rxFromForm({});
    if (!regexFromString(sc.findRegex)) { out.textContent = 'That find regex isn\'t valid.'; return; }
    const env = { char: S.char ? S.char.name : 'Char', user: activePersona().name, vars: {} };
    out.textContent = runRegexScript(sc, inp.value, (t) => evaluateMacros(t, env));
  } catch (e) { out.textContent = e.message; }
}

function qrById(id) {
  const q = S.qr.find((x) => x.id === id);
  if (!q) throw new Error('Quick reply set not found');
  return q;
}

function renderQrView(id) {
  const set = qrById(id);
  S.qrId = id;
  const scroll = $('main.scroll')?.scrollTop || 0;
  const wasSame = app.dataset.view === 'qr:' + id;
  app.dataset.view = 'qr:' + id;
  app.innerHTML = `
    <header class="bar">
      <button class="icon-btn" data-action="go-back" aria-label="Back">${ICONS.back}</button>
      <h1 class="title">Quick replies</h1>
      <div class="spacer"></div>
      <button class="icon-btn" data-action="qr-add" aria-label="Add button">${ICONS.plus}</button>
    </header>
    <main class="scroll pad">
      <label class="field"><span class="label">Set name</span><input data-qr-name value="${esc(set.name)}" autocomplete="off"></label>
      <label class="toggle"><span><span class="label">Show in chats</span><span class="hint">Buttons appear above the message box</span></span>
        <input type="checkbox" data-qr-visible ${set.visible !== false ? 'checked' : ''}><i></i></label>
      <p class="hint">A button sends its text as your message. Text starting with <code>/</code> runs slash commands, e.g. <code>/gen Describe the room | /sendas name={{char}} {{pipe}}</code>. You can also type commands straight into the chat box.</p>
      ${set.buttons.map((b) => `
        <div class="qr-edit">
          <div class="row">
            <input class="grow" data-qr-label="${b.id}" value="${esc(b.label)}" placeholder="Button label" autocomplete="off">
            <button class="icon-btn sm" data-action="qr-up" data-id="${b.id}" aria-label="Move up">↑</button>
            <button class="icon-btn sm danger" data-action="qr-del" data-id="${b.id}" aria-label="Delete">${ICONS.trash}</button>
          </div>
          <textarea data-qr-message="${b.id}" rows="3" placeholder="Message or /command" spellcheck="false">${esc(b.message)}</textarea>
        </div>`).join('') || '<p class="muted">No buttons yet.</p>'}
      <div class="row wrap">
        <button class="btn" data-action="qr-add">${ICONS.plus} Add button</button>
        <button class="btn" data-action="qr-export">${ICONS.download} Export</button>
        <button class="btn danger" data-action="qr-delete-set">${ICONS.trash} Delete set</button>
      </div>
      <details class="section"><summary>Supported slash commands</summary><div class="sec-body"><pre class="cmd-list">${esc(SLASH_HELP)}</pre></div></details>
      <div class="bottom-space"></div>
    </main>`;
  if (wasSame) $('main.scroll').scrollTop = scroll;
}

const SLASH_HELP = `${COMMANDS.join('\n')}

Chain commands with |  — {{pipe}} is the previous result.
Blocks: /if left={{getvar::hp}} right=0 rule=lte {: /sys You collapse. :}
Loops: /times 3 {: /echo {{timesIndex}} :}   Scoped vars: /let x 5 | /echo {{var::x}}`;

const numOrNull = (v) => (String(v).trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));
const splitList = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

// ---------- backup ----------
// Every credential field, wherever it lives (connections, image gen, TTS,
// memory embeddings, and anything added later that follows the naming).
function stripSecrets(o) {
  if (Array.isArray(o)) { o.forEach(stripSecrets); return o; }
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) {
      if (V.isSecretField(k) && typeof o[k] === 'string') o[k] = '';
      else stripSecrets(o[k]);
    }
  }
  return o;
}

async function exportBackup() {
  let pass = '';
  if (confirm('Include your API keys in the backup?\n\nOK = include them, locked with a passphrase you choose (you type it again when restoring)\nCancel = leave keys out\n\nEither way the backup holds your chats, characters and personas, so only share it with people you trust.')) {
    pass = prompt('Choose a passphrase to lock the keys in this backup.\nYou\'ll need it to restore them. Leave blank to skip the keys.') || '';
    if (pass && prompt('Type the passphrase again:') !== pass) { toast('The passphrases didn\'t match — backup cancelled.'); return; }
  }
  const settings = structuredClone(S.settings);
  const secrets = V.takeSecrets(settings);
  stripSecrets(settings);
  const lockedKeys = pass && V.vaultAvailable && Object.keys(secrets).length ? await V.lockForBackup(secrets, pass) : undefined;
  const data = {
    app: 'PocketTavern', version: 1, exportedAt: new Date().toISOString(),
    settings, characters: await db.getAll('characters'), chats: await db.getAll('chats'),
    presets: S.presets, lorebooks: S.lorebooks, regex: S.regex, groups: S.groups, qr: S.qr,
    themeCss: {}, lockedKeys,
  };
  for (const t of (settings.appearance && settings.appearance.saved) || []) {
    if (t.hasCss) data.themeCss[t.id] = (await db.get('kv', `themecss:${t.id}`)) || '';
  }
  data.sprites = {};
  for (const c of data.characters) {
    const sp = await spritesOf(c.id);
    if (Object.keys(sp).length) data.sprites[c.id] = sp;
  }
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await saveFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), `pockettavern-backup-${stamp}.json`);
}

async function importBackup() {
  const [file] = await pickFile('file-backup');
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'PocketTavern') throw new Error('Not a PocketTavern backup');
    if (!Array.isArray(data.characters) || !Array.isArray(data.chats)) throw new Error('Invalid backup lists');
    // IDs also appear in HTML attributes. Validate before writing any records.
    function validateRecord(value) {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (['id', 'charId', 'lastChatId', 'activeConnection', 'activePersona', 'activePreset'].includes(key)
            && item != null && (typeof item !== 'string' || !/^[A-Za-z0-9_-]+$/.test(item))) {
          throw new Error('Invalid identifier in backup');
        }
        if (key === 'avatar') value[key] = safeAvatar(item);
        else if (item && typeof item === 'object') validateRecord(item);
      }
    }
    validateRecord(data);
    // Two-way sync: for every record the newer copy wins; nothing is deleted.
    const fileTime = Date.parse(data.exportedAt) || 0;
    const fileNewer = fileTime > (S.settings.savedAt || 0);
    const stamp = (x) => Math.max(x.updatedAt || 0, x.lastChatAt || 0);
    const n = { chars: 0, chats: 0, lists: 0 };
    const localChars = new Map((await db.getAll('characters')).map((c) => [c.id, c]));
    for (const c of data.characters) {
      const mine = localChars.get(c.id);
      if (!mine || stamp(c) > stamp(mine)) { await db.put('characters', c); n.chars++; }
    }
    const localChats = new Map((await db.getAll('chats')).map((c) => [c.id, c]));
    for (const c of data.chats) {
      const mine = localChats.get(c.id);
      if (!mine || (c.updatedAt || 0) > (mine.updatedAt || 0)) { await db.put('chats', c); n.chats++; }
    }
    const merge = (key, list) => {
      if (!Array.isArray(list)) return;
      const ids = new Map(S[key].map((x, i) => [x.id, i]));
      for (const x of list) {
        if (!ids.has(x.id)) { S[key].push(x); n.lists++; continue; }
        const mine = S[key][ids.get(x.id)];
        const newer = (x.updatedAt || x.importedAt || 0) > (mine.updatedAt || mine.importedAt || 0) || (!x.updatedAt && !mine.updatedAt && fileNewer);
        if (newer && JSON.stringify(mine) !== JSON.stringify(x)) { S[key][ids.get(x.id)] = x; n.lists++; }
      }
    };
    if (data.themeCss && typeof data.themeCss === 'object') {
      for (const [id, css] of Object.entries(data.themeCss)) if (/^[A-Za-z0-9_-]+$/.test(id) && typeof css === 'string') await db.put('kv', css, `themecss:${id}`);
      S.themeCssId = null;
    }
    if (data.sprites && typeof data.sprites === 'object') {
      for (const [id, sp] of Object.entries(data.sprites)) {
        if (!/^[A-Za-z0-9_-]+$/.test(id) || !sp || typeof sp !== 'object') continue;
        const clean = Object.fromEntries(Object.entries(sp).filter(([k, v]) => /^[\w-]+$/.test(k) && X.isSafeImageSrc(v)));
        const mine = await spritesOf(id);
        if (fileNewer || !Object.keys(mine).length) await saveSprites(id, { ...mine, ...clean });
      }
    }
    merge('presets', data.presets); merge('lorebooks', data.lorebooks); merge('regex', data.regex); merge('groups', data.groups); merge('qr', data.qr);
    await savePresets(true); await saveLorebooks(true); await saveRegex(true); await saveGroups(true); await saveQr(true);
    let settingsNote = 'kept yours (they are newer)';
    if (data.settings) {
      if (data.lockedKeys && V.vaultAvailable) {
        for (;;) {
          const pass = prompt('This backup has API keys locked with a passphrase. Type it to restore the keys (Cancel = restore without keys):');
          if (!pass) break;
          try { V.putSecrets(data.settings, await V.unlockBackup(data.lockedKeys, pass)); break; } catch { if (!confirm('Wrong passphrase. Try again?')) break; }
        }
      }
      const local = S.settings;
      const fresh = !(local.connections || []).length;
      const theirsNewer = fresh || (data.settings.savedAt || fileTime) > (local.savedAt || 0);
      S.settings = mergeSettings(local, data.settings, theirsNewer);
      applyLook();
      await saveSettings(true);
      settingsNote = theirsNewer ? 'updated from the file (connections and personas from both kept)' : 'kept yours (newer), plus any new connections/personas from the file';
    }
    toast(`Synced: ${n.chars} characters, ${n.chats} chats and ${n.lists} presets/lorebooks/other items updated or added; settings ${settingsNote}.`, 7000);
    render();
  } catch (e) {
    toast('Restore failed: ' + e.message, 5000);
  }
}

/** Merge two settings objects: lists (connections, personas, saved themes/templates) are combined by id; the rest follows the newer copy. */
function mergeSettings(local, theirs, theirsNewer) {
  const def = defaultSettings();
  const [a, b] = theirsNewer ? [local, theirs] : [theirs, local]; // b wins
  const out = { ...def, ...a, ...b };
  for (const k of ['preset', 'prompt', 'ui', 'instruct']) out[k] = { ...def[k], ...(a[k] || {}), ...(b[k] || {}) };
  out.ext = { ...def.ext };
  for (const k of Object.keys(def.ext)) out.ext[k] = { ...def.ext[k], ...((a.ext || {})[k] || {}), ...((b.ext || {})[k] || {}) };
  out.appearance = { ...structuredClone(DEFAULT_APPEARANCE), ...(a.appearance || {}), ...(b.appearance || {}) };
  const union = (x = [], y = []) => { const m = new Map(x.map((i) => [i.id, i])); y.forEach((i) => m.set(i.id, { ...(m.get(i.id) || {}), ...i })); return [...m.values()]; };
  out.connections = union(a.connections, b.connections);
  const keys = new Map([...(theirs.connections || []), ...(local.connections || [])].filter((c) => c.apiKey).map((c) => [c.id, c.apiKey]));
  out.connections.forEach((c) => { if (!c.apiKey && keys.get(c.id)) c.apiKey = keys.get(c.id); });
  for (const k of Object.keys(out.ext)) {
    for (const f of Object.keys(out.ext[k])) {
      if (V.isSecretField(f) && !out.ext[k][f]) out.ext[k][f] = ((local.ext || {})[k] || {})[f] || ((theirs.ext || {})[k] || {})[f] || '';
    }
  }
  out.personas = union(a.personas, b.personas);
  out.appearance.saved = union((a.appearance || {}).saved, (b.appearance || {}).saved);
  out.instruct.saved = union((a.instruct || {}).saved, (b.instruct || {}).saved);
  out.globalVars = { ...(a.globalVars || {}), ...(b.globalVars || {}) };
  if (!out.connections.some((c) => c.id === out.activeConnection)) out.activeConnection = (out.connections[0] || {}).id || null;
  if (!out.personas.length) out.personas = def.personas;
  if (!out.personas.some((p) => p.id === out.activePersona)) out.activePersona = out.personas[0].id;
  return out;
}

// ---------- event wiring ----------
const actions = {
  go: (el) => go(el.dataset.to),
  'go-back': () => (history.length > 1 ? history.back() : go('#/')),
  'install-app': async () => {
    const p = installPrompt;
    if (!p) return;
    installPrompt = null;
    try { p.prompt(); await p.userChoice; } catch { /* ignore */ }
    render();
  },
  'close-sheet': closeSheet,
  'import-files': importFiles,

  send: sendMessage,
  stop: () => { S.stopGroup = true; if (S.abort) S.abort.abort(); },
  'toggle-msg': (el, e) => {
    if (S.editing) return;
    const inner = e && e.composedPath && e.composedPath()[0];
    if (inner && inner.closest && inner.closest('summary, a, button, input, label, select, details[open] *')) return;
    if (window.getSelection && String(window.getSelection()).length) return;
    S.openActions = S.openActions === el.dataset.id ? null : el.dataset.id;
    renderMessages();
  },
  swipe: (el) => swipe(+el.dataset.dir),
  'msg-edit': (el) => { S.editing = el.dataset.id; S.openActions = null; renderMessages(); },
  'edit-cancel': () => { S.editing = null; renderMessages(); },
  'edit-save': async (el) => {
    const msg = findMsg(el.dataset.id);
    if (msg) {
      const env = { char: S.char.name, user: activePersona().name, vars: { ...(S.chat.vars || {}) } };
      const scripts = scriptsFor(S.char).filter((x) => x.runOnEdit);
      msg.swipes[msg.swipeIdx] = applyRegex($('#edit-box').value, scripts, { placement: msg.role === 'user' ? PLACEMENT.USER : PLACEMENT.AI, macro: (t) => evaluateMacros(t, env) });
    }
    S.editing = null;
    await saveChat(S.chat);
    renderMessages();
  },
  'msg-hide': async (el) => {
    const m = findMsg(el.dataset.id);
    if (!m) return;
    m.hidden = !m.hidden;
    S.openActions = null;
    await saveChat(S.chat);
    renderMessages();
    toast(m.hidden ? 'Hidden from the AI (still in the chat)' : 'Visible to the AI again');
  },
  'msg-del-swipe': async (el) => {
    const m = findMsg(el.dataset.id);
    if (!m || m.swipes.length < 2 || !confirm('Delete this swipe?')) return;
    const i = m.swipeIdx;
    m.swipes.splice(i, 1);
    if (m.reasoning) m.reasoning.splice(i, 1);
    if (m.audit) { if (m.audit.swipe === i) delete m.audit; else if (m.audit.swipe > i) m.audit.swipe--; }
    m.swipeIdx = Math.min(i, m.swipes.length - 1);
    S.openActions = null;
    await saveChat(S.chat);
    renderMessages();
  },
  'persona-lock': async () => {
    const c = await db.get('characters', S.char.id);
    if (!c) return;
    c.personaId = c.personaId === S.settings.activePersona ? null : S.settings.activePersona;
    await db.put('characters', c);
    S.char.personaId = c.personaId;
    closeSheet();
    toast(c.personaId ? `${activePersona().name} is now locked to ${c.name}` : 'Persona unlocked');
  },
  'import-zip': async () => {
    const [f] = await pickFile('file-zip');
    if (f) await importStZip(f);
  },
  'msg-copy': async (el) => {
    const msg = findMsg(el.dataset.id);
    try { await navigator.clipboard.writeText(macros(msg.swipes[msg.swipeIdx], ctxNames())); toast('Copied'); } catch { toast('Copy failed'); }
    S.openActions = null; renderMessages();
  },
  'msg-regen': (el) => { if (!S.generating) { const m = findMsg(el.dataset.id); runGeneration('swipe', m && m.charId); } },
  'quick-actions': quickActions,
  'lib-fav': () => { S.libFav = !S.libFav; renderHome(); },
  'lib-tag': (el) => { S.libTag = S.libTag === el.dataset.tag ? null : el.dataset.tag; renderHome(); },
  'fav-toggle': async (el) => {
    if (el.dataset.group) {
      const g = S.groups.find((x) => x.id === el.dataset.id);
      if (g) { g.fav = !g.fav; saveGroups(); }
    } else {
      const c = await db.get('characters', el.dataset.id);
      if (c) { c.fav = !c.fav; await db.put('characters', c); }
    }
    renderHome();
  },
  'tags-manage': tagsSheet,
  'tag-rename': async (el) => {
    const to = prompt('Rename tag', el.dataset.tag);
    if (to === null || !to.trim() || to.trim() === el.dataset.tag) return;
    await retag(el.dataset.tag, to.trim());
    tagsSheet(); renderHome();
  },
  'tag-delete': async (el) => {
    if (!confirm(`Remove the tag "${el.dataset.tag}" from every character?`)) return;
    await retag(el.dataset.tag, '');
    tagsSheet(); renderHome();
  },
  'search-open': (el) => { S.jumpTo = { chatId: el.dataset.chat, msgId: el.dataset.msg }; go(`#/chat/${el.dataset.char}/${el.dataset.chat}`); },
  'link-import': () => openSheet(`<div class="sheet-title">Import from a link</div>
    <label class="field"><span class="label">chub.ai character link</span><input id="link-url" placeholder="https://chub.ai/characters/creator/name" autocapitalize="off" spellcheck="false"></label>
    <p class="hint">Also works with “creator/name”, or a direct https link to a card PNG/JSON.</p>
    <button class="btn primary block" data-action="link-go">Import</button>`),
  'link-go': async () => {
    try { await importFromLink(($('#link-url') || {}).value); } catch (e) { toast(e.message, 8000); }
  },
  'st-button': (el) => { const r = S.buttonResolve; S.buttonResolve = null; closeSheet(); if (r) r(+el.dataset.i); },
  'ins-copy': () => {
    const ins = S.settings.instruct;
    const t = { ...currentInstruct(), id: db.uid() };
    t.name = `${t.name} (copy)`;
    ins.saved = [...(ins.saved || []), t];
    ins.template = t.id;
    saveSettings(); rerenderSettings();
  },
  'ins-delete': () => {
    const ins = S.settings.instruct;
    if (!confirm('Delete this template?')) return;
    ins.saved = (ins.saved || []).filter((x) => x.id !== ins.template);
    ins.template = 'chatml';
    saveSettings(); rerenderSettings();
  },
  'qa-image': imageSheet,
  'img-gen': (el) => {
    const mode = el.dataset.mode;
    const extra = mode === 'free' ? ($('#img-free') || {}).value || '' : '';
    if (mode === 'free' && !extra.trim()) return toast('Describe the image first.');
    closeSheet();
    runImageGen(mode, extra.trim());
  },
  'view-image': (el) => {
    const m = findMsg(el.dataset.id);
    const src = m && m.images && m.images[+el.dataset.i];
    if (!src || !X.isSafeImageSrc(src)) return;
    openSheet(`<img class="img-full" src="${esc(src)}" alt="">${m.imagePrompt ? `<p class="hint">${esc(m.imagePrompt)}</p>` : ''}
      <div class="row wrap"><button class="btn" data-action="save-image" data-id="${m.id}" data-i="${el.dataset.i}">${ICONS.download} Save image</button></div>`, 'tall');
  },
  'save-image': async (el) => {
    const m = findMsg(el.dataset.id);
    const src = m && m.images[+el.dataset.i];
    if (!src) return;
    const blob = await (await fetch(src)).blob();
    await saveFile(blob, `${safeName(S.char.name)}-${Date.now()}.${blob.type.includes('png') ? 'png' : 'jpg'}`);
  },
  attach: async () => {
    const files = await pickFile('file-images');
    if (!files.length) return;
    if (!S.pending || S.pending.chatId !== S.chat.id) S.pending = { chatId: S.chat.id, images: [] };
    for (const f of files.slice(0, 4)) {
      try { S.pending.images.push(await blobToAvatar(f, 1280)); } catch (e) { toast(e.message); }
    }
    renderAttachRow();
  },
  'attach-remove': (el) => { if (S.pending) S.pending.images.splice(+el.dataset.i, 1); renderAttachRow(); },
  'msg-speak': (el) => { const m = findMsg(el.dataset.id); if (m) speakMessage(m); },
  'msg-translate': async (el) => {
    const m = findMsg(el.dataset.id);
    if (!m) return;
    S.openActions = null;
    if (m.tr && m.tr[m.swipeIdx]) { m.showOriginal = !m.showOriginal; await saveChat(S.chat); renderMessages(); return; }
    toast('Translating…', 15000);
    await translateMessage(m);
    toast('Translated', 1200);
  },
  'expr-toggle': () => { const c = S.settings.ext.expressions; c.collapsed = !c.collapsed; saveSettings(); updateExpressionPanel(); },
  'pick-voice': async (el) => {
    const target = el.dataset.target;
    if (target === 'default' || target === 'narrator') {
      S.settings.ext.tts[target === 'default' ? 'defaultVoice' : 'narratorVoice'] = el.dataset.id;
      saveSettings(); closeSheet(); rerenderSettings();
    } else if (S.draft) {
      collectDraft(); S.draft.ttsVoice = el.dataset.id; closeSheet(); renderEditView(S.draft._for);
    }
  },
  'voices-default': () => voicesSheet('default'),
  'voices-narrator': () => voicesSheet('narrator'),
  'voices-char': () => voicesSheet('char'),
  'tts-test': () => speakMessage({ id: 'test', role: 'system', swipes: ['"Hello! This is how I sound."'], swipeIdx: 0 }),
  'sprites-add': async () => {
    const files = await pickFile('file-sprites');
    if (!files.length) return;
    collectDraft();
    const sp = { ...(await spritesOf(S.draft.id)) };
    for (const f of files) {
      const label = f.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
      try { sp[label] = await blobToPng(f); } catch (e) { toast(`${f.name}: ${e.message}`); }
    }
    await saveSprites(S.draft.id, sp);
    renderEditView(S.draft._for);
  },
  'sprites-clear': async () => {
    if (!confirm('Remove all expression sprites for this character?')) return;
    collectDraft();
    await saveSprites(S.draft.id, {});
    renderEditView(S.draft._for);
  },
  'imp-done': () => { closeSheet(); if (route().name === 'home' || !location.hash || location.hash === '#/') renderHome(); else go('#/'); },
  enhance: () => { closeSheet(); enhanceDraft(); },
  'restore-draft': () => { closeSheet(); restoreDraft(); },
  'qa-summary': summarySheet,
  'qa-memory': memorySheet,
  'qa-database': openDatabaseManager,
  'ndb-select-chat': async (el) => {
    const chat = await db.get('chats', el.dataset.id);
    if (!chat) return toast('That chat could not be found.', 5000);
    S.chat = chat;
    databaseSheet();
  },
  'ndb-update': () => runDatabase(S.chat, { flush: true }),
  'ndb-dismiss-error': async () => {
    if (!S.chat) return;
    delete S.chat.narrativeDbLastError;
    delete S.chat.narrativeDbErrorBatch;
    await saveChat(S.chat);
    updateDatabaseBanner();
    if ($('#ndb-sheet')) databaseSheet();
  },
  'ndb-retry': () => runDatabase(S.chat, { rebuild: true, flush: true, restart: true }),
  'ndb-resume': () => {
    const chat = S.chat;
    const partial = chat.narrativeDbPending;
    if (!partial?.covered || NDB.isStale(chat.messages, partial)) return toast('No valid partial rebuild is available to resume.');
    runDatabase(chat, { rebuild: true, flush: true });
  },
  'ndb-rebuild': () => {
    const chat = S.chat;
    const partial = chat.narrativeDbPending;
    const batches = NDB.countBatches(chat.messages, 0, S.settings.ext.database.batchTokens);
    const warning = partial?.covered ? ' This discards the saved partial rebuild and starts over.' : '';
    if (confirm('Rebuild Narrative Database from the beginning? Estimated: ' + batches + ' sequential model requests for ' + chat.messages.length + ' messages. Large histories can take a long time and may incur API charges.' + warning + ' The current active database remains unchanged until the rebuild succeeds. Continue?')) runDatabase(chat, { rebuild: true, flush: true, restart: true });
  },
  'ndb-cancel': () => { S.dbCancel = true; toast('Cancel requested — stopping after current API call.'); },
  'ndb-clear': async () => {
    if (!confirm('Clear Narrative Database for this chat? Chat messages and other memory systems remain untouched.')) return;
    delete S.chat.narrativeDb; delete S.chat.narrativeDbPending; delete S.chat.narrativeDbLastError; delete S.chat.narrativeDbErrorBatch; delete S.chat.narrativeDbErrorBatch;
    await saveChat(S.chat); databaseSheet();
  },
  'ndb-save': async () => {
    const text = $('#ndb-text')?.value?.trim();
    if (!text) return toast('Database is empty. Use Clear Database instead.');
    const state = S.chat.narrativeDb || { covered: 0, checkpoints: [] };
    S.chat.narrativeDb = { ...state, text, signature: NDB.fingerprint(S.chat.messages, state.covered || 0), at: Date.now() };
    await saveChat(S.chat); toast('Manual corrections saved.'); databaseSheet();
  },
  'ndb-export': () => {
    const state = S.chat.narrativeDb;
    if (!state?.text) return toast('No database to export.');
    saveFile(new Blob([JSON.stringify({ format: 'pockettavern-narrative-db-v1', database: state }, null, 2)], {type:'application/json'}), 'narrative-database.json');
  },
  'ndb-import': async () => {
    const files = await pickFile('file-ndb');
    if (!files.length) return;
    try {
      const data = JSON.parse(await files[0].text());
      const state = data.database;
      if (data.format !== 'pockettavern-narrative-db-v1' || !state?.text) throw new Error('Invalid Narrative Database export.');
      // Imported coverage is not automatically trusted for a different chat.
      S.chat.narrativeDb = { text: state.text, covered: 0, checkpoints: [], signature: NDB.fingerprint(S.chat.messages, 0) };
      delete S.chat.narrativeDbPending; delete S.chat.narrativeDbLastError;
      await saveChat(S.chat); databaseSheet(); toast('Imported text; coverage reset. Rebuild for this chat if needed.');
    } catch (e) { toast(e.message || 'Import failed.', 6000); }
  },
  'ndb-reset-prompt': () => { S.settings.ext.database.prompt = NDB.DEFAULT_DATABASE_PROMPT; saveSettings(); rerenderSettings(); },
  'mem-force': () => { runMemory(S.chat, 'force'); memorySheet(); },
  'mem-slop': () => { runMemory(S.chat, 'slop'); memorySheet(); },
  'mem-clear': () => { if (confirm('Clear long-term memory for this chat? Ghosted messages are sent to the AI again. No messages are deleted.')) { clearMemory(S.chat); memorySheet(); } },
  'mem-reset-prompts': () => {
    const m = S.settings.ext.memory;
    m.l0Prompt = MEM.DEFAULT_L0_PROMPT; m.mergePrompt = MEM.DEFAULT_MERGE_PROMPT; m.auditorPrompt = MEM.DEFAULT_AUDITOR_PROMPT;
    saveSettings(); rerenderSettings();
  },
  'ap-style': (el) => { S.settings.appearance.chatStyle = el.dataset.v; saveSettings(); applyLook(); rerenderSettings(); },
  'ap-bg': async () => {
    const [f] = await pickFile('file-avatar');
    if (!f) return;
    S.settings.appearance.bgImage = await blobToAvatar(f, 1600);
    saveSettings(); applyLook(); rerenderSettings();
  },
  'ap-bg-remove': () => { S.settings.appearance.bgImage = null; saveSettings(); applyLook(); rerenderSettings(); },
  'ap-reset-colors': () => { S.settings.appearance.colors = {}; saveSettings(); applyLook(); rerenderSettings(); },
  'ap-save': () => {
    const name = prompt('Name for this theme', 'My theme');
    if (!name) return;
    const a = S.settings.appearance;
    const t = { id: db.uid(), name: name.trim().slice(0, 40), colors: paletteOf(a) };
    a.saved = [...(a.saved || []), t];
    a.theme = t.id; a.colors = {};
    saveSettings(); applyLook(); rerenderSettings();
  },
  'ap-delete': () => {
    const a = S.settings.appearance;
    const t = (a.saved || []).find((x) => x.id === a.theme);
    if (!t || !confirm(`Delete theme "${t.name}"?`)) return;
    a.saved = a.saved.filter((x) => x.id !== t.id);
    if (t.hasCss) db.del('kv', `themecss:${t.id}`).catch(() => {});
    a.theme = 'midnight';
    saveSettings(); applyLook(); rerenderSettings();
  },
  'ap-export': async () => {
    const a = S.settings.appearance;
    const t = (a.saved || []).find((x) => x.id === a.theme);
    const name = t ? t.name : (THEMES[a.theme] || {}).name || 'PocketTavern theme';
    await saveFile(new Blob([JSON.stringify(exportTheme(a, name), null, 2)], { type: 'application/json' }), `${safeName(name)}.json`);
  },
  'summary-now': () => summarizeChat(S.chat),
  'summary-save': async () => {
    const text = $('#summary-text').value.trim();
    S.chat.summary = text ? { ...(S.chat.summary || {}), text, upTo: (S.chat.summary && S.chat.summary.upTo) || S.chat.messages.length } : null;
    await saveChat(S.chat);
    closeSheet();
    toast(text ? 'Summary saved' : 'Summary cleared');
  },
  'qr-run': (el) => runQuickReply(el.dataset.set, el.dataset.id),
  'qr-new': () => {
    const set = { id: db.uid(), name: 'Quick replies', visible: true, buttons: [] };
    S.qr.push(set);
    saveQr();
    go(`#/qr/${set.id}`);
  },
  'qr-add': () => {
    const set = qrById(S.qrId);
    set.buttons.push({ id: db.uid(), label: '', message: '' });
    saveQr();
    renderQrView(set.id);
    const last = [...document.querySelectorAll('[data-qr-label]')].pop();
    if (last) last.focus();
  },
  'qr-del': (el) => {
    const set = qrById(S.qrId);
    set.buttons = set.buttons.filter((b) => b.id !== el.dataset.id);
    saveQr();
    renderQrView(set.id);
  },
  'qr-up': (el) => {
    const set = qrById(S.qrId);
    const i = set.buttons.findIndex((b) => b.id === el.dataset.id);
    if (i > 0) [set.buttons[i - 1], set.buttons[i]] = [set.buttons[i], set.buttons[i - 1]];
    saveQr();
    renderQrView(set.id);
  },
  'qr-delete-set': () => {
    const set = qrById(S.qrId);
    if (!confirm(`Delete quick reply set "${set.name}"?`)) return;
    S.qr = S.qr.filter((x) => x.id !== set.id);
    saveQr();
    go('#/settings/qr');
  },
  'qr-export': async () => {
    const set = qrById(S.qrId);
    const data = { version: 2, name: set.name, disableSend: false, placeBeforeInput: false, injectInput: false, qrList: set.buttons.map((b, i) => ({ id: i + 1, label: b.label, title: b.title || '', message: b.message, showLabel: true })) };
    await saveFile(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${safeName(set.name)}.json`);
  },
  'qa-continue': () => {
    closeSheet();
    if (S.generating) return;
    const last = S.chat.messages[S.chat.messages.length - 1];
    if (last && last.role !== 'user') runGeneration('continue', last.charId);
  },
  'qa-impersonate': () => { closeSheet(); runImpersonate(); },
  'qa-regen': () => {
    closeSheet();
    if (S.generating) return;
    const last = S.chat.messages[S.chat.messages.length - 1];
    if (last && last.role !== 'user') runGeneration('swipe', last.charId);
  },
  'qa-note': authorsNoteSheet,
  'an-save': async () => {
    S.chat.authorsNote = { text: $('#an-text').value, depth: numOrNull($('#an-depth').value) ?? 4, role: $('#an-role').value };
    await saveChat(S.chat);
    closeSheet();
    toast(S.chat.authorsNote.text.trim() ? "Author's Note saved" : "Author's Note cleared");
  },
  speak: (el) => { closeSheet(); if (!S.generating) runGeneration('new', el.dataset.id); },
  'new-menu': () => openSheet(`
    <div class="sheet-title">Create</div>
    <div class="menu-grid two">
      <button data-action="go" data-to="#/edit/new">${ICONS.user}<span>New character</span></button>
      <button data-action="go" data-to="#/group/new">${ICONS.users}<span>New group chat</span></button>
      <button data-action="link-import">${ICONS.link}<span>Import from chub.ai / link</span></button>
      <button data-action="import-files">${ICONS.import}<span>Import files</span></button>
    </div>`),
  'group-save': async () => {
    const g = collectGroupDraft();
    if (!g.name) return toast('Give the group a name.');
    if (g.members.length < 2) return toast('Pick at least two members.');
    const isNew = g.isNew;
    delete g.isNew;
    g.updatedAt = Date.now();
    if (isNew) { g.createdAt = g.updatedAt; S.groups.push(g); } else S.groups = S.groups.map((x) => (x.id === g.id ? g : x));
    await saveGroups(true);
    S.groupDraft = null;
    go(`#/chat/${g.id}`);
  },
  'group-delete': async () => {
    const g = S.groupDraft;
    if (!confirm(`Delete group "${g.name}" and its chats? (The characters stay.)`)) return;
    for (const c of await db.byIndex('chats', 'charId', g.id)) await db.del('chats', c.id);
    S.groups = S.groups.filter((x) => x.id !== g.id);
    await saveGroups(true);
    S.groupDraft = null;
    go('#/');
  },
  'g-up': (el) => {
    const g = collectGroupDraft();
    const i = g.members.indexOf(el.dataset.id);
    if (i > 0) [g.members[i - 1], g.members[i]] = [g.members[i], g.members[i - 1]];
    renderGroupEditor(g.isNew ? 'new' : g.id);
  },
  'msg-delete': async (el) => {
    if (S.generating) return;
    const i = S.chat.messages.findIndex((m) => m.id === el.dataset.id);
    if (i < 0) return;
    const after = S.chat.messages.length - 1 - i;
    let count = 1;
    if (after > 0) {
      if (!confirm(`Delete this message?`)) return;
      if (confirm(`Also delete the ${after} message${after > 1 ? 's' : ''} after it?`)) count += after;
    } else if (!confirm('Delete this message?')) return;
    S.chat.messages.splice(i, count);
    S.openActions = null;
    await saveChat(S.chat);
    renderMessages();
  },
  'msg-branch': async (el) => {
    const i = S.chat.messages.findIndex((m) => m.id === el.dataset.id);
    const now = Date.now();
    const chat = {
      id: db.uid(), charId: S.char.id, ...(S.chat.groupId ? { groupId: S.chat.groupId } : {}), title: `Branch of ${S.chat.title}`.slice(0, 60), createdAt: now, updatedAt: now,
      messages: structuredClone(S.chat.messages.slice(0, i + 1)).map((m) => ({ ...m, id: db.uid() })),
      ...(S.chat.mem ? { mem: structuredClone(S.chat.mem) } : {}),
    };
    await saveChat(chat);
    toast('Branched into a new chat');
    go(`#/chat/${S.char.id}/${chat.id}`);
  },
  'chat-menu': chatMenu,
  'new-chat': async () => {
    const chat = await createChat(S.char);
    await saveChat(chat);
    go(`#/chat/${S.char.id}/${chat.id}`);
  },
  'open-chat': (el) => {
    if (el.dataset.id === S.chat.id) return closeSheet();
    go(`#/chat/${S.char.id}/${el.dataset.id}`);
  },
  'rename-chat': async (el) => {
    const c = S.chats.find((x) => x.id === el.dataset.id);
    const name = prompt('Chat name', c.title);
    if (name && name.trim()) {
      c.title = name.trim().slice(0, 80);
      if (S.chat.id === c.id) S.chat.title = c.title;
      await db.put('chats', c.id === S.chat.id ? S.chat : c);
      chatMenu();
    }
  },
  'delete-chat': async (el) => {
    if (!confirm('Delete this chat permanently?')) return;
    await db.del('chats', el.dataset.id);
    S.chats = S.chats.filter((c) => c.id !== el.dataset.id);
    if (el.dataset.id === S.chat.id) { closeSheet(); go(`#/chat/${S.char.id}/${S.chats[0] ? S.chats[0].id : ''}`); render(); } else chatMenu();
  },
  'view-prompt': viewPrompt,
  'export-chat': exportChatChoice,
  'export-chat-standard': () => { closeSheet(); exportChat(false); },
  'export-chat-memory': () => { closeSheet(); exportChat(true); },
  'import-chat': importChat,

  'edit-back': () => {
    const d = S.draft;
    S.draft = null;
    go(d && !d.isNew ? `#/chat/${d.id}` : '#/');
  },
  'char-save': saveDraft,
  'char-avatar': async () => {
    const [f] = await pickFile('file-avatar');
    if (!f) return;
    collectDraft();
    try { S.draft.avatar = await blobToAvatar(f); renderEditView(S.draft._for); } catch (e) { toast(e.message); }
  },
  'alt-add': () => { collectDraft(); S.draft.alternate_greetings.push(''); renderEditView(S.draft._for); },
  'alt-del': (el) => { collectDraft(); S.draft.alternate_greetings.splice(+el.dataset.i, 1); renderEditView(S.draft._for); },
  'char-export-png': async () => { const c = collectDraft(); await saveFile(await exportCardPng(c), `${safeName(c.name)}.png`); },
  'char-export-json': async () => { const c = collectDraft(); await saveFile(new Blob([JSON.stringify(toV2(c), null, 2)], { type: 'application/json' }), `${safeName(c.name)}.json`); },
  'char-duplicate': async () => {
    const { _for, isNew, ...c } = structuredClone(collectDraft());
    const now = Date.now();
    Object.assign(c, { id: db.uid(), name: `${c.name} (copy)`, createdAt: now, updatedAt: now, lastChatAt: null, lastChatId: null });
    await db.put('characters', c);
    S.draft = null;
    toast('Duplicated');
    go(`#/edit/${c.id}`);
  },
  'char-delete': async () => {
    if (!confirm(`Delete ${S.draft.name} and all their chats?`)) return;
    const chats = await db.byIndex('chats', 'charId', S.draft.id);
    for (const c of chats) await db.del('chats', c.id);
    await db.del('characters', S.draft.id);
    S.draft = null;
    go('#/');
  },

  'preset-activate': (el) => { S.settings.activePreset = el.dataset.id; saveSettings(); toast('Preset activated'); render(); },
  'preset-apply-samplers': (el) => {
    const p = presetById(el.dataset.id);
    applyPresetSamplers(p);
    toast(`Applied: max tokens ${S.settings.preset.max_tokens}, context ${S.settings.preset.context_size}, temp ${S.settings.preset.temperature}`, 4000);
    rerenderSettings();
  },
  'preset-export': async (el) => {
    const p = presetById(el.dataset.id);
    await saveFile(new Blob([JSON.stringify(exportSTPreset(p), null, 2)], { type: 'application/json' }), `${safeName(p.name)}.json`);
  },
  'preset-delete': (el) => {
    const p = presetById(el.dataset.id);
    if (!confirm(`Delete preset "${p.name}"?`)) return;
    S.presets = S.presets.filter((x) => x.id !== p.id);
    if (S.settings.activePreset === p.id) S.settings.activePreset = null;
    savePresets(); saveSettings(); rerenderSettings();
  },
  'pm-edit': (el) => pmEdit(+el.dataset.i),
  'pm-save': (el) => {
    const p = presetById(S.pmId);
    const o = p.order[+el.dataset.i];
    const x = p.prompts.find((y) => y.identifier === o.identifier);
    x.name = $('#pm-name').value.trim() || x.name;
    x.role = $('#pm-role').value;
    x.injection_position = +$('#pm-pos').value;
    x.injection_depth = numOrNull($('#pm-depth').value) ?? 4;
    x.content = $('#pm-content').value;
    savePresets(); closeSheet(); renderPresetView(p.id);
  },
  'pm-move': (el) => {
    const p = presetById(S.pmId);
    const i = +el.dataset.i;
    const j = i + +el.dataset.dir;
    if (j < 0 || j >= p.order.length) return;
    [p.order[i], p.order[j]] = [p.order[j], p.order[i]];
    savePresets(); renderPresetView(p.id); pmEdit(j);
  },
  'pm-delete': (el) => {
    const p = presetById(S.pmId);
    const o = p.order[+el.dataset.i];
    if (!confirm('Delete this prompt?')) return;
    p.order.splice(+el.dataset.i, 1);
    p.prompts = p.prompts.filter((y) => y.identifier !== o.identifier);
    savePresets(); closeSheet(); renderPresetView(p.id);
  },
  'pm-add': () => {
    const p = presetById(S.pmId);
    const x = { identifier: db.uid(), name: 'New prompt', role: 'system', content: '', marker: false, system_prompt: false, injection_position: 0, injection_depth: 4, injection_order: 100, forbid_overrides: false };
    p.prompts.push(x);
    const hist = p.order.findIndex((o) => o.identifier === 'chatHistory');
    const at = hist >= 0 ? hist : p.order.length;
    p.order.splice(at, 0, { identifier: x.identifier, enabled: true });
    savePresets(); renderPresetView(p.id); pmEdit(at);
  },

  'lb-new': () => {
    const b = { id: db.uid(), name: 'New lorebook', global: false, entries: [] };
    S.lorebooks.push(b); saveLorebooks(); go(`#/lorebook/${b.id}`);
  },
  'lb-export': async () => {
    const b = bookById(S.lbId);
    await saveFile(new Blob([JSON.stringify(exportBook(b), null, 2)], { type: 'application/json' }), `${safeName(b.name)}.json`);
  },
  'lb-delete': () => {
    const b = bookById(S.lbId);
    if (!confirm(`Delete lorebook "${b.name}"?`)) return;
    S.lorebooks = S.lorebooks.filter((x) => x.id !== b.id);
    saveLorebooks(); go('#/settings/lorebooks');
  },
  'le-edit': (el) => leEdit(+el.dataset.i),
  'le-add': () => {
    const b = bookById(S.lbId);
    b.entries.push(normalizeEntry({ comment: '', key: [], content: '' }, b.entries.length));
    saveLorebooks(); renderLorebookView(b.id); leEdit(b.entries.length - 1);
  },
  'le-delete': (el) => {
    const b = bookById(S.lbId);
    if (!confirm('Delete this entry?')) return;
    b.entries.splice(+el.dataset.i, 1);
    saveLorebooks(); closeSheet(); renderLorebookView(b.id);
  },
  'le-save': (el) => {
    const b = bookById(S.lbId);
    const e = b.entries[+el.dataset.i];
    const names = splitList($('#le-chars').value);
    Object.assign(e, {
      comment: $('#le-comment').value.trim(),
      content: $('#le-content').value,
      constant: $('#le-constant').checked,
      keys: splitList($('#le-keys').value),
      secondary: splitList($('#le-secondary').value),
      selectiveLogic: +$('#le-logic').value,
      order: numOrNull($('#le-order').value) ?? 100,
      position: +$('#le-position').value,
      depth: numOrNull($('#le-depth').value) ?? 4,
      role: +$('#le-role').value,
      group: $('#le-group').value.trim(),
      probability: numOrNull($('#le-prob').value) ?? 100,
      groupOverride: $('#le-override').checked,
      characterFilter: names.length ? { isExclude: $('#le-exclude').checked, names, tags: [] } : null,
      matchWholeWords: $('#le-whole').checked,
      caseSensitive: $('#le-case').checked,
      matchPersonaDescription: $('#le-persona').checked,
      sticky: numOrNull($('#le-sticky').value) || 0,
      cooldown: numOrNull($('#le-cooldown').value) || 0,
      delay: numOrNull($('#le-delay').value) || 0,
    });
    saveLorebooks(); closeSheet(); renderLorebookView(b.id);
  },

  'rx-new': () => regexEdit(-1),
  'rx-edit': (el) => regexEdit(+el.dataset.i),
  'rx-save': (el) => {
    const i = +el.dataset.i;
    const base = i === -1 ? normalizeScript({ findRegex: '' }) : S.regex[i];
    const r = rxFromForm(base);
    if (i === -1) S.regex.push(r); else S.regex[i] = r;
    saveRegex(); closeSheet(); rerenderSettings();
  },
  'rx-delete': (el) => {
    if (!confirm('Delete this regex script?')) return;
    S.regex.splice(+el.dataset.i, 1);
    saveRegex(); closeSheet(); rerenderSettings();
  },
  'rx-export': async (el) => {
    const r = S.regex[+el.dataset.i];
    await saveFile(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }), `regex-${safeName(r.scriptName)}.json`);
  },

  'browse-models': browseModels,
  'pick-model': (el) => {
    const conn = activeConn();
    conn.model = el.dataset.id;
    const ctx = +el.dataset.ctx;
    if (ctx && S.settings.preset.context_size > ctx) {
      S.settings.preset.context_size = ctx;
      toast(`Context size lowered to ${ctx} to fit this model`);
    }
    saveSettings();
    closeSheet();
    rerenderSettings();
  },
  'test-conn': testConnection,
  'conn-new': () => { newConnection(); saveSettings(); rerenderSettings(); toast('Connection added — choose a provider and paste your key.', 3500); },
  'delete-conn': () => {
    if (!confirm('Delete this connection profile?')) return;
    S.settings.connections = S.settings.connections.filter((c) => c.id !== S.settings.activeConnection);
    S.settings.activeConnection = S.settings.connections[0]?.id || null;
    saveSettings();
    rerenderSettings();
  },
  'reset-preset': () => {
    if (!confirm('Reset generation settings to defaults?')) return;
    S.settings.preset = defaultSettings().preset;
    saveSettings();
    rerenderSettings();
  },
  'enhance-reset': () => { S.settings.ext.enhance.prompt = DEFAULT_ENHANCE_SETTINGS.prompt; saveSettings(); rerenderSettings(); },
  'reset-main': () => { S.settings.prompt.main = DEFAULT_MAIN; saveSettings(); rerenderSettings(); },
  'persona-avatar': async () => {
    const [f] = await pickFile('file-avatar');
    if (!f) return;
    activePersona().avatar = await blobToAvatar(f, 256);
    saveSettings();
    rerenderSettings();
  },
  'delete-persona': () => {
    if (!confirm('Delete this persona?')) return;
    S.settings.personas = S.settings.personas.filter((x) => x.id !== S.settings.activePersona);
    S.settings.activePersona = S.settings.personas[0].id;
    saveSettings();
    rerenderSettings();
  },
  'backup-export': exportBackup,
  'persona-import': importPersonas,
  'persona-export': exportPersona,
  'secret-clear': (el) => {
    if (!confirm('Remove this saved key?')) return;
    const p = el.dataset.path;
    if (p.startsWith('ext.')) { const [, g, k] = p.split('.'); S.settings.ext[g][k] = ''; } else setPath(p, '');
    saveSettings(true);
    rerenderSettings();
  },
  'backup-import': importBackup,
  wipe: async () => {
    if (!confirm('Delete ALL characters, chats and settings on this device?')) return;
    if (!confirm('Really? This cannot be undone.')) return;
    await db.clear('characters'); await db.clear('chats'); await db.clear('kv');
    S.presets = []; S.lorebooks = []; S.regex = []; S.groups = []; S.qr = []; drafts = {};
    S.settings = defaultSettings();
    applyLook();
    await saveSettings(true);
    go('#/');
  },
};

document.addEventListener('click', (e) => {
  if (e.target.closest('textarea, input, select, summary')) return;
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) {
    e.preventDefault();
    Promise.resolve(fn(el, e)).catch((err) => { console.error(err); toast(err.message || String(err), 5000); });
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.closest && el.closest('.sheet') && document.getElementById('rx-test-out')) updateRxTest();
  if ('secret' in el.dataset) return; // keys are saved on change (when you finish), never half-typed
  if (el.dataset.bind && el.tagName !== 'SELECT' && el.type !== 'checkbox') {
    let v = el.value;
    if ('num' in el.dataset) {
      if (v.trim() === '' || Number.isNaN(Number(v))) return;
      v = Number(v);
    }
    setPath(el.dataset.bind, v);
    saveSettings();
    if (/^(preset\.(context_size|max_tokens)|conn\.model)$/.test(el.dataset.bind)) {
      const ce = $('#cost-est'); if (ce) ce.innerHTML = costEstimateHtml();
    }
    if (el.dataset.bind === 'conn.name') {
      const opt = document.querySelector('select[data-change="select-conn"] option:checked');
      if (opt) opt.textContent = v || 'Connection';
    }
  } else if (el.dataset.input === 'home-search') {
    S.homeQuery = el.value;
    clearTimeout(S.searchTimer);
    S.searchTimer = setTimeout(async () => {
      await renderHome();
      const s = $('.search');
      if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }, 200);
  } else if (el.dataset.input === 'model-search') {
    renderModelList(el.value);
  } else if (el.dataset.input === 'pm-search' || el.dataset.input === 'lb-search') {
    const key = el.dataset.input === 'pm-search' ? 'pmQuery' : 'lbQuery';
    S[key] = el.value;
    clearTimeout(S.searchTimer);
    S.searchTimer = setTimeout(() => {
      if (key === 'pmQuery') renderPresetView(S.pmId); else renderLorebookView(S.lbId);
      const sEl = $('.search');
      if (sEl) { sEl.focus(); sEl.setSelectionRange(sEl.value.length, sEl.value.length); }
    }, 200);
  } else if ('qrName' in el.dataset || el.dataset.qrLabel || el.dataset.qrMessage) {
    const set = qrById(S.qrId);
    if ('qrName' in el.dataset) set.name = el.value;
    else {
      const b = set.buttons.find((x) => x.id === (el.dataset.qrLabel || el.dataset.qrMessage));
      if (b) b[el.dataset.qrLabel ? 'label' : 'message'] = el.value;
    }
    saveQr();
  } else if (el.dataset.extEnhance) {
    S.settings.ext.enhance[el.dataset.extEnhance] = el.value;
    saveSettings();
  } else if (el.dataset.ins) {
    const t = (S.settings.instruct.saved || []).find((x) => x.id === S.settings.instruct.template);
    if (t) { t[el.dataset.ins] = el.value; saveSettings(); }
  } else if (el.dataset.x) {
    const [g, k] = el.dataset.x.split('.');
    const numeric = ['maxImages', 'rate', 'topK', 'skipRecent', 'depth', 'minScore'].includes(k);
    S.settings.ext[g][k] = numeric ? (numOrNull(el.value) ?? S.settings.ext[g][k]) : el.value;
    saveSettings();
  } else if (el.dataset.extNdb) {
    const k = el.dataset.extNdb;
    S.settings.ext.database[k] = ['batchTokens','recentTokens','maxOutputTokens','depth'].includes(k) ? (numOrNull(el.value) ?? S.settings.ext.database[k]) : el.value;
    saveSettings();
  } else if (el.dataset.extMem) {
    const k = el.dataset.extMem;
    const numeric = ['verbatim', 'queued', 'memoryBudget', 'depth'].includes(k);
    S.settings.ext.memory[k] = numeric ? (numOrNull(el.value) ?? S.settings.ext.memory[k]) : el.value;
    saveSettings();
  } else if (el.dataset.apColor) {
    const a = S.settings.appearance;
    a.colors = { ...(a.colors || {}) };
    if (el.value.trim()) a.colors[el.dataset.apColor] = el.value.trim(); else delete a.colors[el.dataset.apColor];
    applyLook();
    const sw = el.parentElement.querySelector('.swatch');
    if (sw) sw.style.background = paletteOf(a)[el.dataset.apColor];
    saveSettings();
  } else if (el.dataset.apNum) {
    const v = numOrNull(el.value);
    if (v !== null) { S.settings.appearance[el.dataset.apNum] = v; applyLook(); saveSettings(); }
  } else if ('apCss' in el.dataset) {
    S.settings.appearance.customCss = el.value;
    applyLook();
    saveSettings();
  } else if (el.dataset.extSum) {
    const k = el.dataset.extSum;
    S.settings.ext.summarize[k] = ['words', 'every', 'depth'].includes(k) ? (numOrNull(el.value) ?? S.settings.ext.summarize[k]) : el.value;
    saveSettings();
  } else if ('lbName' in el.dataset) {
    const b = bookById(S.lbId);
    b.name = el.value;
    saveLorebooks();
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if ('secret' in el.dataset) {
    const v = el.value.trim();
    if (!v) return; // blank = keep the saved key (use Remove to delete it)
    if (el.dataset.x) { const [g, k] = el.dataset.x.split('.'); S.settings.ext[g][k] = v; } else setPath(el.dataset.bind, v);
    saveSettings(true);
    el.value = '';
    el.placeholder = secretHint(v);
    return;
  }
  if (el.dataset.bind && (el.type === 'checkbox' || el.tagName === 'SELECT')) {
    setPath(el.dataset.bind, el.type === 'checkbox' ? el.checked : el.value);
    saveSettings();
    if (el.dataset.bind === 'ui.fontSize') render();
    if (el.dataset.bind === 'ui.allowExternalMedia') saveSettings(true).then(() => location.reload());
    return;
  }
  if (el.dataset.extSumSelect === 'position') {
    S.settings.ext.summarize.position = el.value;
    saveSettings();
    rerenderSettings();
    return;
  }
  if ('num' in el.dataset && el.dataset.bind) el.value = getPath(el.dataset.bind);
  if ('qrVisible' in el.dataset) {
    qrById(S.qrId).visible = el.checked;
    saveQr();
    return;
  }
  if (el.dataset.qrToggle) {
    qrById(el.dataset.qrToggle).visible = el.checked;
    saveQr();
    return;
  }
  if (el.dataset.extEnhanceToggle) {
    S.settings.ext.enhance[el.dataset.extEnhanceToggle] = el.checked;
    saveSettings();
    return;
  }
  if (el.dataset.folderTag) {
    const L = lib();
    const set = new Set(L.folders || []);
    if (el.checked) set.add(el.dataset.folderTag); else set.delete(el.dataset.folderTag);
    L.folders = [...set];
    saveSettings();
    if (route().name === 'home') renderHome();
    return;
  }
  if (el.dataset.insSelect) {
    const t = (S.settings.instruct.saved || []).find((x) => x.id === S.settings.instruct.template);
    if (t) { t[el.dataset.insSelect] = el.value; saveSettings(); }
    return;
  }
  if (el.dataset.xToggle || el.dataset.xSelect) {
    const [g, k] = (el.dataset.xToggle || el.dataset.xSelect).split('.');
    S.settings.ext[g][k] = el.dataset.xToggle ? el.checked : el.value;
    saveSettings();
    rerenderSettings();
    return;
  }
  if (el.dataset.extNdbToggle || el.dataset.extNdbSelect) {
    const key = el.dataset.extNdbToggle || el.dataset.extNdbSelect;
    S.settings.ext.database[key] = el.dataset.extNdbToggle ? el.checked : el.value;
    if (key === 'enabled' && el.checked) {
      S.settings.ext.summarize.enabled = false;
      S.settings.ext.memory.enabled = false;
    }
    saveSettings(); rerenderSettings(); return;
  }
  if (el.dataset.extMemToggle) {
    S.settings.ext.memory[el.dataset.extMemToggle] = el.checked;
    if (el.dataset.extMemToggle === 'enabled' && el.checked) S.settings.ext.database.enabled = false;
    saveSettings();
    rerenderSettings();
    return;
  }
  if (el.dataset.extMemSelect) {
    S.settings.ext.memory[el.dataset.extMemSelect] = el.value;
    saveSettings();
    rerenderSettings();
    return;
  }
  if (el.dataset.apToggle) {
    S.settings.appearance[el.dataset.apToggle] = el.checked;
    saveSettings();
    applyLook();
    return;
  }
  if (el.dataset.apSelect) {
    const a = S.settings.appearance;
    a[el.dataset.apSelect] = el.value;
    if (el.dataset.apSelect === 'theme') a.colors = {};
    applyLook();
    saveSettings();
    rerenderSettings();
    return;
  }
  if (el.dataset.extSumToggle) {
    S.settings.ext.summarize[el.dataset.extSumToggle] = el.checked;
    if (el.dataset.extSumToggle === 'enabled' && el.checked) S.settings.ext.database.enabled = false;
    saveSettings();
    return;
  }
  if (el.dataset.extSumSelect) {
    S.settings.ext.summarize[el.dataset.extSumSelect] = el.value;
    saveSettings();
    return;
  }
  if (el.dataset.gMember) {
    const g = collectGroupDraft();
    renderGroupEditor(g.isNew ? 'new' : g.id);
    return;
  }
  if (el.dataset.presetRx) {
    const p = presetById(S.pmId);
    p.runPresetRegex = el.checked;
    savePresets();
    return;
  }
  if (el.dataset.pmToggle !== undefined) {
    const p = presetById(S.pmId);
    p.order[+el.dataset.pmToggle].enabled = el.checked;
    el.closest('.pm-row').classList.toggle('off', !el.checked);
    savePresets();
    return;
  }
  if (el.dataset.leToggle !== undefined) {
    const b = bookById(S.lbId);
    b.entries[+el.dataset.leToggle].enabled = el.checked;
    el.closest('.pm-row').classList.toggle('off', !el.checked);
    saveLorebooks();
    return;
  }
  if (el.dataset.lbGlobal) {
    bookById(el.dataset.lbGlobal).global = el.checked;
    saveLorebooks();
    return;
  }
  if (el.dataset.rxToggle !== undefined) {
    S.regex[+el.dataset.rxToggle].disabled = !el.checked;
    saveRegex();
    return;
  }
  if (el.dataset.personaBook) {
    const per = activePersona();
    const set = new Set(per.lorebooks || []);
    if (el.checked) set.add(el.dataset.personaBook); else set.delete(el.dataset.personaBook);
    per.lorebooks = [...set];
    saveSettings();
    return;
  }
  const c = el.dataset.change;
  if (c === 'select-conn') {
    if (el.value === '__new') newConnection();
    else S.settings.activeConnection = el.value;
    saveSettings();
    rerenderSettings();
  } else if (c === 'text-server') {
    const srv = TEXT_SERVERS[+el.value];
    if (srv) { activeConn().baseUrl = srv[1]; saveSettings(); rerenderSettings(); if (srv[2]) toast(srv[2], 6000); }
  } else if (c === 'conn-provider') {
    const conn = activeConn();
    const oldLabel = PROVIDERS[conn.provider].label;
    conn.provider = el.value;
    if (!conn.name || conn.name === oldLabel || conn.name === 'OpenRouter') conn.name = PROVIDERS[el.value].label;
    conn.model = '';
    saveSettings();
    rerenderSettings();
  } else if (c === 'lib-sort') {
    lib().sort = el.value;
    saveSettings();
    renderHome();
  } else if (c === 'instruct-template') {
    S.settings.instruct.template = el.value;
    saveSettings();
    rerenderSettings();
  } else if (c === 'select-preset') {
    S.settings.activePreset = el.value || null;
    // Like SillyTavern: picking a preset also loads its generation settings.
    const picked = activePreset();
    if (picked) applyPresetSamplers(picked);
    saveSettings();
    if (route().name === 'settings') rerenderSettings();
    else { closeSheet(); toast(`Preset: ${picked ? picked.name : 'Simple'}`); }
  } else if (c === 'select-persona') {
    if (el.value === '__new') {
      const p = { id: db.uid(), name: 'New persona', description: '', avatar: null };
      S.settings.personas.push(p);
      S.settings.activePersona = p.id;
    } else S.settings.activePersona = el.value;
    saveSettings();
    rerenderSettings();
  }
});

document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || route().name !== 'chat') return;
  if (!S.settings.ext.enhance.enabled || !S.settings.ext.enhance.keyboardShortcut) return;
  if (e.code === 'KeyE') { e.preventDefault(); enhanceDraft(); } else if (e.code === 'KeyZ') { e.preventDefault(); restoreDraft(); }
});

// ---------- icons (inline SVG) ----------
const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const ICONS = {
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  import: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/>'),
  share: svg('<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M16 6l-4-4-4 4M12 2v13"/>', 'width="16" height="16" style="vertical-align:-3px"'),
  dots: svg('<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'),
  send: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'),
  left: svg('<path d="M15 18l-6-6 6-6"/>', 'width="18" height="18"'),
  right: svg('<path d="M9 18l6-6-6-6"/>', 'width="18" height="18"'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', 'width="18" height="18"'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 'width="18" height="18"'),
  trash: svg('<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>', 'width="18" height="18"'),
  refresh: svg('<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.8-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>', 'width="18" height="18"'),
  branch: svg('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11 7"/>', 'width="18" height="18"'),
  wand: svg('<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5"/>'),
  forward: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3.2-5.5 7-5.5s7 2 7 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2.3.7 4 2.4 4 5.2"/>'),
  note: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', 'width="18" height="18"'),
  sort: svg('<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>', 'width="16" height="16"'),
  link: svg('<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.8"/><path d="M21 15l-5-5L5 21"/>'),
  speaker: svg('<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>', 'width="18" height="18"'),
  globe: svg('<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>', 'width="18" height="18"'),
  layers: svg('<path d="M12 2l10 5-10 5L2 7z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>'),
  sliders: svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
  close: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  eye: svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
};

// ---------- boot ----------
// Forbid external media (SillyTavern's default): a browser-enforced policy,
// so message HTML, regex output and theme CSS can't load images, video,
// audio or fonts from arbitrary sites. Google Fonts stay allowed for themes.
// Applied once at startup, before anything is drawn; changing it reloads.
function applyMediaPolicy() {
  const allow = !!S.settings.ui.allowExternalMedia;
  setExternalMedia(allow);
  if (allow) return;
  const m = document.createElement('meta');
  m.httpEquiv = 'Content-Security-Policy';
  m.content = "img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com";
  document.head.appendChild(m);
}

async function boot() {
  fitViewport();
  let settings = null;
  try { settings = await db.get('kv', 'settings'); } catch (e) { console.error(e); }
  const def = defaultSettings();
  S.settings = settings ? {
    ...def, ...settings,
    preset: { ...def.preset, ...settings.preset },
    prompt: { ...def.prompt, ...settings.prompt },
    ui: { ...def.ui, ...settings.ui },
    instruct: { ...def.instruct, ...(settings.instruct || {}) },
    ext: {
      enhance: { ...def.ext.enhance, ...((settings.ext || {}).enhance || {}) },
      summarize: { ...def.ext.summarize, ...((settings.ext || {}).summarize || {}) },
      memory: { ...def.ext.memory, ...((settings.ext || {}).memory || {}) },
      database: { ...def.ext.database, ...((settings.ext || {}).database || {}) },
      ...Object.fromEntries(Object.keys(X.DEFAULT_EXT).map((k) => [k, { ...def.ext[k], ...((settings.ext || {})[k] || {}) }])),
    },
    appearance: { ...def.appearance, ...(settings.appearance || {}) },
  } : def;
  if (!S.settings.personas || !S.settings.personas.length) { S.settings.personas = def.personas; S.settings.activePersona = def.activePersona; }
  await V.loadSecrets(S.settings);
  // Older versions stored keys in plain text: move them into the vault now.
  const plainKeys = settings && Object.keys(V.takeSecrets(structuredClone(settings))).length;
  if (!settings || plainKeys) await saveSettings(true);
  applyMediaPolicy();
  await applyLook();
  try { drafts = (await db.get('kv', 'drafts')) || {}; } catch { drafts = {}; }
  for (const key of ['presets', 'lorebooks', 'regex', 'groups', 'qr']) {
    try { S[key] = (await db.get('kv', key)) || []; } catch { S[key] = []; }
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await render();
  S.booted = true;
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
}

boot();
