// Merge default field config with user overrides from config.json
//
// Resolution order: repo-level (<repo>/.claude/.skill-state/config.json)
// -> user-level (~/claude-skill-tools/config.json) -> hardcoded defaults.
//
// Template fields (Microsoft.VSTS.*) are stored in config.json under "adoFields".

import type { AdoFieldConfig, CategorizedFields } from "./types.js";
import { DEFAULT_FIELD_CONFIG } from "./fields.js";
import { readConfig } from "../../../shared/config.js";

/** Additive merge: user entries appended to defaults, duplicates removed. */
function mergeCategorized(
  defaults: CategorizedFields,
  overrides?: Partial<CategorizedFields>,
): CategorizedFields {
  if (!overrides) return defaults;
  return {
    system: [...new Set([...defaults.system, ...(overrides.system ?? [])])],
    template: [...new Set([...defaults.template, ...(overrides.template ?? [])])],
    custom: [...new Set([...defaults.custom, ...(overrides.custom ?? [])])],
  };
}

/** Resolve effective field config by merging defaults with user overrides. */
export function resolveFieldConfig(): AdoFieldConfig {
  const userFields = readConfig().adoFields;
  if (!userFields) return DEFAULT_FIELD_CONFIG;

  const mapLabeled = (cf: { label: string; fieldRef: string; category: string }) => ({
    label: cf.label,
    fieldRef: cf.fieldRef,
    category: cf.category as "system" | "template" | "custom",
  });

  return {
    skipFields: mergeCategorized(DEFAULT_FIELD_CONFIG.skipFields, userFields.skipFields),
    skipPrefixes: [
      ...new Set([
        ...DEFAULT_FIELD_CONFIG.skipPrefixes,
        ...(userFields.skipPrefixes ?? []),
      ]),
    ],
    renderedFields: mergeCategorized(DEFAULT_FIELD_CONFIG.renderedFields, userFields.renderedFields),
    metadataFields: [
      ...DEFAULT_FIELD_CONFIG.metadataFields,
      ...(userFields.metadataFields ?? []).map(mapLabeled),
    ],
    contentFields: [
      ...DEFAULT_FIELD_CONFIG.contentFields,
      ...(userFields.contentFields ?? []).map(mapLabeled),
    ],
  };
}

/** Build the runtime Sets that fetch-ado-item.ts consumes. */
export function buildFieldSets(): {
  skipKeys: Set<string>;
  skipPrefixes: string[];
  renderedKeys: Set<string>;
  metadataFields: [string, string][];
  keyContentFields: [string, string][];
} {
  const config = resolveFieldConfig();

  const skipKeys = new Set([
    ...config.skipFields.system,
    ...config.skipFields.template,
    ...config.skipFields.custom,
  ]);

  const metadataFields: [string, string][] = config.metadataFields.map(
    (mf) => [mf.label, mf.fieldRef],
  );

  const keyContentFields: [string, string][] = config.contentFields.map(
    (cf) => [cf.label, cf.fieldRef],
  );

  // renderedKeys = explicitly listed + metadata refs + content refs
  const renderedKeys = new Set([
    ...config.renderedFields.system,
    ...config.renderedFields.template,
    ...config.renderedFields.custom,
    ...metadataFields.map(([, ref]) => ref),
    ...keyContentFields.map(([, ref]) => ref),
  ]);

  return { skipKeys, skipPrefixes: config.skipPrefixes, renderedKeys, metadataFields, keyContentFields };
}
