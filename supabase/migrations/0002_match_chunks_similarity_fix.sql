-- 0002: two correctness fixes to match_chunks, found in the Part 1 PR review.
-- (1) The kw CTE had LIMIT without ORDER BY — an arbitrary 30 rows per SQL
--     semantics; worked only because the planner happened to emit rows in the
--     window function's sort order. Now ordered explicitly.
-- (2) similarity was COALESCEd to 0 for rows found only by the keyword lane,
--     so the relevance gate would wrongly reject a keyword-only hit. Now the
--     outer SELECT computes true cosine similarity for every returned row
--     (at most match_count extra distance computations per query).
create or replace function match_chunks(
  query_embedding vector(1024),
  query_text text,
  match_count int default 8,
  version text default '2025-26'
) returns table (
  id bigint,
  law_number int,
  breadcrumb text,
  content text,
  similarity double precision,
  rrf_score double precision
) language sql stable as $$
  with vec as (
    select c.id,
           row_number() over (order by c.embedding <=> query_embedding) as rank
    from chunks c
    where c.corpus_version = version
    order by c.embedding <=> query_embedding
    limit 30
  ),
  kw as (
    select c.id,
           row_number() over (
             order by ts_rank(c.fts, websearch_to_tsquery('english', query_text)) desc
           ) as rank
    from chunks c
    where c.corpus_version = version
      and c.fts @@ websearch_to_tsquery('english', query_text)
    order by rank
    limit 30
  ),
  fused as (
    select id,
           coalesce(1.0 / (60 + v.rank), 0) + coalesce(1.0 / (60 + k.rank), 0) as rrf_score
    from vec v full outer join kw k using (id)
  )
  select c.id, c.law_number, c.breadcrumb, c.content,
         1 - (c.embedding <=> query_embedding) as similarity,
         f.rrf_score
  from fused f
  join chunks c on c.id = f.id
  order by f.rrf_score desc
  limit match_count;
$$;
