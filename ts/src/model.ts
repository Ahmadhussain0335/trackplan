/** Parameter types of tracking plan v1 (SPEC.md section 3). */
export type ParamType = 'string' | 'int' | 'double' | 'bool' | 'enum' | 'list<string>';

/** All parameter types, in the order of SPEC.md section 3. */
export const paramTypes: readonly ParamType[] = [
  'string',
  'int',
  'double',
  'bool',
  'enum',
  'list<string>',
];

/** A validated tracking plan. Lists are sorted as in SPEC.md section 7.1. */
export interface TrackingPlan {
  /** `meta.name`, if set. */
  readonly name: string | undefined;
  /** `meta.description`, if set. */
  readonly description: string | undefined;
  /** Class name for the Dart target. */
  readonly dartClassName: string;
  /** Output path for the Dart target. */
  readonly dartOutput: string;
  /** Class name for the TypeScript target. */
  readonly typescriptClassName: string;
  /** Output path for the TypeScript target. */
  readonly typescriptOutput: string;
  /** Whether TypeScript runtime checks are enabled. */
  readonly typescriptRuntimeChecks: boolean;
  /** Enums sorted by name. */
  readonly enums: readonly EnumDef[];
  /** Events sorted by name. */
  readonly events: readonly EventDef[];
}

/** An enum of the plan. */
export interface EnumDef {
  /** snake_case plan name. */
  readonly name: string;
  /** Generated PascalCase type name. */
  readonly typeName: string;
  /** Description, if set. */
  readonly description: string | undefined;
  /** Values in plan order. */
  readonly values: readonly EnumValueDef[];
}

/** A value of an enum. */
export interface EnumValueDef {
  /** The value sent on the wire. */
  readonly name: string;
  /** Generated Dart constant name. */
  readonly identifier: string;
}

/** An event of the plan. */
export interface EventDef {
  /** snake_case plan name, sent on the wire. */
  readonly name: string;
  /** Generated method name. */
  readonly identifier: string;
  /** Description, if set. */
  readonly description: string | undefined;
  /** Owner, if set. */
  readonly owner: string | undefined;
  /** Tags in plan order. */
  readonly tags: readonly string[];
  /** Deprecation reason, if deprecated. */
  readonly deprecated: string | undefined;
  /** Params in plan order. */
  readonly params: readonly ParamDef[];
}

/** A param of an event. */
export interface ParamDef {
  /** snake_case plan name, used as the payload key. */
  readonly name: string;
  /** Generated property name. */
  readonly identifier: string;
  /** Param type. */
  readonly type: ParamType;
  /** Description, if set. */
  readonly description: string | undefined;
  /** Whether the param is required. */
  readonly required: boolean;
  /** `min` as written in the plan. */
  readonly min: string | undefined;
  /** `max` as written in the plan. */
  readonly max: string | undefined;
  /** `max_length`. */
  readonly maxLength: number | undefined;
  /** The referenced enum when `type` is `enum`. */
  readonly enumDef: EnumDef | undefined;
}
