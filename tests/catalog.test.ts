import { describe, expect, it } from 'vitest';
import { injectRelayModels, maxSwitchSlots } from '../src/engine/catalog.js';
import { AGY_MULTIMODAL_MIME_TYPES } from '../src/engine/media.js';
import type { AntigravityRoute, CatalogFixture } from '../src/engine/types.js';
import catalogFixtureRaw from '../src/engine/fixtures/fetchAvailableModels.json' with { type: 'json' };

const fixture = catalogFixtureRaw as unknown as CatalogFixture;

const route = (): AntigravityRoute => ({
  catalogId: 'agy-bridge__remote__gemini-3-8-flash',
  providerId: 'remote',
  providerName: 'CPA',
  modelId: 'gemini-3.8-flash',
  upstreamModelId: 'gemini-3.8-flash',
  displayName: 'Gemini 3.8 Flash (Bridge)',
  modelFormat: 'gemini-native',
  npm: '@ai-sdk/google',
  apiKey: 'test-key',
  baseURL: 'http://127.0.0.1:9',
  contextWindow: 1048576,
});

describe('injectRelayModels multimodal catalog', () => {
  it('uses the Antigravity 2.13.0 Recommended default slot', () => {
    const catalog = injectRelayModels(fixture, [route()], 'gemini-3.8-flash-high');
    expect(catalog.defaultAgentModelId).toBe('gemini-3.8-flash-high');
    expect(catalog.models['gemini-3.8-flash-high']?.model).toBe('MODEL_PLACEHOLDER_M318');
    expect(maxSwitchSlots()).toBe(14);
  });

  it('advertises current image, video, and audio MIME types on the cloned switch slot', () => {
    const catalog = injectRelayModels(fixture, [route()], 'gemini-3.8-flash-high');
    const slot = catalog.models['gemini-3.8-flash-high'];
    expect(slot?.supportsImages).toBe(true);
    expect(slot?.supportsVideo).toBe(true);
    expect(slot?.supportedMimeTypes?.['video/mp4']).toBe(true);
    expect(slot?.supportedMimeTypes?.['video/webm']).toBe(true);
    expect(slot?.supportedMimeTypes?.['audio/webm;codecs=opus']).toBe(true);
    expect(slot?.supportedMimeTypes?.['audio/mpeg']).toBe(true);
    expect(slot?.supportedMimeTypes?.['audio/wav']).toBe(true);
    expect(slot?.supportedMimeTypes?.['video/quicktime']).toBe(true);
    expect(slot?.supportedMimeTypes?.['video/audio/wav']).toBe(true);
    for (const mime of Object.keys(AGY_MULTIMODAL_MIME_TYPES)) {
      expect(slot?.supportedMimeTypes?.[mime], mime).toBe(true);
    }
  });

  it('keeps Cloud Code audio transcription models instead of stripping audio', () => {
    const catalog = injectRelayModels(fixture, [route()], 'gemini-3.8-flash-high');
    expect(catalog.audioTranscriptionModelIds).toEqual(fixture.audioTranscriptionModelIds);
    expect(catalog.models['gemini-3.8-flash-high']?.supportedMimeTypes?.['audio/webm;codecs=opus']).toBe(true);
  });
});
