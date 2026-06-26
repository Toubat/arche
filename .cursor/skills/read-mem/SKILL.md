---
name: read-mem
description: Rehydrate context by reading saved memory notes from the arche .memory/ folder. Use when the user invokes /read-mem, asks what was learned previously, or wants to load prior session memory on a topic before continuing work.
disable-model-invocation: true
---

# read-mem

Load durable memory from `.memory/` at the **arche repo root**
(`/Users/toubatbrian/Documents/GitHub/arche/.memory/`). Files follow the
`yyyy-mm-dd-<topic>.md` convention.

## Argument

Invoked as `/read-mem <topic>` or `/read-mem` (none).

- **`<topic>` given** → find and fully read the matching note(s).
- **none** → list all memory files (newest first by date prefix) and read them
  to rehydrate, prioritizing the most recent if there are many.

## Workflow

1. List `.memory/` (e.g. `ls -1 .memory/`). If it is missing or empty, say so
   and stop.
2. **Topic match** (when an argument is given), in order:
   - filename `<topic>` segment matches (case-insensitive, partial ok);
   - then content search across files (use Grep over `.memory/`).
   Read the best matches in full with the Read tool. If nothing matches, list
   available topics and ask which to load.
3. **No argument**: read the files (all if few; otherwise the most recent plus
   anything whose title is clearly relevant to the current task).
4. After reading, give a brief synthesis: which files were loaded and the key
   facts now in context. Do not dump file contents verbatim unless asked.

## Notes

- Read-only: this skill never writes. To save memory, use `/sync-mem`.
- Treat loaded notes as prior context, but re-verify before acting on anything
  that may have changed (paths, versions, limits).
