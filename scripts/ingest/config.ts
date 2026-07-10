export const CORPUS_VERSION = "2025-26";
export const PDF_PATH = "data/laws-2025-26.pdf";
// The project's Voyage account has no payment method attached, which caps it at 3 RPM /
// 10K TPM (see https://docs.voyageai.com/docs/rate-limits). A batch of 64 chunks near
// MAX_CHUNK_CHARS (1500 chars) exceeds 10K TPM in a single request and 429s immediately,
// confirmed empirically: batches of 20 max-size chunks succeed, 30 fails. Lowered from
// the brief's original 64 to keep every batch comfortably under the token cap.
export const EMBED_BATCH_SIZE = 20;
export const INSERT_BATCH_SIZE = 500;
