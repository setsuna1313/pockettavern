// Narrative Database: independent, cumulative roleplay memory.
// Unlike layered memory, each pass receives the previous *complete* database and
// the next chronological segment of original messages. No LLM calls here.
export const DEFAULT_DATABASE_PROMPT = `# ROLEPLAY DATABASE UPDATE

Update the complete Narrative Database using the previous database and new roleplay messages. Output the entire updated database, not a patch. This is memory of **events and discoveries in this specific RP**, not a second character card or lorebook.

## NON-NEGOTIABLE RULES

- Preserve consequential facts and their exact supported details even when they are no longer relevant to the current scene. A death toll, secret, discovery, promise, relationship turning point, irreversible choice, deadline, or unresolved mystery does not expire because it is old.
- Distinguish confirmed events, reported claims, guesses, plans, unknowns, and who knows each fact. Never turn a guess, prediction, implied outcome, or unseen fate into established truth. Preserve source uncertainty even when a confident sentence would sound smoother.
- Do not reproduce baseline lore: established personalities, voices, skills, affiliations, appearance, backstories, generic locations, and franchise/world rules belong to cards and lorebooks. **Exception:** record a pre-existing fact when its revelation, contradiction, or use has a consequential effect in this RP.
- Preserve user control of the player character, established POV/tense/formatting instructions, timeline distinctions, and unresolved continuity.
- Treat new explicitly established canon and corrections as authoritative when they contradict old database text. Do not invent a reconciliation. If incoming material is ambiguous or appears to conflict, retain the earlier established fact with its uncertainty rather than guessing a fix.
- Retire temporary details (ordinary meals, positions, routine travel, minor inventory, incidental dialogue) when their scenes conclude unless their outcome or symbolism remains important. Physical intimacy may establish a relationship milestone; save the milestone, not the choreography.

## FACT FIDELITY — NO UNLICENSED INFERENCES

- **People and relationships:** Track the exact participants and targets of every fight, confession, promise, secret, and change. Never transfer a conflict from one pair to another (e.g. a fight between Jason and Catrin must not become a Jason–Bruce fight). Do not replace a participant with someone who happens to be mentioned nearby.
- **Motives:** Only state why someone acted when the RP explicitly establishes that reason. Do not infer foreknowledge, jealousy, betrayal, romantic intent, or tactical aims from their actions. If a motive is unclear, omit it or mark it unknown; do not make it a new mystery without source support.
- **Timelines and outcomes:** Keep each erased/present timeline separate. If someone was last seen in danger, their death is not confirmed. Mark guesses, inferences, and unwitnessed outcomes as such; do not let later summaries harden them into facts.
- **Tasks and deadlines:** A deadline belongs only to the specific task it was attached to. Do not fuse nearby plans or attach one task's cutoff to another (e.g. a tracker spoof ending at 18:00 does not mean a separately planned cat pickup must happen by 18:00). Keep "today," "tomorrow," exact times, and proposed versus agreed actions distinct.
- **Secrets and knowledge:** A reader's inference is not a character's knowledge. Only record a character as knowing a fact if they saw it, were told, or established it in the RP. Preserve who has NOT learned something.
- **Objects and identifiers:** Preserve redactions and unknown destinations. A shipment marked "[ORBITAL]" is not "Watchtower" unless the RP explicitly confirms it. Keep exact names, recipients, quantities, and codes when plot-relevant.
- **No new mysteries:** Put a question in Unresolved Threads only if the RP explicitly raised it or the previous database already established it as consequential and open. Do not invent possible conspiracies, hidden motives, unanswered questions, or speculative threads to fill the Ledger.
- **Source precedence:** New original RP messages may establish or explicitly correct a fact. Prior database text provides accumulated history, but is not permission to add new inferences. When deleting duplicate prose, preserve the most accurately qualified form of the fact.

## SINGLE SOURCE OF TRUTH / SECTION OWNERSHIP

**Each consequential fact should have one primary home.** Other sections may mention only the current implication, not retell the underlying event. Apply this rule to existing database text as well as new updates.

- **Chronicle owns history:** What happened, when, to whom, who revealed what, and lasting outcomes. Put death tolls, timeline branches, causes, decisive choices, and irreversible changes here once. Compress old scenes into outcomes, not play-by-play accounts. Never copy full history into other sections.
- **Dossiers own character state:** Only the changes a person carries into subsequent scenes—current condition, new knowledge/secrets, consequential personal choices, open goals, and a few key items. Do not retell their chronological history or restate events recorded in the Chronicle. One terse line may identify the resulting change.
- **The Web owns relationship state:** What is now different between the EXACT named people (trust, commitment, estrangement, confirmed feelings, promises). Do not confuse parties or assign inferred motives. Not an account of conversations, gifts, meals, or movements that produced that state.
- **World Mechanics owns persistent mechanics:** Novel RP-specific rules, unusual setting constraints, and operative technology. NOT the plot history in which they were discovered. A timeline's death toll and war progression belong in the Chronicle; mechanisms such as the Mother Box leak belong here.
- **The Ledger owns only established unfinished business:** Questions explicitly raised in the story or inherited from the prior database, and real active tasks with their own owners/deadlines. There is NO Resolved Threads section. When a thread closes, put its important outcome in the Chronicle, Web, Dossiers, or World Mechanics once; otherwise drop it. Remove old Resolved Threads headings and entries after moving any unique consequential facts to their proper home.
- **Active Theatre owns the next beat:** Short scene orientation only. No inventory, emotional retelling, or long recap.
- **Recent Log is a handoff:** Up to three new changes needed for the next RP reply, not a second history. Skip anything already clear from Active Theatre unless it prevents a continuity mistake. Zero entries is fine.

Before writing, notice repeated facts in the incoming database and consolidate them into their primary home. Move unique significant facts out of any inherited Resolved Threads before deleting that section. Never delete the **only** instance of a consequential fact. Avoid compensating for shorter dossiers by inflating the Chronicle, Ledger, or World Mechanics.

## WRITING & COMPRESSION RULES

- **Write like quick, clear notes, not polished prose.** Choose short common words: 'gave' not 'provided'; 'found' not 'discovered'; 'used' not 'utilized'; 'asked' not 'requested'; 'kept' not 'maintained'. Cut filler like 'in order to', 'proceeded to', 'was able to', and 'it is important to note'. Short words alone do not guarantee fewer tokens: remove needless ideas and clauses too.
- Prefer compact, natural sentences or fragments when clear. **Do not recount minor scene beats.** Record what changed, who knows, and why it matters. Never replace scene prose with equally long formal synonyms; measure the words actually saved. Avoid cryptic abbreviations or shorthand that could confuse the RP model.
- Preserve precise consequential numbers, names, identifiers, dates, and timelines. Never trade an exact established fact for vague phrasing merely to save space.
- Group related minor events by their lasting outcome; drop routine motion, meal details, clothing, repeated reactions, and minute-by-minute action once the scene ends. Preserve exact chronology only where order or timing changes the plot. Compress wording, **not** significant information.
- Refer to an event outside its primary section only when essential to the section's purpose; describe its result in a short phrase rather than restating its sequence.
- On every update, trim inherited bloat, including the old Chronicle. Existing prose is not sacred; established facts are. Summarize a resolved visit or conversation in one brief outcome statement, not five equal-length sentences. A past checkpoint's incidental detail is not automatically worth retaining.
- No fixed total token ceiling or historical-event count. Database growth should track meaningful new developments, not message count.

## REQUIRED OUTPUT

# NARRATIVE

## ACTIVE THEATRE

**Current Context:** One or two short sentences: time/place, participants, situation, next beat. No recap or filler.

**Writing Style:** Concisely preserve established POV, tense, formatting, and player-character control rules. Do not add new instructions.

**Story Tone:** A few words or one brief sentence. Do not recap the scene.

## ENTITY DOSSIERS

Only RP-specific changes and necessary live state for relevant characters, including absent characters with lasting developments. **Use short fragments when clear.** The Chronicle already stores how developments occurred; do not repeat those scenes here. Use only applicable fields; do not fill a template for every person.

**[Name]**
- **Current:** Where they are, condition, immediate goal, if important.
- **Developments:** Consequential things they did, learned, suffered, decided, confessed, or changed during this RP. Do not retell full events already recorded in the Chronicle.
- **Knowledge / Secrets:** What they know, suspect, or do not know; maintain private knowledge boundaries.
- **Open:** Unresolved personal objective or consequence, if any.
- **Key Items:** Only evidence, objects, or possessions with continuing plot relevance.

Omit unused fields. Do not restate standard lorebook biography, abilities, voice, personality, or exhaustive inventories. Give central characters enough detail to preserve their evolving story, but do not give each character equal space.

## THE WEB

Each significant RP-established relationship or **change to an existing relationship** once, **typically one short sentence**:
- **A ↔ B:** Compact statement of current trust, conflict, affection, promises, differing feelings, or knowledge, with major changes where necessary.

Skip static baseline relationships already covered by the lorebook. Preserve persistent relationship changes when characters are absent.

## WORLD MECHANICS

Only RP-established persistent mechanisms, unusual facts, discoveries, or deviations relevant to continuity—not a second timeline chronology. Use **Geography**, **Factions**, **Rules of Reality**, and **MacGuffins** subheadings where applicable. Distinguish confirmed mechanics from hypotheses. Do not recreate DC worldbuilding or duplicate inventories.

## THE LEDGER

### Unresolved Threads
Only uncertainties explicitly raised by the RP or already recorded as consequential and open. Never invent a mystery to fill the section, and never delete an established one just because it has not been mentioned recently. Leave the section empty if none.

### Active Tasks
Only unfinished plans with their actual owner, actual deadline (if any), and status (proposed / agreed / underway). Keep unrelated deadlines separate. Drop completed tasks after recording any lasting outcome in its primary section.

## THE CHRONICLE

### Historical Record
Cumulative record of **significant RP events**, earliest first. Preserve consequential outcomes, causality, revelations, timeline branches, exact stakes, and lasting character or relationship developments indefinitely. A devastating death toll or crucial revelation remains even if it does not affect the next scene.

Merge old scenes by meaningful result. One compact entry may cover a whole visit or conversation; include decisive words or exact times only if they affect later events. Give wars, major discoveries, and irreversible choices more room than routine scenes. Preserve cause and effect, protected numbers, dates, identities, and unknowns. Drop old play-by-play details, not major facts. No fixed entry count.

### Recent Log
Zero to three fresh **changes needed for the next reply**, newest first. Use short notes, not beat-by-beat actions or Chronicle duplicates. When an item becomes old, keep its lasting outcome in the proper section and drop the handoff note.

## SILENT VERIFICATION

Before output, check: each consequential fact has one primary home; no Resolved Threads heading; no duplicate scene narration; correct timeline and order; exact characters in every conflict/relationship; motives explicitly supported; unseen deaths still uncertain; no new mystery; each deadline attached to the right task; redacted destinations stay redacted; no character knows facts they were never told; consequential numbers/identifiers and older events retained; tasks not prematurely closed; brief Active Theatre; plain, short notes. If the source is unclear, qualify rather than invent. If an old entry is verbose, rewrite it more tightly without deleting its consequential facts.

Output **only** the complete updated Markdown database.`;

export const DEFAULT_DATABASE_SETTINGS = Object.freeze({
  enabled: false, batchTokens: 8000, recentTokens: 15000,
  model: '', maxOutputTokens: 12000,
  role: 'system', position: 'before', depth: 0,
  template: '<narrative_database>\n{{database}}\n</narrative_database>',
  prompt: DEFAULT_DATABASE_PROMPT,
});

export const messageText = m => String((m.swipes && m.swipes[m.swipeIdx]) || m.text || '');
export const estimateTokens = s => Math.ceil(String(s || '').length / 3.5);

// Stable synchronous fingerprint for edit detection (not a cryptographic signature).
export function fingerprint(messages, count = messages.length) {
  let hash = 2166136261;
  const mix = s => { for (let i = 0; i < s.length; i++) { hash ^= s.charCodeAt(i); hash = Math.imul(hash, 16777619); } };
  for (let i = 0; i < count; i++) {
    const m = messages[i]; if (!m) return null;
    mix(String(m.id || i)); mix('|'); mix(m.role); mix('|'); mix(messageText(m)); mix('\n');
  }
  return (hash >>> 0).toString(16);
}

export const isStale = (messages, state) => !!(state && state.covered && fingerprint(messages, state.covered) !== state.signature);
export function pendingTokens(messages, covered = 0) {
  return messages.slice(covered).filter(m => !m.hidden && messageText(m).trim()).reduce((s, m) => s + estimateTokens(messageText(m)) + 4, 0);
}

// Entire messages only, no overlap; protects the user's prose from splitting mid-message.
export function nextBatch(messages, start, targetTokens = 8000, flush = false) {
  const limit = Math.max(1000, Number(targetTokens) || 8000);
  let tokens = 0, end = start;
  while (end < messages.length) {
    const m = messages[end];
    const n = m.hidden || !messageText(m).trim() ? 0 : estimateTokens(messageText(m)) + 4;
    if (tokens && tokens + n > limit) break;
    tokens += n; end++;
    if (tokens >= limit) break;
  }
  if (!flush && tokens < limit && end >= messages.length) return null;
  if (end === start) return null;
  return { start, end, tokens, messages: messages.slice(start, end).filter(m => !m.hidden && messageText(m).trim()) };
}

// Count actual whole-message batches, which can differ from tokens / target.
export function countBatches(messages, start = 0, targetTokens = 8000) {
  let count = 0, cursor = start;
  while (cursor < messages.length) {
    const batch = nextBatch(messages, cursor, targetTokens, true);
    if (!batch || batch.end <= cursor) break;
    cursor = batch.end;
    count++;
  }
  return count;
}

export function buildUpdateInput(previous, batch, speaker) {
  const entries = batch.messages.map(m => `<message role="${m.role}">\n${speaker(m)}: ${messageText(m)}\n</message>`).join('\n\n');
  return `<previous_database>\n${previous || '(No previous database. Create the first complete database from the supplied messages.)'}\n</previous_database>\n\n<new_roleplay_messages>\n${entries}\n</new_roleplay_messages>\n\nUpdate the complete database using only the prior database and new messages. Output the full replacement database.`;
}

export function checkedDatabase(text) {
  let result = String(text || '').trim().replace(/^\`\`\`(?:markdown|md)?\s*\n/i, '').replace(/\n\`\`\`\s*$/, '').trim();
  // Match actual Markdown headings, not incidental words in prose. Recent Log is
  // optional because its prompt explicitly allows zero entries.
  const required = [
    ['ACTIVE THEATRE', 2], ['ENTITY DOSSIERS', 2], ['THE WEB', 2],
    ['WORLD MECHANICS', 2], ['THE LEDGER', 2],
    ['Unresolved Threads', 3], ['Active Tasks', 3],
    ['THE CHRONICLE', 2], ['Historical Record', 3],
  ];
  const headings = [...result.matchAll(/^(#{2,4})\s+([^\n#]+?)\s*$/gm)].map(m => ({ level: m[1].length, title: m[2].trim(), index: m.index }));
  const missing = required.filter(([title, level]) => !headings.some(h => h.title === title && h.level === level)).map(([title]) => title);
  if (!result || missing.length) throw new Error('Database response missing required sections: ' + (missing.length ? missing.join(', ') : 'empty response') + '. Previous version was retained.');
  if (headings.some(h => h.title === 'Resolved Threads')) throw new Error('Database response used old Resolved Threads section. Remove the obsolete Resolved Threads section and retry. Previous version was retained.');
  const ordered = required.map(([title]) => headings.find(h => h.title === title).index);
  if (ordered.some((index, i) => i > 0 && index <= ordered[i - 1])) throw new Error('Database sections are out of order. Previous version was retained.');

  // A complete replacement must stand alone. These are references to memory
  // omitted from the output, not compact statements of actual facts.
  const placeholder = result.split('\n').find(line => {
    const value = line.trim().replace(/^[-*]\s*/, '').replace(/^\*\*[^*]+\*\*\s*[:—-]?\s*/, '').trim();
    // Strip list markers and optional Markdown field labels before examining
    // the actual field content. "The passcode is unchanged" is a valid fact;
    // a field consisting only of "Unchanged this exchange" is not.
    const naked = value.replace(/^\*\*[^*]+\*\*\s*[:—-]?\s*/, '').trim().replace(/^\((.*)\)$/, '$1').trim();
    // Reject self-referential shorthand even when it points to another section.
    // A concrete fact such as "the passcode is unchanged" is still valid.
    if (/^(?:no (?:new )?change(?:s)?(?: (?:this|since (?:the )?(?:last|previous)) (?:update|scene|batch))?|unchanged(?: (?:this|since (?:the )?(?:last|previous)) (?:update|scene|batch))?)(?:[;,. —-]+\s*(?:see|refer to)\s+(?:the\s+)?(?:chronicle|ledger|above|prior|previous|earlier)(?:\s+(?:section|entry|database))?)?[.!]?$/i.test(naked)) return true;
    if (/\bno change this update\s*[;,.—-]+\s*see chronicle\b/i.test(line)) return true;
    return /\b(?:unchanged from (?:the )?(?:prior|previous|earlier|old) database|(?:see|refer to|same as) (?:the )?(?:prior|previous|earlier|old) database|all prior (?:knowledge|details|history|facts) retained|(?:all )?(?:prior|previous|earlier) (?:details|history|entries|information|facts) (?:remain )?unchanged)\b/i.test(line)
      || /^(?:unchanged(?:\s+(?:this (?:exchange|scene|turn|update|batch)|since (?:last|previous) (?:update|scene)|from (?:before|previously)))?|same as (?:before|above|previously)|as (?:before|previously)|no (?:new )?changes|(?:nothing|no updates) to (?:add|report))(?:\s*[.!])?$/i.test(naked);
  });
  if (placeholder) throw new Error('Database response has an incomplete-memory placeholder: "' + placeholder.trim().slice(0, 180) + '". Previous checkpoint retained; resume to retry this batch.');

  // Recent Log is an optional zero-to-three-item handoff. Normalize absent
  // headings instead of rejecting an otherwise complete response.
  if (!headings.some(h => h.title === 'Recent Log' && h.level === 3)) {
    result += '\n\n### Recent Log\n- None.';
  }
  return result;
}

/**
 * Conservative continuity warnings. These are retry hints, not proof of a
 * semantic error: a fact may have been legitimately resolved or rewritten.
 * Check exact protected strings and explicit dossier/task structure only.
 */
export function continuityWarnings(previous, candidate, newMessages = []) {
  if (!String(previous || '').trim()) return [];
  const before = String(previous), after = String(candidate);
  const incoming = newMessages.map(m => messageText(m)).join('\n');
  const warnings = [];
  const section = (text, heading, next) => {
    const start = text.indexOf(heading);
    if (start < 0) return '';
    const from = start + heading.length;
    const end = next ? text.indexOf(next, from) : -1;
    return text.slice(from, end < 0 ? undefined : end);
  };
  const oldDossiers = section(before, '## ENTITY DOSSIERS', '## THE WEB');
  const names = [...oldDossiers.matchAll(/^\*\*([^*\n]+)\*\*\s*$/gm)].map(m => m[1].trim());
  for (const name of names) {
    if (name.length < 3 || name.length > 90) continue;
    // Timeline qualifiers are not part of a character's identity.
    // Still require the character's actual name to appear somewhere.
    const baseName = name.replace(/\s*\([^)]*(?:timeline|branch)[^)]*\)\s*$/i, '')
      .replace(/\s+[—–-]\s*[^—–-]*(?:timeline|branch)[^—–-]*$/i, '').trim();
    const candidate = after.toLowerCase();
    if (!candidate.includes(name.toLowerCase()) && !candidate.includes(baseName.toLowerCase()))
      warnings.push('Established character absent from the entire replacement: ' + name);
  }
  const oldTasks = section(before, '### Active Tasks', '## THE CHRONICLE');
  const newTasks = section(after, '### Active Tasks', '## THE CHRONICLE');
  for (const match of oldTasks.matchAll(/^[-*]\s+(.+)$/gm)) {
    const task = match[1].trim();
    // Only protect explicit deadlines: ordinary tasks can legitimately resolve.
    const deadline = task.match(/\b(?:tomorrow|today|tonight|yesterday|next (?:day|week|month)|by \d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2})\b/i);
    if (!deadline) continue;
    const anchor = task.replace(/\*\*/g, '').split(/[.:;—–]/)[0].trim().slice(0, 70);
    const present = newTasks.toLowerCase().includes(deadline[0].toLowerCase()) &&
      (anchor.length < 5 || after.toLowerCase().includes(anchor.toLowerCase()));
    // A completion in the new source is evidence for retirement, not proof.
    const resolved = /\b(?:completed|finished|resolved|cancelled|canceled|retrieved|picked up)\b/i.test(incoming) &&
      (anchor.length < 5 || incoming.toLowerCase().includes(anchor.toLowerCase()));
    if (!present && !resolved)
      warnings.push('Check whether active deadline/task was lost or changed: ' + task.slice(0, 180));
  }
  // Timeline headings may be renamed; compare branch meaning, not exact labels.
  const timelineLabels = [...before.matchAll(/^[-*]\s*\*\*([^*\n]*(?:timeline|branch)[^*\n]*)\*\*/gim)].map(m => m[1].trim());
  for (const label of timelineLabels) {
    if (after.toLowerCase().includes(label.toLowerCase())) continue;
    const original = /\b(?:origin|original|abandoned|erased|prior|previous|old)\b/i.test(label);
    const altered = /\b(?:altered|new|current|rewritten|revised)\b/i.test(label);
    const equivalent = original
      ? /\b(?:origin(?:al)?|abandoned|erased|prior|previous|old)\s*[- ]?timeline\b|\btimeline\s+(?:of origin|before|prior to)\b/i.test(after)
      : altered
        ? /\b(?:altered|new|current|rewritten|revised)\s*[- ]?timeline\b/i.test(after)
        : /\btimeline\b|\bbranch\b/i.test(after);
    if (!equivalent) warnings.push('Check missing timeline branch: ' + label.slice(0, 100));
  }
  return [...new Set(warnings)].slice(0, 12);
}
