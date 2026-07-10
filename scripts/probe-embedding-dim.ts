import { embedTexts, EMBEDDING_DIM } from "../lib/voyage";

const [v] = await embedTexts(["dimension probe"], "query");
console.log(`live dimension: ${v.length}, EMBEDDING_DIM constant: ${EMBEDDING_DIM}`);
if (v.length !== EMBEDDING_DIM) process.exitCode = 1;
