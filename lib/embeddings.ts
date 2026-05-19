/**
 * Embedding utility — talks to the local willys-embeddings sidecar
 * (intfloat/multilingual-e5-small, 384 dims, multilingual). No external API.
 *
 * The sidecar URL comes from WILLYS_EMBED_URL (default http://willys-embeddings:8097
 * which is the compose-network hostname).
 *
 * IMPORTANT: e5 models want different prefixes for query vs passage. Use
 * `generateQueryEmbedding` for the user's text at search time, and
 * `generatePassageEmbeddingsBatch` when indexing catalogue items. Symmetric
 * similarity without the prefixes is measurably worse.
 */

const EMBED_URL =
  process.env.WILLYS_EMBED_URL || "http://willys-embeddings:8097";
const EMBED_DIM = 384;

const embeddingCache = new Map<string, Float32Array>();

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\n\r\t]/g, " ")
    .replace(/\s+/g, " ");
}

async function callEmbed(
  texts: string[],
  kind: "query" | "passage",
): Promise<Float32Array[]> {
  const res = await fetch(`${EMBED_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts, kind }),
  });
  if (!res.ok) {
    throw new Error(`Embed service ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { embeddings: number[][]; dim: number };
  if (data.dim !== EMBED_DIM) {
    throw new Error(
      `Embed service returned dim=${data.dim}, expected ${EMBED_DIM}. The vec0 table is sized for ${EMBED_DIM}; mismatched models will silently break similarity search.`,
    );
  }
  return data.embeddings.map((v) => Float32Array.from(v));
}

export async function generateQueryEmbedding(
  text: string,
): Promise<Float32Array> {
  const normalized = normalize(text);
  const cacheKey = `q::${normalized}`;
  const hit = embeddingCache.get(cacheKey);
  if (hit) return hit;
  const [vec] = await callEmbed([normalized], "query");
  embeddingCache.set(cacheKey, vec);
  return vec;
}

export async function generatePassageEmbeddingsBatch(
  texts: string[],
  batchSize: number = 32,
): Promise<Float32Array[]> {
  const normalized = texts.map(normalize);
  const out: Float32Array[] = new Array(normalized.length);
  const need: number[] = [];
  const needTexts: string[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const cacheKey = `p::${normalized[i]}`;
    const hit = embeddingCache.get(cacheKey);
    if (hit) out[i] = hit;
    else {
      need.push(i);
      needTexts.push(normalized[i]);
    }
  }
  for (let i = 0; i < needTexts.length; i += batchSize) {
    const slice = needTexts.slice(i, i + batchSize);
    const vecs = await callEmbed(slice, "passage");
    for (let j = 0; j < slice.length; j++) {
      const idx = need[i + j];
      out[idx] = vecs[j];
      embeddingCache.set(`p::${normalized[idx]}`, vecs[j]);
    }
  }
  return out;
}

// ── Back-compat shims for any code still using the old names. ───────────────
// They route to the new passage-prefixed variant; the difference vs query-
// prefixed matters for retrieval quality but not correctness.
export const generateEmbedding = (text: string) =>
  generatePassageEmbeddingsBatch([text]).then((v) => v[0]);
export const generateEmbeddingsBatch = generatePassageEmbeddingsBatch;

export function embeddingToBlob(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer);
}

export function blobToEmbedding(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

export function cosineSimilarity(
  a: Float32Array,
  b: Float32Array,
): number {
  if (a.length !== b.length) {
    throw new Error("Embeddings must have the same dimensions");
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const m = Math.sqrt(na) * Math.sqrt(nb);
  return m === 0 ? 0 : dot / m;
}

export function clearEmbeddingCache(): void {
  embeddingCache.clear();
}

export function getEmbeddingCacheStats(): { size: number; keys: string[] } {
  return { size: embeddingCache.size, keys: Array.from(embeddingCache.keys()) };
}

export { EMBED_DIM };
