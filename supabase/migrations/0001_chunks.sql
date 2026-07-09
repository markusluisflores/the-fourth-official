create extension if not exists vector;

create table if not exists chunks (
  id bigint generated always as identity primary key,
  corpus_version text not null,
  law_number int not null,          -- 1..17; 0 = front matter / glossary
  breadcrumb text not null,        -- 'Law 12 › 2. Indirect free kick'
  content text not null,
  embedding vector(1024) not null, -- must equal EMBEDDING_DIM (Task 2 probe)
  fts tsvector generated always as (to_tsvector('english', content)) stored
);

create index if not exists chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_fts_idx on chunks using gin (fts);
create index if not exists chunks_version_idx on chunks (corpus_version);

-- Hybrid search: vector similarity + full-text, fused with Reciprocal Rank Fusion.
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
           1 - (c.embedding <=> query_embedding) as similarity,
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
    limit 30
  ),
  fused as (
    select id,
           coalesce(1.0 / (60 + v.rank), 0) + coalesce(1.0 / (60 + k.rank), 0) as rrf_score,
           coalesce(v.similarity, 0) as similarity
    from vec v full outer join kw k using (id)
  )
  select c.id, c.law_number, c.breadcrumb, c.content, f.similarity, f.rrf_score
  from fused f
  join chunks c on c.id = f.id
  order by f.rrf_score desc
  limit match_count;
$$;
