/// Parameter types of tracking plan v1 (SPEC.md section 3).
enum ParamType {
  /// `string`
  string('string'),

  /// `int`
  int_('int'),

  /// `double`
  double_('double'),

  /// `bool`
  bool_('bool'),

  /// `enum`
  enum_('enum'),

  /// `list<string>`
  stringList('list<string>');

  const ParamType(this.planName);

  /// The name used in the plan.
  final String planName;

  /// Looks up a type by its plan name.
  static ParamType? fromPlanName(String name) {
    for (final type in values) {
      if (type.planName == name) return type;
    }
    return null;
  }
}

/// A validated tracking plan. Lists are sorted as in SPEC.md section 7.1.
final class TrackingPlan {
  /// Creates a plan.
  const TrackingPlan({
    required this.name,
    required this.description,
    required this.dartClassName,
    required this.dartOutput,
    required this.typescriptClassName,
    required this.typescriptOutput,
    required this.typescriptRuntimeChecks,
    required this.enums,
    required this.events,
  });

  /// `meta.name`, or `null`.
  final String? name;

  /// `meta.description`, or `null`.
  final String? description;

  /// Class name for the Dart target.
  final String dartClassName;

  /// Output path for the Dart target.
  final String dartOutput;

  /// Class name for the TypeScript target.
  final String typescriptClassName;

  /// Output path for the TypeScript target.
  final String typescriptOutput;

  /// Whether TypeScript runtime checks are enabled.
  final bool typescriptRuntimeChecks;

  /// Enums sorted by name.
  final List<EnumDef> enums;

  /// Events sorted by name.
  final List<EventDef> events;
}

/// An enum of the plan.
final class EnumDef {
  /// Creates an enum.
  const EnumDef({
    required this.name,
    required this.typeName,
    required this.description,
    required this.values,
  });

  /// snake_case plan name.
  final String name;

  /// Generated PascalCase type name.
  final String typeName;

  /// Description, or `null`.
  final String? description;

  /// Values in plan order.
  final List<EnumValueDef> values;
}

/// A value of an [EnumDef].
final class EnumValueDef {
  /// Creates an enum value.
  const EnumValueDef(this.name, this.identifier);

  /// The value sent on the wire.
  final String name;

  /// Generated Dart constant name.
  final String identifier;
}

/// An event of the plan.
final class EventDef {
  /// Creates an event.
  const EventDef({
    required this.name,
    required this.identifier,
    required this.description,
    required this.owner,
    required this.tags,
    required this.deprecated,
    required this.params,
  });

  /// snake_case plan name, sent on the wire.
  final String name;

  /// Generated method name.
  final String identifier;

  /// Description, or `null`.
  final String? description;

  /// Owner, or `null`.
  final String? owner;

  /// Tags in plan order.
  final List<String> tags;

  /// Deprecation reason, or `null`.
  final String? deprecated;

  /// Params in plan order.
  final List<ParamDef> params;
}

/// A param of an [EventDef].
final class ParamDef {
  /// Creates a param.
  const ParamDef({
    required this.name,
    required this.identifier,
    required this.type,
    required this.description,
    required this.required,
    required this.min,
    required this.max,
    required this.maxLength,
    required this.enumDef,
  });

  /// snake_case plan name, used as the payload key.
  final String name;

  /// Generated argument name.
  final String identifier;

  /// Param type.
  final ParamType type;

  /// Description, or `null`.
  final String? description;

  /// Whether the param is required.
  final bool required;

  /// `min` as written in the plan, or `null`.
  final String? min;

  /// `max` as written in the plan, or `null`.
  final String? max;

  /// `max_length`, or `null`.
  final int? maxLength;

  /// The referenced enum when [type] is [ParamType.enum_].
  final EnumDef? enumDef;
}
