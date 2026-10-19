/**
 * Type-safe analytics code generation from a YAML tracking plan.
 *
 * Most users run the command-line tool (`npx trackplan`). This module exposes
 * the same validation and generation for build tools and tests. The CLI adds
 * safe file writing (no writes outside the project, no overwriting files it
 * did not generate); prefer it where possible.
 *
 * @packageDocumentation
 */
export type { Diagnostic, Severity } from './diagnostic.js';
export { formatDiagnostic } from './diagnostic.js';
export { generateDocs } from './docsGenerator.js';
export type {
  EnumDef,
  EnumValueDef,
  EventDef,
  ParamDef,
  ParamType,
  TrackingPlan,
} from './model.js';
export { generateTypescript } from './tsGenerator.js';
export type { ValidationResult } from './validator.js';
export { hasErrors, validatePlan } from './validator.js';
