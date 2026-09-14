import { describe, expect, it } from 'vitest';
import {
  cloudCodeToGeminiBody,
  geminiGenerateUrl,
  normalizeGeminiBaseUrl,
  sanitizeGeminiPayload,
  wrapGeminiAsCloudCode,
  wrapSseLine,
} from '../src/engine/gemini-native.js';

describe('gemini native mapping', () => {
  it('normalizes base URLs onto /v1beta', () => {
    expect(normalizeGeminiBaseUrl('https://gw.example.com')).toBe('https://gw.example.com/v1beta');
    expect(normalizeGeminiBaseUrl('https://gw.example.com/v1beta/')).toBe('https://gw.example.com/v1beta');
    expect(normalizeGeminiBaseUrl('https://gw.example.com/v1beta/openai')).toBe('https://gw.example.com/v1beta');
  });

  it('builds generateContent URLs', () => {
    expect(geminiGenerateUrl('https://gw.example.com', 'gemini-3-pro', false))
      .toBe('https://gw.example.com/v1beta/models/gemini-3-pro:generateContent');
    expect(geminiGenerateUrl('https://gw.example.com', 'gemini-3-pro', true))
      .toBe('https://gw.example.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse');
  });

  it('unwraps the Cloud Code envelope into a Gemini body', () => {
    const body = cloudCodeToGeminiBody({
      model: 'slot',
      project: 'ignored',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      },
    });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    expect(body.safetySettings).toBeTruthy();
  });

  it('rewrites Antigravity media MIME aliases without copying inline payloads', () => {
    const data = 'AAAA';
    const body = cloudCodeToGeminiBody({
      request: {
        contents: [{
          role: 'user',
          parts: [
            { text: 'watch' },
            { inlineData: { mimeType: 'video/mp4', data } },
            { inlineData: { mimeType: 'video/audio/wav', data } },
            { fileData: { mimeType: 'audio/webm;codecs=opus', fileUri: 'file://clip.webm' } },
          ],
        }],
      },
    });
    const parts = (body.contents as any)[0].parts;
    expect(parts[1].inlineData).toEqual({ mimeType: 'video/mp4', data });
    expect(parts[2].inlineData).toEqual({ mimeType: 'audio/wav', data });
    expect(parts[2].inlineData.data).toBe(data);
    expect(parts[3].fileData.mimeType).toBe('audio/webm');
  });

  it('wraps Gemini payloads as Cloud Code responses', () => {
    const wrapped = wrapGeminiAsCloudCode({
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
    });
    expect(wrapped.response).toMatchObject({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    });
  });

  it('does not double-wrap Cloud Code payloads', () => {
    const already = { response: { candidates: [] }, traceId: 'x', metadata: {} };
    expect(wrapGeminiAsCloudCode(already)).toBe(already);
  });

  it('un-stringifies MCP-style function call arguments', () => {
    const sanitized = sanitizeGeminiPayload({
      candidates: [{
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'call_mcp_tool', args: { Arguments: '{"path":"a.ts"}' } } }],
        },
      }],
    });
    const call = (sanitized.candidates as any)[0].content.parts[0].functionCall;
    expect(call.args.Arguments).toEqual({ path: 'a.ts' });
  });

  it('wraps SSE data lines into the Cloud Code envelope', () => {
    const line = wrapSseLine('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]}}]}');
    const payload = JSON.parse(line.slice(5).trim());
    expect(payload.response.candidates[0].content.parts[0].text).toBe('hi');
    expect(payload.traceId).toBe('agy-bridge');
  });
});
