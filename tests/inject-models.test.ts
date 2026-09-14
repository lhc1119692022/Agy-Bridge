import { describe, expect, it } from 'vitest';
import { maxSwitchSlots } from '../src/engine/catalog.js';
import { resolveInjectModels } from '../src/engine/inject-models.js';

const catalog = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
  { id: 'c', name: 'C' },
  { id: 'd', name: 'D' },
];

describe('resolveInjectModels', () => {
  it('injects nothing when the user has not checked any model', () => {
    expect(resolveInjectModels({ catalog, selectedIds: [], slotCap: 6 }).models).toEqual([]);
  });

  it('uses check order instead of catalog order', () => {
    const plan = resolveInjectModels({
      catalog,
      selectedIds: ['d', 'a', 'c'],
      slotCap: 6,
    });
    expect(plan.models.map(model => model.id)).toEqual(['d', 'a', 'c']);
    expect(plan.skippedIds).toEqual([]);
  });

  it('caps by Antigravity switch slots, keeping the first checked models', () => {
    const plan = resolveInjectModels({
      catalog,
      selectedIds: ['d', 'c', 'b', 'a'],
      slotCap: 2,
    });
    expect(plan.models.map(model => model.id)).toEqual(['d', 'c']);
    expect(plan.skippedIds).toEqual(['b', 'a']);
  });

  it('ignores ids that are not in the catalog', () => {
    const plan = resolveInjectModels({
      catalog,
      selectedIds: ['missing', 'b'],
      slotCap: 6,
    });
    expect(plan.models.map(model => model.id)).toEqual(['b']);
  });

  it('reads the live Antigravity switch-slot cap from the catalog fixture', () => {
    expect(maxSwitchSlots()).toBeGreaterThanOrEqual(1);
  });
});
