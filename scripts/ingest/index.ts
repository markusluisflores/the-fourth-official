import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { embedTexts } from "../../lib/voyage";
import { pdfToText } from "./parse";
import { applyEmbeddingTextOverrides, assertCompleteLawSet, chunkRulebook } from "./chunk";
import { CORPUS_VERSION, EMBED_BATCH_SIZE, INSERT_BATCH_SIZE, PDF_PATH } from "./config";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const text = await pdfToText(new Uint8Array(await readFile(PDF_PATH)));
  const chunks = chunkRulebook(text);
  console.log(`parsed ${text.length} chars → ${chunks.length} chunks`);
  if (chunks.length < 100)
    throw new Error("suspiciously few chunks — check heading regexes against the live PDF");
  // Divider detection has no semantic guard (any "Law" line followed by a bare 1-2 digit
  // line is treated as a real chapter divider) — this is the backstop that catches a
  // stray coincidental match (e.g. a table-of-contents entry) before it corrupts the
  // corpus silently. See assertCompleteLawSet in chunk.ts.
  assertCompleteLawSet(chunks);
  const finalChunks = applyEmbeddingTextOverrides(chunks);

  // The project's Voyage account has no payment method attached, capping it at 3 RPM
  // (see config.ts's EMBED_BATCH_SIZE comment). Back off between batches so we don't
  // exceed that — confirmed empirically that back-to-back requests 429 even well under
  // the per-request token cap.
  const embeddings: number[][] = [];
  for (let i = 0; i < finalChunks.length; i += EMBED_BATCH_SIZE) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 21_000));
    const batch = finalChunks.slice(i, i + EMBED_BATCH_SIZE);
    embeddings.push(
      ...(await embedTexts(
        batch.map((c) => c.embeddingText ?? c.content),
        "document",
      )),
    );
    console.log(
      `embedded ${Math.min(i + EMBED_BATCH_SIZE, finalChunks.length)}/${finalChunks.length}`,
    );
  }

  // Not wrapped in a transaction with the insert loop below. Safe today because: embeddings
  // are computed above before this delete runs, so a Voyage failure leaves the DB untouched;
  // the corpus is small enough (118 rows) to insert in a single INSERT_BATCH_SIZE batch, so
  // there's no multi-batch insert that could fail halfway and leave the version half-written;
  // and this script only ever runs manually, never against a live-serving path. If the corpus
  // grows past one insert batch, or ingestion becomes automated/scheduled, wrap delete+insert
  // in a transaction or a single RPC instead of relying on these assumptions.
  const { error: delError } = await supabase
    .from("chunks")
    .delete()
    .eq("corpus_version", CORPUS_VERSION);
  if (delError) throw new Error(`delete failed: ${delError.message}`);

  const rows = finalChunks.map((c, i) => ({
    corpus_version: CORPUS_VERSION,
    law_number: c.lawNumber,
    breadcrumb: c.breadcrumb,
    content: c.content,
    embedding_text: c.embeddingText ?? null,
    embedding: embeddings[i],
  }));
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const { error } = await supabase.from("chunks").insert(rows.slice(i, i + INSERT_BATCH_SIZE));
    if (error) throw new Error(`insert failed at row ${i}: ${error.message}`);
  }
  console.log(`ingested ${rows.length} chunks as corpus_version=${CORPUS_VERSION}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
