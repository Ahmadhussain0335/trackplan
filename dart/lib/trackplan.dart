/// Type-safe analytics code generation from a YAML tracking plan.
///
/// Most users run the command-line tool (`dart run trackplan`). This library
/// exposes the same validation and generation for build tools and tests:
///
/// ```dart
/// import 'dart:io';
///
/// import 'package:trackplan/trackplan.dart';
///
/// void main() {
///   final result = validatePlan(File('tracking_plan.yaml').readAsBytesSync());
///   for (final diagnostic in result.diagnostics) {
///     print(diagnostic.format('tracking_plan.yaml'));
///   }
///   final plan = result.plan;
///   if (plan != null) {
///     File(plan.dartOutput)
///       ..parent.createSync(recursive: true)
///       ..writeAsStringSync(generateDart(plan, 'tracking_plan.yaml'));
///   }
/// }
/// ```
///
/// The CLI adds safe file writing (no writes outside the project, no
/// overwriting files it did not generate); prefer it where possible.
library;

export 'src/dart_generator.dart' show generateDart;
export 'src/diagnostic.dart' show Diagnostic, Severity;
export 'src/docs_generator.dart' show generateDocs;
export 'src/model.dart';
export 'src/validator.dart' show ValidationResult, validatePlan;
