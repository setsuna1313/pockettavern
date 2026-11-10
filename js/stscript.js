// STscript (SillyTavern slash commands) — a large, practical subset:
// pipes and {{pipe}}, {: closures :}, /if /while /times /run /return /break /abort,
// chat variables (/setvar…), scoped variables (/let /var, {{var::name}}), math and text commands,
// chat commands (/send /sendas /sys /trigger /gen /messages /del /addswipe …), /buttons /input /popup /qr.

class Closure {
  constructor(body, scope) { this.body = body; this.scope = scope; }
  toString() { return `{:${this.body}:}`; }
}
class Signal extends Error {
  constructor(type, value = '') { super(type); this.type = type; this.value = value; }
}

/** Split a script into commands on top-level | (respecting quotes, {{macros}} and {: closures :}). */
export function splitPipes(src) {
  const out = [];
  let cur = '';
  let quote = false;
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (c === '\\' && i + 1 < src.length) { cur += src[i + 1] === '|' && !depth ? '|' : c + src[i + 1]; i++; continue; }
    if (!depth && c === '"') quote = !quote;
    if (!quote) {
      if (two === '{{' || two === '{:') { depth++; cur += two; i++; continue; }
      if ((two === '}}' || two === ':}') && depth) { depth--; cur += two; i++; continue; }
      if (c === '|' && !depth) { out.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s && !s.startsWith('//'));
}

/** Read one value at position i: {: closure :}, "quoted", [list], {{macro}} or a bare word. */
function readValue(s, i) {
  const two = s.slice(i, i + 2);
  if (two === '{:') {
    let depth = 0;
    for (let j = i; j < s.length - 1; j++) {
      const t = s.slice(j, j + 2);
      if (t === '{:') { depth++; j++; } else if (t === ':}') { depth--; j++; if (!depth) return { value: { closure: s.slice(i + 2, j - 1) }, end: j + 1 }; }
    }
    throw new Error('Unclosed {: … :} block');
  }
  if (s[i] === '"') {
    let j = i + 1;
    let v = '';
    for (; j < s.length && s[j] !== '"'; j++) { if (s[j] === '\\' && s[j + 1] === '"') { v += '"'; j++; } else v += s[j]; }
    return { value: v, end: j + 1 };
  }
  if (s[i] === '[') {
    let depth = 0;
    for (let j = i; j < s.length; j++) { if (s[j] === '[') depth++; else if (s[j] === ']' && !--depth) return { value: s.slice(i, j + 1), end: j + 1 }; }
  }
  if (two === '{{') {
    const j = s.indexOf('}}', i);
    if (j > 0) {
      let k = j + 2;
      while (k < s.length && !/\s/.test(s[k])) k++;
      return { value: s.slice(i, k), end: k };
    }
  }
  let j = i;
  while (j < s.length && !/\s/.test(s[j])) j++;
  return { value: s.slice(i, j), end: j };
}

/** Parse "/name key=value key2="quoted value" unnamed text" */
export function parseCommand(seg) {
  const m = seg.match(/^\/([^\s|]+)\s*([\s\S]*)$/);
  if (!m) return { name: '', named: {}, unnamed: seg };
  const name = m[1].toLowerCase();
  const rest = m[2];
  const named = {};
  let i = 0;
  for (;;) {
    while (i < rest.length && /\s/.test(rest[i])) i++;
    const a = rest.slice(i).match(/^([a-zA-Z_][\w-]*)=/);
    if (!a) break;
    const v = readValue(rest, i + a[0].length);
    named[a[1].toLowerCase()] = v.value;
    i = v.end;
  }
  let un = rest.slice(i).trim();
  let unnamed = un;
  if (un.startsWith('{:') && un.endsWith(':}')) {
    const v = readValue(un, 0);
    if (v.end === un.length) unnamed = v.value;
  } else if (/^".*"$/s.test(un)) unnamed = un.slice(1, -1).replace(/\\"/g, '"');
  return { name, named, unnamed };
}

const ALIASES = {
  regen: 'regenerate', wait: 'delay', sleep: 'delay', toast: 'echo', comment: 'noop', '#': 'noop',
  narrate: 'sys', nar: 'sys', cont: 'continue', toupper: 'upper', tolower: 'lower', length: 'len',
  setglobalvar: 'setglobalvar', closure: 'run', exec: 'run', addvar: 'addvar', flush: 'flushvar',
};

export const COMMANDS = [
  '/newchat', '/help',
  '/send text', '/sendas name=Char text', '/sys text', '/trigger [name]', '/gen prompt', '/genraw prompt',
  '/impersonate', '/continue', '/regenerate', '/setinput text', '/input prompt', '/popup text', '/echo text',
  '/buttons labels=["A","B"] text', '/qr label', '/messages [names=off] 0-3 | last', '/del N', '/addswipe text',
  '/setvar key=name value', '/getvar name', '/addvar key=name value', '/incvar name', '/decvar name', '/flushvar name', '/listvar',
  '/setglobalvar key=name value', '/getglobalvar name', '/let key=name value', '/var key=name [value]',
  '/if left=a right=b rule=eq|neq|lt|gt|lte|gte|in|nin|not else={: … :} {: … :}', '/while left=a right=b rule=… {: … :}',
  '/times N {: … :}', '/run name', '/return value', '/break', '/abort',
  '/add a b …', '/sub a b', '/mul a b …', '/div a b', '/mod a b', '/pow a b', '/max …', '/min …', '/abs n', '/round n', '/rand from=0 to=1 round=',
  '/len text', '/trim text', '/upper text', '/lower text', '/substr start=0 end=5 text', '/replace find=x replace=y text', '/tokens text',
  '/pass text', '/delay ms', '/preset name', '/persona name',
  '/sc-status', '/sc-preview', '/sc-clear', '/imagine …', '/speak text', '/translate text', '/hide N', '/unhide N', '/chatstyle name',
];

function lookupScoped(scope, k) {
  for (let s = scope; s; s = s.parent) if (s.vars.has(k)) return { found: true, value: s.vars.get(k), scope: s };
  return { found: false };
}

const numOf = (v) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Run a script. Returns the final pipe value.
 * api: { macro(text), vars(), globals(), save(), send, sendAs, sys, trigger, gen, genraw, impersonate, cont, regen,
 *        setInput, input, popup, echo, preset, persona, buttons?, runQr?, messages?, del?, addSwipe?, tokens?, custom? }
 */
export async function runScript(src, api) {
  const root = { vars: new Map(), parent: null };
  try {
    return await exec(src, api, root, '');
  } catch (e) {
    if (e instanceof Signal) return String(e.value ?? '');
    throw e;
  }
}

async function exec(src, api, scope, pipeIn) {
  let pipe = pipeIn;
  const sub = (v) => {
    if (v && typeof v === 'object' && 'closure' in v) return new Closure(v.closure, scope);
    let t = String(v ?? '').replace(/\{\{pipe\}\}/gi, pipe);
    t = t.replace(/\{\{var::([^}]+)\}\}/gi, (m, k) => { const r = lookupScoped(scope, k.trim()); return r.found ? String(r.value) : ''; });
    t = t.replace(/\{\{timesIndex\}\}/gi, () => { const r = lookupScoped(scope, '__timesIndex'); return r.found ? String(r.value) : '0'; });
    return api.macro(t);
  };
  for (const seg of splitPipes(src)) {
    if (!seg.startsWith('/')) { pipe = sub(seg); continue; }
    const cmd = parseCommand(seg);
    const name = ALIASES[cmd.name] || cmd.name;
    const named = Object.fromEntries(Object.entries(cmd.named).map(([k, v]) => [k, sub(v)]));
    const hasUnnamed = typeof cmd.unnamed === 'object' || String(cmd.unnamed).trim() !== '';
    let arg = hasUnnamed ? sub(cmd.unnamed) : pipe;
    const argStr = arg instanceof Closure ? arg.toString() : String(arg ?? '');
    const vars = api.vars();
    const globals = api.globals();
    const key = named.key || named.name;
    // operand: a variable name (scoped first, then chat) or a literal
    const val = (x) => {
      if (x instanceof Closure) return x;
      const s = String(x ?? '');
      const r = lookupScoped(scope, s);
      if (r.found) return r.value;
      if (Object.prototype.hasOwnProperty.call(vars, s)) return vars[s];
      return s;
    };
    const nums = () => (cmd.unnamed && typeof cmd.unnamed === 'string' ? argStr.split(/\s+/).filter(Boolean) : [argStr]).map((x) => numOf(val(x)) ?? 0);
    const add = (store, k, v) => {
      const a = numOf(store[k]);
      const b = numOf(v);
      store[k] = a !== null && b !== null ? String(a + b) : (store[k] ?? '') + v;
      return store[k];
    };
    const runClosure = async (c, extraVars = {}) => {
      if (!(c instanceof Closure)) return String(c ?? '');
      const child = { vars: new Map(Object.entries(extraVars)), parent: c.scope };
      try {
        return await exec(c.body, api, child, pipe);
      } catch (e) {
        if (e instanceof Signal && e.type === 'return') return String(e.value ?? '');
        throw e;
      }
    };
    const test = () => {
      const l = val(named.left ?? '');
      const r = val(named.right ?? '');
      const rule = String(named.rule || (named.right !== undefined ? 'eq' : 'not')).toLowerCase();
      const ln = numOf(l);
      const rn = numOf(r);
      const both = ln !== null && rn !== null;
      switch (rule) {
        case 'eq': return both ? ln === rn : String(l) === String(r);
        case 'neq': return both ? ln !== rn : String(l) !== String(r);
        case 'lt': return both ? ln < rn : String(l) < String(r);
        case 'gt': return both ? ln > rn : String(l) > String(r);
        case 'lte': return both ? ln <= rn : String(l) <= String(r);
        case 'gte': return both ? ln >= rn : String(l) >= String(r);
        case 'in': return String(l).toLowerCase().includes(String(r).toLowerCase());
        case 'nin': return !String(l).toLowerCase().includes(String(r).toLowerCase());
        case 'not': return !l || l === 'false' || l === '0';
        default: throw new Error(`/if: unknown rule "${rule}"`);
      }
    };
    switch (name) {
      case 'noop': break;
      case 'pass': pipe = argStr; break;
      case 'echo': api.echo(argStr); pipe = argStr; break;
      case 'popup': await api.popup(argStr); pipe = argStr; break;
      case 'input': pipe = await api.input(argStr, named.default || ''); break;
      case 'buttons': {
        let labels = [];
        try { labels = JSON.parse(named.labels || '[]'); } catch { labels = String(named.labels || '').split(','); }
        pipe = api.buttons ? await api.buttons(argStr, labels.map(String)) : '';
        break;
      }
      case 'setinput': api.setInput(argStr); pipe = argStr; break;
      case 'send': await api.send(argStr); pipe = argStr; break;
      case 'sendas': await api.sendAs(named.name || named.char || '', argStr); pipe = argStr; break;
      case 'sys': await api.sys(argStr); pipe = argStr; break;
      case 'trigger': await api.trigger(hasUnnamed ? argStr : named.name || ''); break;
      case 'gen': pipe = await api.gen(argStr); break;
      case 'genraw': pipe = await api.genraw(argStr); break;
      case 'impersonate': await api.impersonate(); break;
      case 'continue': await api.cont(); break;
      case 'regenerate': await api.regen(); break;
      case 'qr': if (!api.runQr) throw new Error('/qr is not available'); pipe = (await api.runQr(argStr)) ?? pipe; break;
      case 'messages': pipe = api.messages ? api.messages(argStr || 'last', named.names !== 'off') : ''; break;
      case 'del': if (api.del) await api.del(numOf(argStr) || 1); break;
      case 'addswipe': if (api.addSwipe) await api.addSwipe(argStr); break;
      case 'tokens': pipe = String(Math.ceil(argStr.length / 3.5)); break;
      // chat variables
      case 'setvar': vars[key] = argStr; api.save(); pipe = argStr; break;
      case 'getvar': pipe = vars[hasUnnamed ? argStr : key] ?? ''; break;
      case 'addvar': pipe = add(vars, key, argStr); api.save(); break;
      case 'incvar': pipe = add(vars, hasUnnamed ? argStr : key, '1'); api.save(); break;
      case 'decvar': pipe = add(vars, hasUnnamed ? argStr : key, '-1'); api.save(); break;
      case 'flushvar': delete vars[hasUnnamed ? argStr : key]; api.save(); break;
      case 'listvar': pipe = Object.entries(vars).map(([k, v]) => `${k} = ${v}`).join('\n'); api.echo(pipe || '(no variables)'); break;
      case 'setglobalvar': globals[key] = argStr; api.save(); pipe = argStr; break;
      case 'getglobalvar': pipe = globals[hasUnnamed ? argStr : key] ?? ''; break;
      case 'addglobalvar': pipe = add(globals, key, argStr); api.save(); break;
      // scoped variables
      case 'let': case 'var': {
        let k = key;
        let v = arg;
        if (!k && hasUnnamed && typeof cmd.unnamed === 'string') {
          const sp = argStr.match(/^(\S+)\s*([\s\S]*)$/);
          k = sp ? sp[1] : argStr;
          v = sp && sp[2] ? sp[2] : (name === 'let' ? '' : undefined);
          if (name === 'var' && v === undefined) { const r = lookupScoped(scope, k); pipe = r.found ? (r.value instanceof Closure ? r.value.toString() : String(r.value)) : ''; break; }
        }
        if (!k) throw new Error(`/${name} needs a key`);
        if (name === 'var' && !hasUnnamed && named.value === undefined) { const r = lookupScoped(scope, k); pipe = r.found ? String(r.value) : ''; break; }
        if (named.value !== undefined) v = named.value;
        const existing = lookupScoped(scope, k);
        (name === 'var' && existing.found ? existing.scope : scope).vars.set(k, v);
        if (!(v instanceof Closure)) pipe = String(v ?? '');
        break;
      }
      // control flow
      case 'if': {
        const ok = test();
        const branch = ok ? arg : named.else;
        if (branch instanceof Closure) pipe = await runClosure(branch);
        else if (branch !== undefined && branch !== pipe) pipe = await exec(String(branch), api, scope, pipe);
        break;
      }
      case 'while': {
        for (let n = 0; n < 1000 && test(); n++) {
          try { pipe = await runClosure(arg); } catch (e) { if (e instanceof Signal && e.type === 'break') break; throw e; }
        }
        break;
      }
      case 'times': {
        const parts = typeof cmd.unnamed === 'string' ? cmd.unnamed.trim().match(/^(\S+)\s+([\s\S]+)$/) : null;
        const n = Math.min(1000, numOf(val(parts ? sub(parts[1]) : named.count ?? argStr)) || 0);
        const body = parts ? sub(readValue(parts[2], 0).value) : arg;
        for (let k = 0; k < n; k++) {
          try { pipe = await runClosure(body, { __timesIndex: k }); } catch (e) { if (e instanceof Signal && e.type === 'break') break; throw e; }
        }
        break;
      }
      case 'run': {
        const target = arg instanceof Closure ? arg : val(argStr);
        if (target instanceof Closure) pipe = await runClosure(target);
        else if (api.runQr) pipe = (await api.runQr(argStr)) ?? pipe;
        break;
      }
      case 'return': throw new Signal('return', argStr);
      case 'break': throw new Signal('break');
      case 'abort': throw new Signal('abort', pipe);
      // math
      case 'add': pipe = String(nums().reduce((a, b) => a + b, 0)); break;
      case 'mul': pipe = String(nums().reduce((a, b) => a * b, 1)); break;
      case 'sub': { const [a, ...r] = nums(); pipe = String(r.reduce((x, y) => x - y, a ?? 0)); break; }
      case 'div': { const [a, b] = nums(); pipe = String(b ? a / b : 0); break; }
      case 'mod': { const [a, b] = nums(); pipe = String(b ? a % b : 0); break; }
      case 'pow': { const [a, b] = nums(); pipe = String(a ** (b ?? 1)); break; }
      case 'max': pipe = String(Math.max(...nums())); break;
      case 'min': pipe = String(Math.min(...nums())); break;
      case 'abs': pipe = String(Math.abs(nums()[0])); break;
      case 'round': pipe = String(Math.round(nums()[0])); break;
      case 'sqrt': pipe = String(Math.sqrt(nums()[0])); break;
      case 'rand': {
        const from = numOf(val(named.from ?? '0')) ?? 0;
        const to = numOf(val(named.to ?? '1')) ?? 1;
        let r = from + Math.random() * (to - from);
        if (named.round === 'round') r = Math.round(r); else if (named.round === 'floor') r = Math.floor(r); else if (named.round === 'ceil') r = Math.ceil(r);
        pipe = String(r);
        break;
      }
      // text
      case 'len': pipe = String(argStr.length); break;
      case 'trim': pipe = argStr.trim(); break;
      case 'upper': pipe = argStr.toUpperCase(); break;
      case 'lower': pipe = argStr.toLowerCase(); break;
      case 'substr': pipe = argStr.slice(numOf(named.start) ?? 0, named.end !== undefined ? numOf(named.end) ?? undefined : undefined); break;
      case 'replace': {
        const f = String(named.find ?? '');
        const rx = f.match(/^\/([\s\S]+)\/([a-z]*)$/);
        pipe = rx ? argStr.replace(new RegExp(rx[1], rx[2]), named.replace ?? '') : argStr.split(f).join(named.replace ?? '');
        break;
      }
      case 'delay': await new Promise((r) => setTimeout(r, Math.min(numOf(argStr) || 0, 60000))); break;
      case 'preset': api.preset(argStr); break;
      case 'persona': api.persona(argStr); break;
      default:
        if (api.custom && api.custom[name]) { const r = await api.custom[name](argStr, named); if (r !== undefined) pipe = String(r); break; }
        throw new Error(`/${cmd.name} isn't supported in PocketTavern yet. To get it added, export the quick reply set (Settings → Quick replies → Export) and send it to whoever maintains your PocketTavern.`);
    }
  }
  return pipe;
}
