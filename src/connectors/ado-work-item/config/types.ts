// Type definitions for ADO field configuration

/**
 * Classification of an ADO field by its namespace origin.
 * - "system"   = System.* fields (universal across all processes)
 * - "template" = Microsoft.VSTS.* fields (process-template-dependent)
 * - "custom"   = Custom.* or organization-specific fields
 */
export type AdoFieldCategory = "system" | "template" | "custom";

/** A labeled field reference used in metadata bar and content sections. */
export interface AdoLabeledField {
  label: string; // Display label, e.g. "Priority" or "Repro Steps"
  fieldRef: string; // ADO field reference name, e.g. "Microsoft.VSTS.Common.Priority"
  category: AdoFieldCategory;
}

/** Field lists split by category for clear standard-vs-custom separation. */
export interface CategorizedFields {
  system: string[];
  template: string[];
  custom: string[];
}

/** Complete field configuration for ADO work item rendering. */
export interface AdoFieldConfig {
  /** Fields to exclude from output entirely (internal/noise). */
  skipFields: CategorizedFields;
  /** Field-name prefixes to skip (e.g. "WEF_", "Custom."). */
  skipPrefixes: string[];
  /** Fields rendered explicitly in header or key-content sections. */
  renderedFields: CategorizedFields;
  /** Fields shown in the inline metadata bar (e.g. Priority | Severity | Area). */
  metadataFields: AdoLabeledField[];
  /** Ordered content sections rendered as markdown heading + body. */
  contentFields: AdoLabeledField[];
}
