# PocketTavern

A SillyTavern-style character chat app for iPhone and Android, built as an installable web app (PWA).
It runs entirely on your device: characters, chats and API keys are stored locally in the browser and
requests go straight from your phone to the AI provider.

**▶ Open the app: <https://setsuna1313.github.io/pockettavern/>**
Install it to your home screen: on iPhone/iPad open it in Safari → Share → *Add to Home Screen*;
on Android open it in Chrome → *Install* (or ⋮ → *Add to Home screen*). It also works in any desktop browser.

## Features
- Import SillyTavern / TavernAI character cards (PNG or JSON, V1/V2/V3) and export them back as PNG cards
- **SillyTavern chat-completion presets**: full prompt manager with on/off toggles, prompt editing and reordering,
  in-chat injections at depth, card system-prompt overrides, generation settings; export back to ST format
- **Lorebooks / World Info**: import ST lorebooks; global, per-persona and per-character lorebooks; embedded card lorebooks;
  keywords and regex keys, secondary-key logic, recursion, inclusion groups with priority, character filters,
  probability, all insertion positions (before/after character, @depth with role, examples, outlets)
- **Regex scripts**: ST format; user input / AI output / world info; display-only, prompt-only and permanent; depth limits;
  card-embedded scripts
- **Macros**: `{{char}}`, `{{user}}`, `{{setvar}}`/`{{getvar}}` (+ add/inc/dec, global vars), `{{random::a::b}}`, `{{roll:1d20}}`,
  `{{trim}}`, `{{// comments}}`, `{{mesExamplesRaw}}`, `{{lastMessage}}`, time/date and more
- Model output can contain HTML/CSS (info boards, cards); it is sanitized (DOMPurify) and rendered in a shadow root
- Streaming chat, swipes, edit/delete/branch messages, multiple chats per character, personas
- **Continue** and **Impersonate** (using the preset's continue/impersonation prompts), per-chat **Author's Note** at any depth
- **Group chats**: natural / list / manual reply order, talkativeness, mentions, swap or join cards, muting, "make X speak"
- **Reasoning display**: collapsible thought process from reasoning models (OpenRouter, Claude 4.6+)
- Quick preset switcher inside chats
- **Built-in extensions**: ✨ Enhance My Reply (port of [Enhanced-Replies](https://github.com/setsuna1313/Enhanced-Replies)) and Summarize
- Built-in versions of ST's bundled extensions: **images in chat** (vision), **image generation** (OpenRouter image models,
  OpenAI-compatible, Pollinations; `/imagine`), **text-to-speech** (device voices, OpenAI-compatible, ElevenLabs; per-character voices),
  **translation** (via your model), **character expressions** (sprites; imported from ST), **chat recall** (keyword BM25 or embeddings)
- **Quick Replies** (import ST quick reply sets) and **STscript**: pipes, `{: closures :}`, `/if`, `/while`, `/times`, `/let`/`/var`, `/run`, `/return`, `/break`, `/buttons`, `/qr`, math, text and chat commands
- Lorebook **timed effects**: sticky, cooldown, delay
- **Layered memory** inspired by [Summaryception](https://github.com/vadash/Extension-Summaryception): verbatim window, Layer 0 summaries,
  deeper merged layers, ghosted messages, `{{summaryception_memory}}`, optional Continuity Auditor (scene, bonds/gates, agendas, secrets)
- **Appearance**: color themes, chat styles named after [Moonlit Echoes](https://github.com/RivelleDays/SillyTavern-MoonlitEchoesTheme)
  (Flat, Document, Echo, Whisper, Hush, Ripple, Tide), avatar shapes, background image, custom CSS; imports ST UI themes (including their custom CSS — the chat markup mirrors SillyTavern's so most theme CSS carries over) and Moonlit presets
- Backends: OpenRouter, any OpenAI-compatible API, Claude (Anthropic API), and **text completion** for local models
  (KoboldCpp, Ollama, LM Studio, text-generation-webui, llama.cpp, TabbyAPI, vLLM) with **instruct templates**
  (ChatML, Llama 3, Mistral, Gemma, Alpaca, Metharme, Command R; import ST templates)
- **Import a whole SillyTavern data folder (.zip)**: characters, chats, group chats, personas (avatars, lorebooks, locks),
  lorebooks + World Info settings, presets (active one selected), global regex, quick replies, active UI theme, global variables
- Character's Note (depth prompt), `<think>` auto-parsing, custom stopping strings, hide/unhide messages (`/hide`, `/unhide`),
  per-message token counts, delete single swipes, lorebook budget and recursion limits, persona locks
- **Library**: favorites, tag filters, tags-as-folders (imported from ST), sorting, tag manager,
  **search inside chats** (all chats or one chat, jumps to the message), **import from chub.ai links** or direct card URLs
- Prompt preview, SillyTavern chat import/export (.jsonl), full backup/restore

- **Sync between devices** via a sync file (iCloud Drive / Google Drive / AirDrop / Quick Share): newest copy of each record wins, nothing is deleted

Not supported: arbitrary third-party ST extensions (they run inside SillyTavern itself; popular ones are rebuilt as built-ins), automatic cloud sync (needs a server).

## Install on iPhone
Open the site in Safari → Share → **Add to Home Screen**.

## Install on Android
Open the site in Chrome → tap the **Install** banner (or menu **⋮** → **Add to Home screen**).
To build an APK, see [ANDROID.md](ANDROID.md).

## Development
No build step. Serve the folder with any static server, e.g. `python3 -m http.server`.
When you change files, bump `CACHE` in `sw.js`.

## License
PocketTavern is released under the [MIT License](LICENSE): you're free to fork it, change it and share it,
as long as you keep the copyright and license notice.

It includes [DOMPurify](https://github.com/cure53/DOMPurify) (`js/vendor/purify.js`), which keeps its own
license (Apache 2.0 / MPL 2.0) as stated in that file. PocketTavern is an independent project inspired by
SillyTavern and does not contain SillyTavern code.
