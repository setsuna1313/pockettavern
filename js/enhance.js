// "Enhance My Reply" — ported from https://github.com/setsuna1313/Enhanced-Replies (MIT).
// Rewrites the composer draft with the active chat context, preset and model, without sending it.

export const DEFAULT_ENHANCE_PROMPT = `Rewrite the draft below into a more vivid, polished roleplay reply. Improve clarity, flow, sensory detail, and emotional nuance without changing the author's intent. Return only the enhanced reply, with no commentary, labels, or quotation marks around it.`;

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

export const ENHANCE_TOGGLES = [
  ['preserveMarkdown', 'Preserve Markdown', 'Keep action markers, emphasis, and paragraph formatting.'],
  ['preserveDialogue', 'Preserve dialogue', 'Keep spoken lines and their intended meaning.'],
  ['firstPersonPresent', 'First-person, present tense', 'Ask the model to keep “I” narration in the present.'],
  ['preventOtherCharacters', 'Do not write for other characters', 'Limit additions to your character’s words and actions.'],
  ['expandShortReplies', 'Expand short replies from chat context', 'Use the preceding roleplay message to develop brief drafts naturally.'],
  ['keyboardShortcut', 'Enable Ctrl+Shift+E', 'Keyboard shortcut (with a keyboard). Ctrl+Shift+Z restores the draft.'],
];

export function buildEnhancementPrompt(draft, settings) {
  const rules = [];
  if (settings.preserveMarkdown) {
    rules.push('Preserve the draft\'s Markdown conventions exactly (including asterisks, quotation marks, paragraph breaks, and other formatting).');
  }
  if (settings.preserveDialogue) {
    rules.push('Preserve every spoken line and its meaning; polish its delivery only, and do not remove dialogue.');
  }
  if (settings.firstPersonPresent) {
    rules.push('Write consistently in first person and present tense.');
  }
  if (settings.preventOtherCharacters) {
    rules.push('Do not write actions, thoughts, feelings, or new dialogue for any other character. Only expand the reply writer\'s own words and actions.');
  }
  if (settings.expandShortReplies) {
    rules.push('If the draft is short or sparse, expand it into a fuller roleplay reply using relevant details, actions, atmosphere, and emotional cues from the immediately preceding roleplay message and conversation context. Treat that context only as grounding: preserve the draft writer\'s intent, do not invent major decisions, and do not merely summarize or repeat the previous message.');
  }
  const instruction = String(settings.prompt || DEFAULT_ENHANCE_PROMPT).trim();
  const constraints = rules.length ? `\n\nConstraints:\n- ${rules.join('\n- ')}` : '';
  return `${instruction}${constraints}\n\nDRAFT TO ENHANCE:\n<draft>\n${draft}\n</draft>\n\nReturn only the enhanced reply.`;
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
