import type { UpstreamModel } from '../shared/types.js';

export interface InjectModelPlan {
  models: UpstreamModel[];
  skippedIds: string[];
}

export function resolveInjectModels(opts: {
  catalog: UpstreamModel[];
  selectedIds: string[];
  slotCap: number;
}): InjectModelPlan {
  const byId = new Map(opts.catalog.map(model => [model.id, model]));
  const resolved: UpstreamModel[] = [];
  const seen = new Set<string>();
  for (const id of opts.selectedIds) {
    const model = byId.get(id);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    resolved.push(model);
  }
  return {
    models: resolved.slice(0, opts.slotCap),
    skippedIds: resolved.slice(opts.slotCap).map(model => model.id),
  };
}
