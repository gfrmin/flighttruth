import type { FieldName, SourceId, SourceResult } from './types.js';
import { normalizeValue } from './normalize.js';

export interface WeightedValue {
  value: string;
  weight: number;
  sources: SourceId[];
}

export interface FieldDistribution {
  field: FieldName;
  values: WeightedValue[];
  unconfirmed: boolean;
  paywalledAt: SourceId[];
}

export function computeFieldDistribution(
  field: FieldName,
  results: SourceResult[],
  weights: Record<SourceId, number>
): FieldDistribution {
  const paywalledAt: SourceId[] = [];
  const groups = new Map<string, { weight: number; sources: SourceId[] }>();
  let totalWeight = 0;
  let reportingSources = 0;

  for (const result of results) {
    const fieldValue = result.fields[field];
    if (!fieldValue) continue;

    if (fieldValue.paywalled) {
      paywalledAt.push(result.source);
      continue;
    }
    if (!fieldValue.value) continue;

    reportingSources += 1;
    const sourceWeight = weights[result.source] ?? 0;
    totalWeight += sourceWeight;

    const normalized = normalizeValue(field, fieldValue.value);
    const existing = groups.get(normalized);
    if (existing) {
      existing.weight += sourceWeight;
      existing.sources.push(result.source);
    } else {
      groups.set(normalized, { weight: sourceWeight, sources: [result.source] });
    }
  }

  const values: WeightedValue[] = Array.from(groups.entries())
    .map(([value, { weight, sources }]) => ({
      value,
      weight: totalWeight > 0 ? weight / totalWeight : 0,
      sources,
    }))
    .sort((a, b) => b.weight - a.weight);

  return {
    field,
    values,
    unconfirmed: reportingSources === 1,
    paywalledAt,
  };
}
