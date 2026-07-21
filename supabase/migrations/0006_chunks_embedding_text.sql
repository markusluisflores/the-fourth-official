-- 0006: nullable embedding-only text override, used to give a chunk a
-- richer search fingerprint without changing what's displayed as its
-- citation (content stays untouched). Populated for at most a handful of
-- rows — most stay null forever. See
-- docs/superpowers/specs/2026-07-19-law3-retrieval-gap-fix-design.md.
alter table chunks add column embedding_text text;
