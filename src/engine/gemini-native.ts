import { rewriteRequestMedia } from './media.js';

/** Cloud Code envelope ↔ Gemini generateContent. */

export interface GeminiNativeUpstream {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  modelId: string;
}

export interface CloudCodeEnvelope {
  model?: string;
  project?: unknown;
  request?: Record<string, unknown>;
  requestId?: string;
  [key: string]: unknown;
}

const DEFAULT_SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
];

export function normalizeGeminiBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '');
  url = url.replace(/\/openai$/i, '');
  if (!/\/v1beta$/i.test(url)) {
    url = `${url}/v1beta`;
  }
  return url;
}

export function geminiGenerateUrl(baseUrl: string, modelId: string, stream: boolean): string {
  const root = normalizeGeminiBaseUrl(baseUrl);
  const method = stream ? 'streamGenerateContent' : 'generateContent';
  const encoded = encodeURIComponent(modelId);
  const query = stream ? '?alt=sse' : '';
  return `${root}/models/${encoded}:${method}${query}`;
}

export function cloudCodeToGeminiBody(parsed: CloudCodeEnvelope): Record<string, unknown> {
  const request = (parsed.request && typeof parsed.request === 'object')
    ? rewriteRequestMedia({ ...parsed.request })
    : {};
  if (!request.safetySettings) {
    request.safetySettings = DEFAULT_SAFETY_SETTINGS;
  }
  return request;
}

export function wrapGeminiAsCloudCode(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.response && typeof payload.response === 'object') {
    return payload;
  }
  return {
    response: payload,
    traceId: 'agy-bridge',
    metadata: {},
  };
}

export function normalizeFunctionCallArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object') {
          out[key] = parsed;
          continue;
        }
      } catch { /* keep string */ }
    }
    out[key] = value;
  }
  return out;
}

function rewriteParts(parts: unknown): unknown {
  if (!Array.isArray(parts)) return parts;
  return parts.map(part => {
    if (!part || typeof part !== 'object') return part;
    const record = part as Record<string, unknown>;
    const fn = record.functionCall;
    if (!fn || typeof fn !== 'object') return record;
    const call = fn as Record<string, unknown>;
    const args = call.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return record;
    return {
      ...record,
      functionCall: {
        ...call,
        args: normalizeFunctionCallArgs(args as Record<string, unknown>),
      },
    };
  });
}

export function sanitizeGeminiPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const candidates = payload.candidates;
  if (!Array.isArray(candidates)) return payload;
  return {
    ...payload,
    candidates: candidates.map(candidate => {
      if (!candidate || typeof candidate !== 'object') return candidate;
      const record = candidate as Record<string, unknown>;
      const content = record.content;
      if (!content || typeof content !== 'object') return record;
      const contentRecord = content as Record<string, unknown>;
      return {
        ...record,
        content: {
          ...contentRecord,
          parts: rewriteParts(contentRecord.parts),
        },
      };
    }),
  };
}

export function wrapSseLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return line;
  const raw = trimmed.slice(5).trim();
  if (!raw || raw === '[DONE]') return line;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const inner = parsed.response && typeof parsed.response === 'object'
      ? sanitizeGeminiPayload(parsed.response as Record<string, unknown>)
      : sanitizeGeminiPayload(parsed);
    return `data: ${JSON.stringify(wrapGeminiAsCloudCode(inner))}`;
  } catch {
    return line;
  }
}

export function geminiUpstreamHeaders(apiKey: string, extra?: Record<string, string>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'x-goog-api-key': apiKey,
    ...(extra ?? {}),
  };
}
