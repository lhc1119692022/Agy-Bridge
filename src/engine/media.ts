import type { CatalogModelEntry } from './types.js';

/**
 * MIME types advertised to Antigravity so the composer can attach images, video, and audio.
 *
 * Union of:
 * - Cloud Code native types from the captured fetchAvailableModels fixture
 *   (`video/jpeg2000`, `video/audio/wav`, `audio/webm;codecs=opus`, …)
 * - Gemini generateContent media types from the Gemini API prompting docs
 *   (https://ai.google.dev/gemini-api/docs/vision, /audio, /video)
 */
export const AGY_MULTIMODAL_MIME_TYPES: Record<string, true> = {
  'image/png': true,
  'image/jpeg': true,
  'image/webp': true,
  'image/heic': true,
  'image/heif': true,
  'image/gif': true,
  'video/mp4': true,
  'video/webm': true,
  'video/mpeg': true,
  'video/mpg': true,
  'video/quicktime': true,
  'video/mov': true,
  'video/avi': true,
  'video/x-msvideo': true,
  'video/x-flv': true,
  'video/wmv': true,
  'video/x-ms-wmv': true,
  'video/3gpp': true,
  'video/jpeg2000': true,
  'video/videoframe/jpeg2000': true,
  'video/text/timestamp': true,
  'video/audio/wav': true,
  'video/audio/s16le': true,
  'audio/webm;codecs=opus': true,
  'audio/webm': true,
  'audio/wav': true,
  'audio/x-wav': true,
  'audio/wave': true,
  'audio/vnd.wave': true,
  'audio/mp3': true,
  'audio/mpeg': true,
  'audio/mp4': true,
  'audio/m4a': true,
  'audio/aac': true,
  'audio/ogg': true,
  'audio/opus': true,
  'audio/flac': true,
  'audio/aiff': true,
  'audio/x-aiff': true,
  'audio/l16': true,
};

/** Cloud Code / Antigravity MIME aliases → Gemini generateContent types. */
const GEMINI_MEDIA_MIME_ALIASES: Record<string, string> = {
  'video/audio/wav': 'audio/wav',
  'video/audio/s16le': 'audio/l16',
  'audio/webm;codecs=opus': 'audio/webm',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/mp3': 'audio/mpeg',
  'audio/x-aiff': 'audio/aiff',
  'video/mov': 'video/quicktime',
  'video/avi': 'video/x-msvideo',
  'video/wmv': 'video/x-ms-wmv',
};

export function mergeMultimodalMimeTypes(existing?: unknown): Record<string, true> {
  const merged: Record<string, true> = { ...AGY_MULTIMODAL_MIME_TYPES };
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    for (const [mime, enabled] of Object.entries(existing as Record<string, unknown>)) {
      if (enabled) merged[mime] = true;
    }
  }
  return merged;
}

export function applyMultimodalCapabilities(entry: CatalogModelEntry): CatalogModelEntry {
  entry.supportsImages = true;
  entry.supportsVideo = true;
  entry.supportedMimeTypes = mergeMultimodalMimeTypes(entry.supportedMimeTypes);
  return entry;
}

export function normalizeGeminiMediaMime(mime: string): string {
  const trimmed = mime.trim();
  if (!trimmed) return trimmed;
  return GEMINI_MEDIA_MIME_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

function rewriteMediaBlob(blob: unknown): unknown {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return blob;
  const record = blob as Record<string, unknown>;
  if (typeof record.mimeType !== 'string') return record;
  const mimeType = normalizeGeminiMediaMime(record.mimeType);
  if (mimeType === record.mimeType) return record;
  return { ...record, mimeType };
}

export function rewriteMediaPart(part: unknown): unknown {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
  const record = part as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  let changed = false;
  for (const key of ['inlineData', 'inline_data', 'fileData', 'file_data'] as const) {
    if (!(key in record)) continue;
    const rewritten = rewriteMediaBlob(record[key]);
    if (rewritten !== record[key]) {
      next[key] = rewritten;
      changed = true;
    }
  }
  return changed ? next : part;
}

export function rewriteContentMedia(content: unknown): unknown {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return content;
  const record = content as Record<string, unknown>;
  if (!Array.isArray(record.parts)) return content;
  let changed = false;
  const parts = record.parts.map(part => {
    const rewritten = rewriteMediaPart(part);
    if (rewritten !== part) changed = true;
    return rewritten;
  });
  return changed ? { ...record, parts } : content;
}

export function rewriteRequestMedia(request: Record<string, unknown>): Record<string, unknown> {
  let next = request;
  if (Array.isArray(request.contents)) {
    let contentsChanged = false;
    const contents = request.contents.map(content => {
      const rewritten = rewriteContentMedia(content);
      if (rewritten !== content) contentsChanged = true;
      return rewritten;
    });
    if (contentsChanged) next = { ...next, contents };
  }
  for (const key of ['systemInstruction', 'system_instruction'] as const) {
    if (!(key in next)) continue;
    const rewritten = rewriteContentMedia(next[key]);
    if (rewritten !== next[key]) next = { ...next, [key]: rewritten };
  }
  return next;
}
