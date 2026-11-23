// "Enhance My Reply" — ported from https://github.com/setsuna1313/Enhanced-Replies (MIT).
// Rewrites the composer draft with the active chat context, preset and model, without sending it.

// Earlier versions shipped this as the default instruction. Saved settings that still
// hold it verbatim are switched to the current default on load.
export const LEGACY_ENHANCE_PROMPTS = Object.freeze([
  `Rewrite the draft below into a more vivid, polished roleplay reply. Improve clarity, flow, sensory detail, and emotional nuance without changing the author's intent. Return only the enhanced reply, with no commentary, labels, or quotation marks around it.`,
]);

export const DEFAULT_ENHANCE_PROMPT = `Rewrite and enhance the draft below into a vivid, immersive, detailed, and polished roleplay response while preserving the original author's intent, characterization, tone, and narrative direction.

Point of View & Character Control:
- Write exclusively from {{user}}'s point of view, maintaining the original narrative perspective and tense.
- Focus on {{user}}'s thoughts, emotions, dialogue, physical actions, reactions, and sensory experiences.
- Never narrate {{char}}'s internal thoughts, feelings, intentions, or motivations as established facts.
- Do not control {{char}}'s dialogue, decisions, or actions unless absolutely necessary for natural scene progression or explicitly established in the original draft.
- Other characters and NPCs may be introduced, developed, and given dialogue, actions, personalities, and reactions when appropriate to enrich the scene.
- Maintain {{user}}'s established personality, mannerisms, relationships, and emotional responses.

Writing & Immersion:
- Expand the original draft with richer descriptions, natural dialogue, meaningful actions, subtle gestures, body language, and emotional depth.
- Incorporate atmospheric setting descriptions, including lighting, weather, sounds, scents, textures, surroundings, and environmental details where relevant.
- Enhance interactions through realistic conversations, expressive reactions, pauses, interruptions, and natural character behavior.
- Explore {{user}}'s internal thoughts, observations, memories, and emotional responses without excessive repetition or unnecessary exposition.
- Show emotions through behavior, dialogue, physical sensations, and subtle reactions rather than simply stating them.
- Introduce background activity, environmental interactions, and supporting characters when they contribute naturally to the scene.
- Improve pacing, transitions, sentence variety, grammar, clarity, and narrative flow.
- Use descriptive, engaging prose that feels natural, immersive, and emotionally nuanced rather than overly poetic, repetitive, or melodramatic.
- Make the response feel like a complete, living scene rather than a simple expansion of the original text.

Creative Expansion & Continuity:
- You may creatively expand conversations, actions, environmental details, and interactions beyond what is explicitly written.
- Preserve all important events, dialogue intentions, character dynamics, and established story details.
- Do not introduce major plot developments, unexpected time skips, or significant changes to the scene unless the original draft supports them.
- Ensure additional details feel organic and consistent with the setting, genre, atmosphere, and existing relationships.
- Give supporting characters distinct voices and believable reactions without allowing them to overshadow {{user}}.
- Allow scenes to develop naturally without rushing toward a conclusion.
- Leave room for {{char}} to respond and influence what happens next.

Output Requirements:
- Return only the fully rewritten and enhanced roleplay response.
- Do not include commentary, explanations, headings, labels, introductory statements, or quotation marks surrounding the response.
- Maintain exclusive focus on {{user}}'s narrative perspective.
- Write in immersive, well-developed paragraphs with naturally integrated dialogue.
- Prioritize quality, detail, emotional authenticity, and scene immersion over unnecessary length.
- Do not summarize the original draft. Transform it into a richer, more engaging roleplay scene.`;

export const DEFAULT_ENHANCE_SETTINGS = Object.freeze({
  enabled: true,
  prompt: DEFAULT_ENHANCE_PROMPT,
  preserveMarkdown: true,
  preserveDialogue: true,
  firstPersonPresent: false,
  preventOtherCharacters: true,
  expandShortReplies: true,
  keyboardShortcut: true,
});

export function migrateEnhanceSettings(saved) {
  const settings = { ...DEFAULT_ENHANCE_SETTINGS, ...(saved || {}) };
  if (LEGACY_ENHANCE_PROMPTS.includes(String(settings.prompt).trim())) settings.prompt = DEFAULT_ENHANCE_PROMPT;
  return settings;
}

export const ENHANCE_TOGGLES = [
  ['preserveMarkdown', 'Preserve Markdown', 'Keep action markers, emphasis, and paragraph formatting.'],
  ['preserveDialogue', 'Preserve dialogue', 'Keep spoken lines and their intended meaning.'],
  ['firstPersonPresent', 'First-person, present tense', 'Ask the model to keep “I” narration in the present.'],
  ['preventOtherCharacters', 'Never write for the bot’s character', 'Keep the bot’s character out of your reply; it answers on its own turn.'],
  ['expandShortReplies', 'Expand short replies from chat context', 'Use recent chat as grounding to develop brief drafts, without continuing the bot’s turn.'],
  ['keyboardShortcut', 'Enable Ctrl+Shift+E', 'Keyboard shortcut (with a keyboard). Ctrl+Shift+Z restores the draft.'],
];

// The quiet prompt is sent after the character card and system prompt, which tell the
// model it *is* {{char}}. Without an explicit override it rewrites the draft as
// {{char}}'s next turn, so this framing is always sent, whatever the custom prompt says.
// {{user}} and {{char}} are expanded by the prompt builder's macro pass.
const ROLE_FRAMING = `[OUT-OF-CHARACTER TASK — pause the roleplay. For this task you are NOT {{char}} (or any other AI-controlled character) and you are not writing {{char}}'s next turn. You are an editor polishing a message that {{user}} (the human player) has drafted. The draft is {{user}}'s own turn: everything in it is said, done, thought, or felt by {{user}}. Your rewrite must remain {{user}}'s turn, written from {{user}}'s perspective, and must end in a place where {{char}} has not yet responded.]`;

export function buildEnhancementPrompt(draft, settings) {
  const rules = [
    'Treat the draft as {{user}}\'s message. Do not reply to it, answer it, or continue the story from {{char}}\'s side.',
  ];
  if (settings.preserveMarkdown) {
    rules.push('Preserve the draft\'s Markdown conventions exactly (including asterisks, quotation marks, paragraph breaks, and other formatting).');
  }
  if (settings.preserveDialogue) {
    rules.push('Preserve every line {{user}} speaks in the draft and its meaning; polish its delivery only, and do not remove dialogue.');
  }
  if (settings.firstPersonPresent) {
    rules.push('Write consistently in first person and present tense, where "I" is {{user}}.');
  }
  if (settings.preventOtherCharacters) {
    rules.push('Never write dialogue, actions, decisions, thoughts, or feelings for {{char}}. {{char}} will respond separately after this message is sent.');
  }
  if (settings.expandShortReplies) {
    rules.push('If the draft is short or sparse, expand it into a fuller reply from {{user}}. Use the latest chat messages only as grounding for setting and for what {{user}} is reacting to. Do not continue, repeat, or summarize {{char}}\'s last message, and do not invent major decisions for {{user}}.');
  }
  const instruction = String(settings.prompt || DEFAULT_ENHANCE_PROMPT).trim();
  return `${ROLE_FRAMING}\n\n${instruction}\n\nConstraints:\n- ${rules.join('\n- ')}\n\nDRAFT BY {{user}} TO ENHANCE:\n<draft>\n${draft}\n</draft>\n\nReturn only the enhanced version of {{user}}'s message, written as {{user}}.`;
}

export function normalizeGeneratedText(value) {
  let text = String(value ?? '').trim();
  const fenced = text.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced) text = fenced[1].trim();
  return text;
}

// ---- Summarize (SillyTavern's built-in Summarize extension)
export const DEFAULT_SUMMARY_PROMPT = 'Ignore previous instructions. Summarize the most important facts and events in the story so far. If a summary already exists in your memory, use that as a base and expand with new facts. Limit the summary to {{words}} words or less. Your response should include nothing but the summary.';

export const DEFAULT_SUMMARIZE_SETTINGS = Object.freeze({
  enabled: false,
  mode: 'raw', // 'raw' = summary prompt + chat only; 'classic' = through the preset
  prompt: DEFAULT_SUMMARY_PROMPT,
  words: 200,
  every: 10,
  position: 'top',
  depth: 2,
  role: 'system',
  template: '[Summary: {{summary}}]',
});
