// LLM backends: OpenRouter, any OpenAI-compatible endpoint, and Claude (Anthropic API).

export const PROVIDERS = {
  openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', kind: 'openai', needsUrl: false },
  openai: { label: 'OpenAI-compatible', base: 'https://api.openai.com/v1', kind: 'openai', needsUrl: true },
  anthropic: { label: 'Claude (Anthropic)', base: 'https://api.anthropic.com/v1', kind: 'anthropic', needsUrl: false },
  textcomp: { label: 'Text completion (KoboldCpp, Ollama, LM Studio, ooba…)', base: 'http://localhost:5001/v1', kind: 'text', needsUrl: true },
};

export const TEXT_SERVERS = [
  ['KoboldCpp', 'http://localhost:5001/v1', 'Tick "Remote Tunnel" in KoboldCpp to get an https address for your phone.'],
  ['Ollama', 'http://localhost:11434/v1', 'Start Ollama with OLLAMA_ORIGINS=* so browsers may connect.'],
  ['LM Studio', 'http://localhost:1234/v1', 'Developer tab → enable CORS and "Serve on local network".'],
  ['text-generation-webui (ooba)', 'http://localhost:5000/v1', 'Start with --api (and --listen for other devices).'],
  ['llama.cpp server', 'http://localhost:8080/v1', 'Run llama-server with --host 0.0.0.0.'],
  ['TabbyAPI', 'http://localhost:5000/v1', ''],
];

const kindOf = (conn) => (PROVIDERS[conn.provider] || PROVIDERS.openai).kind;

export function baseUrl(conn) {
  const p = PROVIDERS[conn.provider] || PROVIDERS.openai;
  return ((p.needsUrl && conn.baseUrl) ? conn.baseUrl : p.base).trim().replace(/\/+$/, '');
}

// If a browser refuses OpenRouter's optional attribution headers, we stop sending them.
let openrouterPlain = false;

function headers(conn, json = true, plain = false) {
  const h = {};
  if (json) h['content-type'] = 'application/json';
  if (kindOf(conn) === 'anthropic') {
    h['x-api-key'] = conn.apiKey || '';
    h['anthropic-version'] = '2023-06-01';
    h['anthropic-dangerous-direct-browser-access'] = 'true';
    return h;
  }
  if (conn.apiKey) h.authorization = `Bearer ${conn.apiKey}`;
  if (conn.provider === 'openrouter' && !plain && !openrouterPlain) {
    h['HTTP-Referer'] = location.origin;
    h['X-Title'] = 'PocketTavern';
  }
  return h;
}

async function apiError(resp) {
  let msg = '';
  let detail = '';
  let providerName = '';
  try {
    const text = await resp.text();
    detail = text.slice(0, 4000);
    try {
      const j = JSON.parse(text);
      msg = (j.error && (j.error.message || j.error)) || j.message || text;
      if (j.error && j.error.metadata && j.error.metadata.raw) msg += ` — ${j.error.metadata.raw}`;
      providerName = (j.error && j.error.metadata && j.error.metadata.provider_name) || '';
    } catch { msg = text; }
  } catch { /* ignore */ }
  if (typeof msg !== 'string') msg = JSON.stringify(msg);
  const err = new Error(`HTTP ${resp.status}${msg ? ': ' + msg.slice(0, 500) : ''}`);
  err.status = resp.status;
  err.detail = detail;
  err.providerName = providerName;
  return err;
}

/** An error sent inside an otherwise successful (streamed) response. */
function streamError(errObj, info) {
  const e = errObj || {};
  const raw = e.metadata && e.metadata.raw ? ` — ${String(e.metadata.raw).slice(0, 300)}` : '';
  const err = new Error((e.message || (typeof e === 'string' ? e : JSON.stringify(e))) + raw);
  err.status = Number(e.code) || undefined;
  err.detail = JSON.stringify(e).slice(0, 4000);
  err.providerName = (e.metadata && e.metadata.provider_name) || (info && info.provider) || '';
  return err;
}

// Every generation is reported here (the app keeps an activity log).
let genLogger = null;
export function setGenerateLogger(fn) { genLogger = fn; }

function networkError(e, conn) {
  if (e.name === 'AbortError') return e;
  let hint = `Network error — could not reach ${hostOf(conn)}${e && e.message ? ` (${e.message})` : ''}.`;
  const url = baseUrl(conn);
  if (url.startsWith('http://') && location.protocol === 'https:') {
    hint += ' This app runs on HTTPS, so phone browsers block plain http:// endpoints. Use an https:// URL (e.g. a tunnel).';
  } else if ((PROVIDERS[conn.provider] || {}).needsUrl) {
    hint += ' The server may not allow browser requests (CORS must be enabled on it).';
  }
  const err = new Error(hint);
  err.cause = e;
  return err;
}

function hostOf(conn) {
  try { return new URL(baseUrl(conn)).host; } catch { return 'the server'; }
}

async function doFetch(conn, url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    // Retry OpenRouter once without the optional attribution headers (some browsers/blockers reject them).
    if (e.name !== 'AbortError' && conn.provider === 'openrouter' && !openrouterPlain && opts && opts.headers && opts.headers['X-Title']) {
      const h = { ...opts.headers };
      delete h['HTTP-Referer'];
      delete h['X-Title'];
      try {
        const r = await fetch(url, { ...opts, headers: h });
        openrouterPlain = true;
        return r;
      } catch { /* fall through */ }
    }
    throw networkError(e, conn);
  }
}

/**
 * Explain a connection failure: can this device reach the provider at all?
 * (A plain GET with no headers needs no CORS preflight, so it isolates network/blocker problems.)
 */
export async function diagnose(conn) {
  const host = hostOf(conn);
  const probe = conn.provider === 'anthropic' ? 'https://api.anthropic.com/v1/models' : `${baseUrl(conn)}/models`;
  try {
    await fetch(probe, { method: 'GET', mode: 'cors', cache: 'no-store' });
    return `This device can reach ${host}, so the problem is with the request itself — check the key and model, or try again.`;
  } catch {
    try {
      await fetch(probe, { method: 'GET', mode: 'no-cors', cache: 'no-store' });
      return `${host} answers, but blocks requests from this web app (CORS). For OpenRouter/Claude this shouldn't happen — tell Claude in the chat.`;
    } catch {
      return `This device can't reach ${host} at all. Something is blocking it: a content blocker or ad-block app, a VPN or DNS filter (e.g. NextDNS), iCloud Private Relay, Android's Private DNS setting, or a work/school Wi-Fi. Try turning those off, or switch to mobile data, then test again.`;
    }
  }
}

export async function listModels(conn) {
  const anth = kindOf(conn) === 'anthropic';
  const url = baseUrl(conn) + '/models' + (anth ? '?limit=1000' : '');
  const resp = await doFetch(conn, url, { headers: conn.provider === 'openrouter' ? {} : headers(conn, false) });
  if (!resp.ok) throw await apiError(resp);
  const j = await resp.json();
  const arr = Array.isArray(j) ? j : (j.data || j.models || []);
  return arr.map((m) => {
    const id = m.id || m.name;
    let price = '';
    if (m.pricing && m.pricing.prompt != null) {
      const inp = parseFloat(m.pricing.prompt) * 1e6;
      const out = parseFloat(m.pricing.completion) * 1e6;
      price = (inp === 0 && out === 0) ? 'free' : `$${+inp.toFixed(2)}/$${+out.toFixed(2)} per M`;
    }
    return {
      id,
      name: m.name || m.display_name || id,
      ctx: m.context_length || m.max_input_tokens || null,
      price,
      // US dollars per token, when the API publishes prices (OpenRouter does).
      inPrice: m.pricing && m.pricing.prompt != null ? parseFloat(m.pricing.prompt) || 0 : null,
      outPrice: m.pricing && m.pricing.completion != null ? parseFloat(m.pricing.completion) || 0 : null,
    };
  }).filter((m) => m.id);
}

async function* sseLines(resp, signal) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (signal && signal.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
    if (buf.startsWith('data:')) yield buf.slice(5).trim();
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

function openaiBody(conn, preset, messages) {
  const body = {
    model: conn.model,
    messages: messages.map((m) => (Array.isArray(m.images) && m.images.length
      ? { role: m.role, content: [{ type: 'text', text: m.content || ' ' }, ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))] }
      : { role: m.role, content: m.content })),
    max_tokens: preset.max_tokens,
    temperature: preset.temperature,
    top_p: preset.top_p,
    stream: !!preset.stream,
  };
  if (preset.frequency_penalty) body.frequency_penalty = preset.frequency_penalty;
  if (preset.presence_penalty) body.presence_penalty = preset.presence_penalty;
  // Extended samplers: only sent when changed from neutral, so strict APIs don't reject them.
  if (preset.top_k > 0) body.top_k = preset.top_k;
  if (preset.min_p > 0) body.min_p = preset.min_p;
  if (preset.repetition_penalty && preset.repetition_penalty !== 1) body.repetition_penalty = preset.repetition_penalty;
  if (conn.provider === 'openrouter') {
    // Same as SillyTavern: include_reasoning follows "show reasoning" (false asks
    // OpenRouter to leave the thinking out without turning thinking on), and an
    // effort is only sent when one is chosen (Auto = the model's own default).
    body.include_reasoning = !!preset.show_thoughts;
    if (['low', 'medium', 'high'].includes(preset.claude_effort)) body.reasoning = { effort: preset.claude_effort };
  }
  return body;
}

/** Convert generic messages to the Anthropic shape (top-level system, strict user/assistant alternation). */
export function toAnthropic(messages) {
  const system = [];
  const out = [];
  let leading = true;
  const blocksOf = (m) => {
    const b = [];
    // Images are only allowed in user turns.
    if (Array.isArray(m.images) && m.role !== 'assistant') {
      for (const url of m.images) {
        const mm = String(url).match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
        if (mm) b.push({ type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } });
      }
    }
    if (m.content) b.push({ type: 'text', text: m.content });
    return b;
  };
  for (const m of messages) {
    if (m.role === 'system' && leading) { if (m.content) system.push(m.content); continue; }
    leading = false;
    const role = m.role === 'system' ? 'user' : m.role; // like SillyTavern: later system prompts become user turns
    const blocks = blocksOf(m);
    if (!blocks.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.blocks.push(...blocks);
    else out.push({ role, blocks });
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', blocks: [{ type: 'text', text: '[Start of the chat]' }] });
  // Current Claude models don't allow assistant prefill, so the request must end on a user turn.
  if (out[out.length - 1].role === 'assistant') out.push({ role: 'user', blocks: [{ type: 'text', text: '[Continue]' }] });
  const finish = ({ role, blocks }) => {
    const merged = [];
    for (const b of blocks) {
      const prev = merged[merged.length - 1];
      if (b.type === 'text' && prev && prev.type === 'text') prev.text += '\n\n' + b.text;
      else merged.push({ ...b });
    }
    return { role, content: merged.every((b) => b.type === 'text') ? merged.map((b) => b.text).join('\n\n') : merged };
  };
  return { system: system.join('\n\n'), messages: out.map(finish) };
}

function anthropicBody(conn, preset, messages) {
  const { system, messages: msgs } = toAnthropic(messages);
  const body = {
    model: conn.model,
    max_tokens: preset.max_tokens,
    messages: msgs,
    stream: !!preset.stream,
  };
  if (system) body.system = system;
  // Newer Claude models reject sampling params, so they're opt-in (for older models).
  if (preset.claude_sampling) body.temperature = Math.min(1, Math.max(0, preset.temperature));
  if (preset.claude_effort) body.output_config = { effort: preset.claude_effort };
  // Summarized thinking so it can be shown (Claude 4.6+; older models need this off).
  if (preset.show_thoughts) body.thinking = { type: 'adaptive', display: 'summarized' };
  return body;
}

/** "<think>…</think>" at the start of a reply → reasoning (like SillyTavern's reasoning auto-parse). */
export function splitThink(raw, prefix, suffix) {
  const t = raw.replace(/^\s+/, '');
  if (!prefix) return null;
  if (t.length < prefix.length && prefix.startsWith(t)) return { reasoning: '', text: '' }; // prefix still arriving
  if (!t.startsWith(prefix)) return null;
  const end = suffix ? t.indexOf(suffix, prefix.length) : -1;
  if (end < 0) return { reasoning: t.slice(prefix.length).replace(/^\s+/, ''), text: '' };
  return { reasoning: t.slice(prefix.length, end).trim(), text: t.slice(end + suffix.length).replace(/^\s+/, '') };
}

function earliestStop(text, stops) {
  let best = -1;
  for (const s of stops) {
    if (!s) continue;
    const i = text.indexOf(s);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

/**
 * Generate a reply. onToken(fullTextSoFar, reasoningSoFar) is called while streaming.
 * stop: stopping strings (sent to the API where supported, and always enforced here).
 * think: { prefix, suffix } to move a leading <think> block into the reasoning.
 * Resolves to the final text.
 */
export async function generate(conn, preset, messages, opts = {}) {
  const info = { purpose: opts.purpose || 'background' };
  const started = Date.now();
  let text = '';
  let error = null;
  try {
    text = await generateInner(conn, preset, messages, opts, info);
    return text;
  } catch (e) {
    error = e;
    throw e;
  } finally {
    if (genLogger) {
      try {
        genLogger({
          ...info, conn, preset, messages, ms: Date.now() - started, text: text || '',
          aborted: !!(opts.signal && opts.signal.aborted) || (error && error.name === 'AbortError'), error,
        });
      } catch { /* logging must never break a reply */ }
    }
  }
}

async function generateInner(conn, preset, messages, { signal, onToken, stop = [], think = null, textFormat = null } = {}, info = {}) {
  if (!conn) throw new Error('No API connection set up. Go to Settings → Connection.');
  const kind = kindOf(conn);
  if (!conn.model && kind !== 'text') throw new Error('No model selected. Go to Settings → Connection.');
  const anth = kind === 'anthropic';
  const text = kind === 'text';
  const url = baseUrl(conn) + (anth ? '/messages' : text ? '/completions' : '/chat/completions');
  stop = (stop || []).filter((x) => typeof x === 'string' && x.length);
  let body;
  if (text) {
    // Text completion: the chat is formatted into one prompt with the instruct template.
    const fmt = textFormat ? textFormat(messages) : { prompt: messages.map((m) => `${m.role}: ${m.content}`).join('\n') + '\nassistant:', stop: [] };
    stop = [...new Set([...stop, ...fmt.stop])];
    body = { ...openaiBody(conn, preset, []), prompt: fmt.prompt };
    delete body.messages;
    if (!conn.model) delete body.model;
    if (stop.length) body.stop = stop.slice(0, 16);
  } else body = anth ? anthropicBody(conn, preset, messages) : openaiBody(conn, preset, messages);
  if (stop.length && !text) {
    if (anth) { const seq = stop.filter((x) => x.trim()).slice(0, 8); if (seq.length) body.stop_sequences = seq; }
    else if (!/api\.openai\.com/.test(url)) body.stop = stop.slice(0, 4); // OpenAI's newer models reject `stop`
  }
  info.stream = !!body.stream;
  info.maxTokens = body.max_tokens ?? body.max_completion_tokens ?? null;
  const resp = await doFetch(conn, url, { method: 'POST', headers: headers(conn), body: JSON.stringify(body), signal });
  info.http = resp.status;
  if (!resp.ok) throw await apiError(resp);

  let raw = '';
  let native = '';
  let stopped = false;
  const view = () => {
    let text = raw;
    let reasoning = native;
    const sp = think && think.prefix ? splitThink(raw, think.prefix, think.suffix || '') : null;
    if (sp) { text = sp.text; reasoning = [native, sp.reasoning].filter(Boolean).join('\n'); }
    const cut = stop.length ? earliestStop(text, stop) : -1;
    if (cut >= 0) { text = text.slice(0, cut); stopped = true; }
    return { text, reasoning };
  };
  const emit = () => { const v = view(); if (onToken) onToken(v.text, v.reasoning); return v; };

  if (!body.stream) {
    const j = await resp.json();
    if (anth) {
      raw = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      native = (j.content || []).filter((b) => b.type === 'thinking').map((b) => b.thinking || '').join('\n');
      Object.assign(info, { id: j.id, model: j.model, finish: j.stop_reason, usage: j.usage, reasoningChars: native.length });
      if (!raw && j.stop_reason === 'refusal') throw new Error('Claude declined to respond (refusal).');
    } else {
      const c0 = j.choices && j.choices[0];
      Object.assign(info, { id: j.id, model: j.model, provider: j.provider, finish: c0 && c0.finish_reason, nativeFinish: c0 && c0.native_finish_reason, usage: j.usage });
      if (j.error) throw streamError(j.error, info);
      raw = (j.choices && j.choices[0] && (j.choices[0].message?.content ?? j.choices[0].text)) || j.content || '';
      const m = j.choices && j.choices[0] && j.choices[0].message;
      native = (m && (m.reasoning || m.reasoning_content)) || '';
      info.reasoningChars = native.length;
    }
    return emit().text;
  }

  let stopReason = null;
  try {
    for await (const data of sseLines(resp, signal)) {
      if (!data) continue;
      if (data === '[DONE]') break;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (anth) {
        if (j.type === 'message_start' && j.message) {
          info.id = j.message.id; info.model = j.message.model; info.usage = { ...(j.message.usage || {}) };
        }
        if (j.type === 'message_delta' && j.usage) info.usage = { ...(info.usage || {}), ...j.usage };
        if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'thinking_delta') {
          native += j.delta.thinking || '';
          emit();
        } else if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') {
          raw += j.delta.text;
          emit();
        } else if (j.type === 'message_delta' && j.delta) {
          stopReason = j.delta.stop_reason || stopReason;
        } else if (j.type === 'error') {
          throw streamError(j.error || { message: 'Stream error' }, info);
        }
      } else {
        if (j.id && !info.id) info.id = j.id;
        if (j.model && !info.model) info.model = j.model;
        if (j.provider && !info.provider) info.provider = j.provider;
        if (j.usage) info.usage = j.usage;
        if (j.error) throw streamError(j.error, info);
        const choice = j.choices && j.choices[0];
        if (choice && choice.finish_reason) info.finish = choice.finish_reason;
        if (choice && choice.native_finish_reason) info.nativeFinish = choice.native_finish_reason;
        const rd = choice && choice.delta && (choice.delta.reasoning || choice.delta.reasoning_content);
        if (rd) { native += rd; emit(); }
        const delta = choice && ((choice.delta && choice.delta.content) || choice.text);
        if (delta) { raw += delta; emit(); }
      }
      if (stopped) break;
    }
  } catch (e) {
    if (e.name === 'AbortError') return view().text;
    if (e instanceof TypeError) throw networkError(e, conn);
    throw e;
  }
  if (stopped) { try { resp.body && resp.body.cancel(); } catch { /* already released */ } }
  if (anth && stopReason) info.finish = stopReason;
  if (stopped) info.stopString = true;
  info.reasoningChars = native.length;
  const out = view();
  if (!out.text && !raw && stopReason === 'refusal') throw new Error('Claude declined to respond (refusal).');
  return out.text;
}

// ---------- image generation ----------
/** Returns an image as a data: URL (or an https URL for Pollinations when it can't be fetched). */
export async function generateImage(cfg, conn, prompt, { width = 1024, height = 1024, signal } = {}) {
  const full = [cfg.style, prompt].filter((x) => x && x.trim()).join(', ');
  if (cfg.provider === 'pollinations') {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(full)}?width=${width}&height=${height}&nologo=true&seed=${Math.floor(Math.random() * 1e9)}${cfg.negative ? `&negative=${encodeURIComponent(cfg.negative)}` : ''}`;
    try {
      const r = await fetch(url, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await blobToDataUrl(await r.blob());
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return url; // displayed directly; can't be embedded in exports
    }
  }
  if (cfg.provider === 'openrouter') {
    const key = cfg.apiKey || (conn && conn.provider === 'openrouter' ? conn.apiKey : '');
    if (!key) throw new Error('Image generation needs an OpenRouter key (set it in Settings → Extensions → Image generation, or use an OpenRouter connection).');
    const body = {
      model: cfg.model || 'google/gemini-2.5-flash-image',
      messages: [{ role: 'user', content: `Generate an image: ${full}${cfg.negative ? `\nAvoid: ${cfg.negative}` : ''}` }],
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: cfg.aspect || '1:1' },
    };
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'HTTP-Referer': location.origin, 'X-Title': 'PocketTavern' },
      body: JSON.stringify(body),
    }).catch((e) => { throw networkError(e, { provider: 'openrouter' }); });
    if (!r.ok) throw await apiError(r);
    const j = await r.json();
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    const img = msg && Array.isArray(msg.images) && msg.images[0];
    const url = img && ((img.image_url && img.image_url.url) || img.url);
    if (!url) throw new Error(`The model didn't return an image${msg && msg.content ? `: ${String(msg.content).slice(0, 200)}` : ''}. Pick an image model (e.g. google/gemini-2.5-flash-image).`);
    return url.startsWith('data:') ? url : blobToDataUrl(await (await fetch(url)).blob());
  }
  // OpenAI-compatible /images/generations
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const body = { model: cfg.model || 'gpt-image-1', prompt: full, n: 1, size: `${width}x${height}` };
  if (/dall-e/i.test(body.model)) body.response_format = 'b64_json';
  const r = await fetch(`${base}/images/generations`, {
    method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` }, body: JSON.stringify(body),
  }).catch((e) => { throw networkError(e, { provider: 'openai', baseUrl: base }); });
  if (!r.ok) throw await apiError(r);
  const j = await r.json();
  const d = j.data && j.data[0];
  if (d && d.b64_json) return `data:image/png;base64,${d.b64_json}`;
  if (d && d.url) return blobToDataUrl(await (await fetch(d.url)).blob());
  throw new Error('No image in the response');
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

// ---------- text to speech ----------
export async function ttsAudio(cfg, text, voice, signal) {
  if (cfg.provider === 'elevenlabs') {
    if (!voice) throw new Error('Pick an ElevenLabs voice first.');
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: 'POST', signal, headers: { 'content-type': 'application/json', 'xi-api-key': cfg.apiKey },
      body: JSON.stringify({ text, model_id: cfg.model && /eleven/i.test(cfg.model) ? cfg.model : 'eleven_multilingual_v2' }),
    });
    if (!r.ok) throw await apiError(r);
    return r.blob();
  }
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const r = await fetch(`${base}/audio/speech`, {
    method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model || 'gpt-4o-mini-tts', voice: voice || 'alloy', input: text, speed: Number(cfg.rate) || 1 }),
  });
  if (!r.ok) throw await apiError(r);
  return r.blob();
}

export async function listElevenVoices(apiKey) {
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': apiKey } });
  if (!r.ok) throw await apiError(r);
  const j = await r.json();
  return (j.voices || []).map((v) => ({ id: v.voice_id, name: v.name }));
}

// ---------- embeddings (chat recall) ----------
export async function embed(cfg, inputs) {
  const base = (cfg.embBase || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const r = await fetch(`${base}/embeddings`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.embKey}` },
    body: JSON.stringify({ model: cfg.embModel || 'text-embedding-3-small', input: inputs }),
  });
  if (!r.ok) throw await apiError(r);
  const j = await r.json();
  return (j.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
}
