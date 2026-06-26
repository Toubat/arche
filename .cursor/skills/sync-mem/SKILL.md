---
name: sync-mem
description: Persist the current session's memory and insights into the arche .memory/ folder as dated yyyy-mm-dd-<topic>.md notes. Use when the user invokes /sync-mem, asks to save/update/checkpoint memory, or wants to record what was learned this session.
disable-model-invocation: true
---

# sync-mem

Write durable session memory into `.memory/` at the **arche repo root**
(`/Users/toubatbrian/Documents/GitHub/arche/.memory/`). Create the folder if it
does not exist.

## Argument

Invoked as `/sync-mem <instruction>` or `/sync-mem` (none).

- **`<instruction>` given** → scope the sync to that instruction/topic only
  (e.g. `/sync-mem the durable object limits we found`).
- **none** → capture all salient, durable insights from the current session.

## Workflow

1. Resolve today's date: `date +%Y-%m-%d`.
2. Decide the topic slug(s): short, lowercase, hyphenated (e.g.
   `opencode-architecture`, `durable-objects-platform`). One file per distinct
   topic; split rather than cram unrelated topics together.
3. For each topic, target `.memory/<yyyy-mm-dd>-<topic>.md`:
   - If the file **already exists**, read it and merge — update/extend in place,
     do not duplicate existing facts or create a near-identical second file.
   - Otherwise create it.
4. Start every file with this header block, then the notes:

   ```markdown
   # <Human title>

   - date: <yyyy-mm-dd>
   - source: <where this came from, e.g. session deep-dive / verified run>
   - status: reference | living notes | verified
   ```

5. Report which files were created vs updated.

## Content rules

- **Only record verified or directly-observed facts.** If something was
  corrected during the session, record the corrected version (and briefly note
  the correction if it's a likely future trap).
- Be concise and information-dense — these are reference notes, not prose.
- Prefer concrete specifics: file paths, exact identifiers, limits, commands.
- No time-sensitive phrasing ("before August…"); state the current fact and put
  superseded facts under an explicit "old / deprecated" sub-section if needed.
- Use consistent terminology with existing `.memory/` files.

## Do not

- Do not write memory anywhere other than the arche `.memory/` folder.
- Do not invent a SKILL.md or frontmatter — these are plain dated `.md` notes.
- Do not delete unrelated existing memory files.
