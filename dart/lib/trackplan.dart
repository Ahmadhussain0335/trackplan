/// Type-safe analytics code generation from a YAML tracking plan.
///
/// Most users run the command-line tool (`dart run trackplan`). This library
/// exposes the same validation and generation for build tools and tests.
library;

export 'src/dart_generator.dart' show generateDart;
export 'src/diagnostic.dart' show Diagnostic, Severity;
export 'src/docs_generator.dart' show generateDocs;
export 'src/model.dart';
export 'src/validator.dart' show ValidationResult, validatePlan;
