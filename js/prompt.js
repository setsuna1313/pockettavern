// Prompt assembly, modelled on SillyTavern's chat-completion prompt manager.
import { evaluateMacros, macros } from './macros.js';
import { activateWorldInfo } from './worldinfo.js';
import { applyRegex, PLACEMENT } from './regex.js';
import { simplePreset, DEFAULT_CONTINUE, DEFAULT_IMPERSONATE, DEFAULT_GROUP_NUDGE } from './preset.js';

export { macros };
export const estTokens = (s) => Math.ceil((s || '').length / 3.5);

const msgText = (m) => (m.swipes ? m.swipes[m.swipeIdx] || '' : m.text || '');
const ROLE_NUM = { 0: 'system', 1: 'user', 2: 'assistant' };

/** All lorebook entries that apply to this character + persona. */
export function collectLoreEntries({ char, persona, lorebooks }) {
  const books = new Map();
  const charIds = new Set(char.lorebooks || []);
  const personaIds = new Set((persona && persona.lorebooks) || []);
  const linkedName = char.extensions && typeof char.extensions.world === 'string' ? char.extensions.world.trim().toLowerCase() : '';
  for (const b of lorebooks || []) {
    if (b.global || charIds.has(b.id) || personaIds.has(b.id) || (linkedName && b.name.trim().toLowerCase() === linkedName)) books.set(b.id, b);
  }
  const entries = [];
  for (const b of books.values()) entries.push(...b.entries.map((e) => ({ ...e, _key: `${b.id}:${e.uid}` })));
  // Like SillyTavern: when the card's lorebook also exists as a linked lorebook
  // (a SillyTavern export or data-folder import has both), use the linked one only.
  const embeddedName = String((char.character_book && char.character_book.name) || '').trim().toLowerCase();
  const linkedLoaded = [...books.values()].some((b) => {
    const n = b.name.trim().toLowerCase();
    return (linkedName && n === linkedName) || (embeddedName && n === embeddedName);
  });
  if (char.character_book && char.character_book.entries && !char.disableEmbeddedBook && !linkedLoaded) {
    entries.push(...(char._embeddedEntries || []).map((e) => ({ ...e, _key: e._key || `card:${char.id}:${e.uid}` })));
  }
  // The same entry in two active lorebooks (e.g. one imported twice) is only sent once.
  const seen = new Set();
  const unique = entries.filter((e) => {
    const content = String(e.content || '').trim();
    if (!content) return true;
    const sig = `${(e.keys || []).join('|')}\u0000${content}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
  return { entries: unique, books: [...books.values()] };
}

function formatExamples(raw, heading) {
  const blocks = String(raw || '').split(/<START>/i).map((s) => s.trim()).filter(Boolean);
  if (!blocks.length) return '';
  return blocks.map((b) => (heading ? `${heading}\n${b}` : b)).join('\n\n');
}

/**
 * Build the message list for a generation.
 * history: messages before the one being generated (oldest first)
 * mode: 'normal' | 'continue' (history ends with the message being continued) | 'impersonate'
 *       | 'quiet' (background generation with quietPrompt, like ST's generateQuietPrompt)
 * summary: { text, position: 'top'|'depth'|'macro', depth, role, template }
 * timed: lorebook sticky/cooldown state for this chat (mutated)
 * group: { names: 'A, B', nameOf(msg) } for group chats (names are prefixed to history, nudge added)
 * Returns { messages, stats, vars }
 */
export function buildPrompt({ char, persona, settings, chat, history, preset, lorebooks, regexScripts, model, embeddedEntries, mode = 'normal', group = null, quietPrompt = '', summary = null, timed = null, memory = null, narrativeDatabase = null, continuity = '', vision = null, recall = null }) {
  // Ghosted messages are covered by long-term memory and not sent (they stay visible in the chat).
  const fullLength = history.length; // timed lorebook effects count every message
  // DB-covered messages stay in the original chat, but leave the generation prompt.
  // Summaryception's ghost flags are ignored when that memory system isn't enabled.
  if (narrativeDatabase?.text) {
    // Keep up to N verbatim tokens for character voice and immediate scene details,
    // even when the same events are already represented in the cumulative record.
    const budget = Math.max(0, Number(narrativeDatabase.recentTokens) || 0);
    let recentStart = history.length, used = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const cost = estTokens(msgText(history[i])) + 4;
      if (used + cost > budget && recentStart < history.length) break;
      used += cost; recentStart = i;
    }
    history = history.slice(Math.min(narrativeDatabase.covered || 0, recentStart));
  }
  history = history.filter((m) => !(settings.ext.memory.enabled && m.ghost) && !m.hidden);
  const P = settings.prompt;
  const samplers = settings.preset;
  const pr = preset || simplePreset(P);
  const scripts = regexScripts || [];
  const charWithBook = { ...char, _embeddedEntries: embeddedEntries || [] };

  const texts = history.map(msgText);
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const lastChar = [...history].reverse().find((m) => m.role !== 'user');
  const env = {
    user: (persona && persona.name) || 'User',
    char: char.name,
    persona: (persona && persona.description) || '',
    description: char.description || '',
    personality: char.personality || '',
    scenario: char.scenario || '',
    mesExamplesRaw: char.mes_example || '',
    mesExamples: formatExamples(char.mes_example, pr.new_example_chat_prompt),
    charPrompt: char.system_prompt || '',
    charInstruction: char.post_history_instructions || '',
    charVersion: char.character_version || '',
    creatorNotes: char.creator_notes || '',
    lastMessage: texts[texts.length - 1] || '',
    lastUserMessage: lastUser ? msgText(lastUser) : '',
    lastCharMessage: lastChar ? msgText(lastChar) : '',
    lastMessageId: String(Math.max(0, history.length - 1)),
    model: model || '',
    maxPrompt: samplers.context_size,
    vars: { ...((chat && chat.vars) || {}) },
    globals: settings.globalVars || (settings.globalVars = {}),
    outlets: {},
    group: group ? group.names : undefined,
    summary: (summary && summary.text) || '',
    custom: { summaryception_memory: (memory && memory.text) || '' },
  };
  const macro = (t) => evaluateMacros(t, env);

  // ---- lorebooks
  const { entries } = collectLoreEntries({ char: charWithBook, persona, lorebooks });
  const wi = activateWorldInfo({
    entries, history: texts, char, persona, defaultDepth: P.wi_scan_depth || 4, timed, chatLength: fullLength,
    recursion: P.wi_recursion !== false, maxRecursion: P.wi_max_recursion ?? 3,
    budget: P.wi_budget > 0 ? Math.round((samplers.context_size || 8192) * P.wi_budget / 100) : 0,
  });
  const wiText = (list) => list.map((e) => applyRegex(macro(e.content), scripts, { placement: PLACEMENT.WORLD_INFO, isPrompt: true, macro }).trim()).filter(Boolean).join('\n');
  for (const [name, list] of Object.entries(wi.outlets)) env.outlets[name] = wiText(list);
  const wrapWi = (s) => (s ? (pr.formats.wi_format || '{0}').replace('{0}', s) : '');

  // ---- walk the prompt order
  const byId = new Map(pr.prompts.map((p) => [p.identifier, p]));
  const blocks = []; // {role, content} | {history:true}
  let mainAt = -1;
  const injections = []; // {depth, order, role, content}
  let hasHistory = false;

  const examplesText = () => {
    const parts = [wiText(wi.emTop), formatExamples(macro(char.mes_example || ''), pr.new_example_chat_prompt), wiText(wi.emBottom)].filter(Boolean);
    return parts.join('\n\n');
  };

  for (const item of pr.order) {
    if (!item.enabled) continue;
    const p = byId.get(item.identifier);
    if (!p) continue;
    const role = p.role || 'system';
    let content;
    switch (p.identifier) {
      case 'chatHistory': blocks.push({ history: true }); hasHistory = true; continue;
      case 'worldInfoBefore': content = wrapWi(wiText(wi.before)); break;
      case 'worldInfoAfter': content = wrapWi(wiText(wi.after)); break;
      case 'charDescription': content = macro(char.description || ''); break;
      case 'charPersonality': content = (char.personality || '').trim() ? macro(pr.formats.personality_format) : ''; break;
      case 'scenario': content = (char.scenario || '').trim() ? macro(pr.formats.scenario_format) : ''; break;
      case 'personaDescription': content = (persona && (persona.description || '').trim()) ? macro(pr.formats.persona_format) : ''; break;
      case 'dialogueExamples': content = examplesText(); break;
      case 'main': {
        let text = p.content || '';
        if (P.prefer_card_system && !p.forbid_overrides && (char.system_prompt || '').trim()) {
          env.original = macro(text);
          text = char.system_prompt;
        }
        content = macro(text);
        break;
      }
      case 'jailbreak': {
        let text = p.content || '';
        if (P.prefer_card_post_history && !p.forbid_overrides && (char.post_history_instructions || '').trim()) {
          env.original = macro(text);
          text = char.post_history_instructions;
        }
        content = macro(text);
        break;
      }
      default:
        if (p.injection_position === 1) {
          const c = macro(p.content || '');
          if (c.trim()) injections.push({ depth: p.injection_depth ?? 4, order: p.injection_order ?? 100, role, content: c });
          continue;
        }
        content = macro(p.content || '');
    }
    if (content && content.trim()) {
      blocks.push({ role, content: content.trim() });
      if (p.identifier === 'main') mainAt = blocks.length - 1;
    }
  }
  if (!hasHistory) blocks.push({ history: true });

  // Summary (Summarize extension)
  if (summary && summary.text && summary.text.trim() && summary.position !== 'macro') {
    const content = macro((summary.template || '[Summary: {{summary}}]').replace(/\{\{summary\}\}/gi, summary.text.trim()));
    if (summary.position === 'depth') injections.push({ depth: Number(summary.depth) || 0, order: 50, role: summary.role || 'system', content });
    else blocks.splice(mainAt + 1, 0, { role: 'system', content });
  }

  // Long-term memory (layered memory extension)
  if (memory && memory.text && memory.text.trim() && memory.position !== 'macro') {
    const content = macro((memory.template || '{{memory}}').replace(/\{\{memory\}\}/gi, memory.text.trim()));
    if (memory.position === 'chat') injections.push({ depth: Number(memory.depth) || 0, order: 40, role: memory.role || 'system', content });
    else if (memory.position === 'prompt') blocks.splice(mainAt + 1, 0, { role: memory.role || 'system', content });
    else blocks.unshift({ role: memory.role || 'system', content });
  }
  if (narrativeDatabase?.text) {
    const d = narrativeDatabase;
    const content = macro((d.template || '{{database}}').replace(/\{\{database\}\}/gi, d.text));
    if (d.position === 'chat') injections.push({ depth: Number(d.depth) || 0, order: 35, role: d.role || 'system', content });
    else if (d.position === 'prompt') blocks.splice(mainAt + 1, 0, { role: d.role || 'system', content });
    else blocks.unshift({ role: d.role || 'system', content });
  }
  if (continuity && continuity.trim()) injections.push({ depth: 0, order: 30, role: 'system', content: macro(continuity) });

  // lorebook entries placed in the chat
  for (const e of wi.depth) {
    const c = wiText([e]);
    if (c) injections.push({ depth: e.depth ?? 4, order: e.order, role: ROLE_NUM[e.role] || 'system', content: c });
  }
  const note = chat && chat.authorsNote && chat.authorsNote.text && chat.authorsNote.text.trim() ? chat.authorsNote : null;
  // Character's Note (V2 card extensions.depth_prompt), inserted in the chat at its depth.
  const dp = char.extensions && char.extensions.depth_prompt;
  if (dp && typeof dp.prompt === 'string' && dp.prompt.trim()) {
    injections.push({ depth: Number(dp.depth ?? 4) || 0, order: 90, role: ['system', 'user', 'assistant'].includes(dp.role) ? dp.role : 'system', content: macro(dp.prompt).trim() });
  }
  const an = [wiText(wi.anTop), note ? macro(note.text).trim() : '', wiText(wi.anBottom)].filter(Boolean).join('\n');
  if (an) {
    injections.push({
      depth: note ? (Number(note.depth) || 0) : 4,
      order: 100,
      role: note && ['system', 'user', 'assistant'].includes(note.role) ? note.role : 'system',
      content: an,
    });
  }

  // ---- chat history within the token budget
  // Chat recall (vector storage): relevant older moments, inserted in the chat.
  if (recall && recall.text && recall.text.trim()) {
    injections.push({ depth: Number(recall.depth) || 0, order: 60, role: recall.role || 'system', content: macro((recall.template || '{{text}}').replace(/\{\{text\}\}/gi, recall.text.trim())) });
  }

  const fixed = blocks.reduce((s, b) => s + (b.content ? estTokens(b.content) + 4 : 0), 0)
    + injections.reduce((s, i) => s + estTokens(i.content) + 4, 0)
    + estTokens(pr.new_chat_prompt);
  const budget = (samplers.context_size || 8192) - (samplers.max_tokens || 500) - fixed - 32;
  const hist = [];
  let used = 0;
  let imageBudget = vision && vision.enabled ? Math.max(0, Number(vision.maxImages) || 0) : 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const depth = history.length - 1 - i;
    let text = applyRegex(msgText(m), scripts, { placement: m.role === 'user' ? PLACEMENT.USER : PLACEMENT.AI, isPrompt: true, depth, macro });
    // In group chats, {{char}} inside a message means the member who wrote it.
    const author = group && group.nameOf && m.role !== 'system' ? group.nameOf(m) : null;
    if (author && m.role !== 'user') {
      const speaking = env.char;
      env.char = author;
      text = macro(text);
      env.char = speaking;
    } else text = macro(text);
    // Attached photos go to vision models (newest first, up to maxImages); generated images aren't sent back.
    let images = null;
    if (Array.isArray(m.images) && m.images.length && !m.generated) {
      if (imageBudget > 0) { images = m.images.slice(0, imageBudget); imageBudget -= images.length; } else text = `${text} [image]`.trim();
    }
    if (!text.trim() && !images) continue;
    if (author) text = `${author}: ${text}`;
    const t = estTokens(text) + 4 + (images ? images.length * 800 : 0);
    if (used + t > budget && hist.length) break;
    used += t;
    const item = { role: m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'assistant', content: text };
    if (images) item.images = images;
    hist.unshift(item);
  }
  // in-chat injections (depth 0 = after the last message)
  const byDepth = new Map();
  for (const inj of injections) {
    const d = Math.max(0, Math.min(hist.length, Number(inj.depth) || 0));
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(inj);
  }
  // Deepest first, so each insertion position is still relative to the original messages.
  const depths = [...byDepth.keys()].sort((a, b) => b - a);
  for (const d of depths) {
    const list = byDepth.get(d).sort((a, b) => a.order - b.order).map((i) => ({ role: i.role, content: i.content }));
    hist.splice(hist.length - d, 0, ...list);
  }
  const newChat = pr.new_chat_prompt ? macro(pr.new_chat_prompt) : '';

  const messages = [];
  for (const b of blocks) {
    if (b.history) {
      if (newChat.trim()) messages.push({ role: 'system', content: newChat });
      messages.push(...hist);
    } else messages.push(b);
  }

  // Final nudges (SillyTavern adds these at the very end of the prompt).
  const pick = (key, def) => pr[key] || (pr.raw && pr.raw[key]) || def;
  if (mode === 'continue') messages.push({ role: 'system', content: macro(pick('continue_nudge_prompt', DEFAULT_CONTINUE)) });
  else if (mode === 'impersonate') messages.push({ role: 'system', content: macro(pick('impersonation_prompt', DEFAULT_IMPERSONATE)) });
  else if (mode === 'quiet') messages.push({ role: 'system', content: macro(quietPrompt) });
  else if (group) messages.push({ role: 'system', content: macro(pick('group_nudge_prompt', DEFAULT_GROUP_NUDGE)) });

  return {
    messages: messages.filter((m) => (m.content && m.content.trim()) || (m.images && m.images.length)),
    vars: env.vars,
    timed,
    stats: {
      system: fixed,
      history: used,
      included: hist.length - injections.length,
      total: history.filter((h) => msgText(h)).length,
      worldInfo: wi.count,
      worldInfoTokens: (wi.active || []).reduce((n, e) => n + estTokens(e.content || ''), 0),
      worldInfoList: (wi.active || []).map((e) => ({ name: e.comment || (e.keys || []).slice(0, 3).join(', ') || 'Entry', tokens: estTokens(e.content || '') })),
      reply: samplers.max_tokens || 0,
      worldInfoDropped: wi.droppedByBudget || 0,
      preset: pr.name,
    },
  };
}
