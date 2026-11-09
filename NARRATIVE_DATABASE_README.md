# Narrative Database — proposed third PocketTavern memory option

This is an **unofficial, community-proposed extension** to PocketTavern 1.9.10. It is independent of the existing Summarize and Summaryception data. The three modes are treated as alternative **active** memory modes; switching does not delete the others' saved state.

## How to use

1. Make a backup of your existing PocketTavern data before testing a fork or modified deployment.
2. Open **Settings → Extensions → Narrative Database** and enable it. This switches off the other two summarization modes, but doesn't erase their summaries.
3. Default update threshold: **8,000 new RP tokens**. This counts original chat content, not the character card, lorebooks, or database itself. You can change it.
4. Set **Keep verbatim** to the desired amount of recent, original chat you want included alongside the database (default 15,000 tokens). This is a separate prompt-context overlap limit, not another summarization trigger.
5. Use **Manage Narrative Database** in Settings or the chat quick-actions menu to see/edit the full database.
6. For an existing long conversation, click **Rebuild from Chat History**. It processes the original messages in chronological batches, using each preceding complete database in the next call. The original chat is neither forked nor mutated.
7. **Update from Last Checkpoint** processes any remaining messages immediately. Automatic updates normally occur after the chosen threshold following a generated reply.
8. **Clear Database** removes the database and its checkpoints for this chat only. **Export** and **Import** provide manual backups and handoff. Imported text intentionally begins with zero validated coverage: it is not falsely treated as a summary of the recipient chat.

## Original-format default prompt

The supplied default update prompt preserves the user's detailed sections: Active Theatre, Entity Dossiers, The Web, World Mechanics, The Ledger, and The Chronicle (Historical Record + Recent Log). It is editable in Settings. Model responses must contain the expected headings before they can replace an active version.

## Rebuild safety

A rebuild creates a **staged** database with each successful checkpoint saved. The previously active database is not replaced until the staged rebuild finishes. You may cancel at the next batch boundary and later select **Rebuild from Chat History** again to resume the saved staging result. If source messages change, checkpoint fingerprints detect covered edits; automatic summarization stops and offers rebuild.

The signature is a fast change detector, not a security-grade hash. It cannot protect against every hypothetical collision.

## Implementation layout

- `js/narrative-db.js`: default prompt and standalone pure functions for chronological batching, token estimates, fingerprints, response validation.
- `js/app.js`: per-chat storage in existing IndexedDB chats; auto-update, batch processor, UI settings, editor, clear/import/export/rebuild actions.
- `js/prompt.js`: database injected into the active prompt, with a configurable recent verbatim context window, while retaining source messages intact.
- `index.html`: import input.
- `sw.js`: offline cache includes the new JS module.
- `tests/narrative-db.test.mjs`: Node smoke tests.

No external package dependencies added. No server-side changes. API generation uses PocketTavern's existing provider connection and model selection; the optional summarizer model ID uses that connection.

## Verification and limitations

Tested with Node syntax checks, a deterministic chronological-batching test, edit-detection tests, and a prompt-builder integration smoke test. **Model-based validation:** Six models completed a 30-message synthetic roleplay continuity benchmark over three checkpoints, including branching timelines, revised deadlines, secrets, and unresolved outcomes. This is a limited synthetic test, not a full browser integration test. Please test with disposable chat data before relying on it for important conversations.

- **Cost:** Catch-up of 160k tokens with an 8k batch size usually involves ~20 sequential model calls, each including the previous full database. Larger databases raise token costs and may exceed small context windows or output budgets.
- **Response validation:** Required headings are checked, but a well-formatted summary can still contain omissions or factual errors; users should review and correct it.
- **Edited older messages:** Changing a covered message causes a staleness warning and suppresses automatic use of that database until rebuilt.
- **Recent overlap:** The latest N tokens of original chat may also appear in the injected database, deliberately preserving scene nuance at the expense of some duplication.
- **Backend limitations:** Provider output token caps, timeouts and large-input limits still apply.
- **Single active mode:** All three stores are independent, but using multiple simultaneous summarizers is intentionally not supported by the toggles in this proposal.

## Development checks

```sh
node --check js/app.js
node --check js/prompt.js
node --check js/narrative-db.js
node --experimental-default-type=module tests/narrative-db.test.mjs
```

To send a contribution upstream, consider splitting the change into (1) independent engine and tests, (2) UI + persistence, (3) quality-of-life improvements after end-to-end browser testing.

## Version 0.22 continuity safeguards

After schema validation, the engine compares each candidate replacement with the previous database. It flags disappearing established character names, explicitly labelled timeline branches, and active tasks with deadlines that appear to drift. A flagged batch gets one targeted full-database retry; if the warning persists, the previous checkpoint is retained for manual review. This is a conservative heuristic, **not full semantic verification**: it can miss paraphrased omissions or flag legitimate corrections, especially when a task is resolved. No existing 0.14 update prompt is changed. The source-history checkpoint and staged-rebuild protections remain in place.

The smoke tests now cover these heuristics and the required schema. Additional end-to-end browser and real-RP testing remains recommended.
