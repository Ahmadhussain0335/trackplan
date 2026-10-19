# trackplan

Type-safe analytics for Dart and Flutter, generated from one YAML tracking
plan. A misspelled event or a missing parameter becomes a compile error.

The plan format is described in
[SPEC.md](https://github.com/Ahmadhussain0335/trackplan/blob/main/spec/SPEC.md).
A TypeScript generator for the same plan format is planned.

## The problem

```dart
analytics.logEvent(name: 'chekout_completed', parameters: {'total': '50'});
```

- The typo creates a second event that nobody looks at.
- `total` is sent as a string in one place and as a number in another.
- The Flutter app and the web app use different names for the same event.

With trackplan, the plan is the single source of truth and the call becomes:

```dart
analytics.checkoutCompleted(
  orderId: 'A12',
  total: 50.0,
  paymentMethod: PaymentMethod.card,
);
```

## Requirements

- The tool needs Dart SDK 3.11 or later. With Flutter, check the bundled
  version with `flutter --version`.
- Generated code needs Dart language version 3.8 or later in your package.
- Generated code has no dependencies; trackplan is only a dev dependency.

## Quick start

```sh
dart pub add dev:trackplan
dart run trackplan init        # writes a sample tracking_plan.yaml
dart run trackplan generate    # writes lib/analytics/analytics.g.dart
```

```dart
import 'analytics/analytics.g.dart';

void main() {
  // Replace DebugAnalyticsAdapter with a real adapter, see "Adapters" below.
  final analytics = Analytics([DebugAnalyticsAdapter(print)]);
  analytics.signUpCompleted(method: SignUpMethod.google);
}
```

A plan looks like this:

```yaml
version: 1

targets:
  dart:
    output: lib/analytics/analytics.g.dart

enums:
  payment_method:
    values: [card, paypal, cash]

events:
  checkout_completed:
    description: User finished payment successfully.
    params:
      order_id:
        type: string
      total:
        type: double
        min: 0
      payment_method:
        type: enum
        enum: payment_method
      coupon_code:
        type: string
        required: false
        max_length: 32
```

Parameter types are `string`, `int`, `double`, `bool`, `enum` and
`list<string>`. Event and parameter names are snake_case in the plan and on
the wire, and camelCase in Dart. Names that are reserved words get a trailing
underscore in Dart (`class` becomes `class_`), while the name sent to your
backend stays the same.

## Commands

| Command | What it does |
|---|---|
| `dart run trackplan init` | Writes a sample `tracking_plan.yaml`. Never overwrites a file. |
| `dart run trackplan validate` | Checks the plan and prints errors with line and column. `--json` for tools. |
| `dart run trackplan generate` | Writes the Dart file. |
| `dart run trackplan check` | Exits with 1 if the Dart file is missing or out of date. Use it in CI. |
| `dart run trackplan docs` | Writes `TRACKING_PLAN.md`, an event catalog for product managers. |

Options:

| Option | Commands |
|---|---|
| `--plan <path>` (default `tracking_plan.yaml`) | all |
| `--out <path>` | `generate`, `check`, `docs` |
| `--allow-outside` (allow output paths outside the project) | `validate`, `generate`, `check`, `docs` |
| `--json` | `validate` |
| `--help` | all |
| `--version` | on its own: `dart run trackplan --version` |

Exit codes: `0` success, `1` the plan has errors or `check` failed, `2` the
tool could not run (bad arguments, missing file).

Example output:

```
tracking_plan.yaml:18:15 error TP030 Unknown type "float". Did you mean "double"?
1 error, 0 warnings.
```

## Adapters

The generated `Analytics` class sends every event to a list of adapters. An
adapter implements one method:

```dart
abstract interface class AnalyticsAdapter {
  void track(String event, Map<String, Object> params);
}
```

The snippets below were checked against `firebase_analytics` 13.0.0 and
`posthog_flutter` 5.55.0. Copy them into your app; trackplan itself does not
depend on any analytics SDK.

### Firebase Analytics

```dart
import 'dart:async';

import 'package:firebase_analytics/firebase_analytics.dart';
import 'package:flutter/foundation.dart';

import 'analytics/analytics.g.dart';

/// Sends events to Firebase Analytics.
///
/// Firebase accepts only string and number parameter values, so booleans
/// and lists are converted here.
class FirebaseAnalyticsAdapter implements AnalyticsAdapter {
  FirebaseAnalyticsAdapter([FirebaseAnalytics? analytics])
    : _analytics = analytics ?? FirebaseAnalytics.instance;

  final FirebaseAnalytics _analytics;

  @override
  void track(String event, Map<String, Object> params) {
    unawaited(
      _analytics
          .logEvent(
            name: event,
            parameters: {
              for (final MapEntry(:key, :value) in params.entries)
                key: switch (value) {
                  // Use 1 and 0 instead if you prefer numeric values.
                  bool() => value.toString(),
                  List<String>() => value.join(','),
                  _ => value,
                },
            },
          )
          .catchError((Object e) => debugPrint('Firebase logEvent failed: $e')),
    );
  }
}
```

Add `settings: {warn_provider_limits: [firebase]}` to your plan to get
warnings for Firebase's documented limits: event and parameter name length,
reserved event names and prefixes, number of parameters per event, string
length, parameter types other than string and number, and the number of
distinct events.

### PostHog

```dart
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:posthog_flutter/posthog_flutter.dart';

import 'analytics/analytics.g.dart';

/// Sends events to PostHog.
class PostHogAnalyticsAdapter implements AnalyticsAdapter {
  @override
  void track(String event, Map<String, Object> params) {
    unawaited(
      Posthog()
          .capture(eventName: event, properties: params)
          .catchError((Object e) => debugPrint('PostHog capture failed: $e')),
    );
  }
}
```

### Your own backend, and consent

```dart
import 'dart:async';

import 'analytics/analytics.g.dart';

/// Sends events to your own backend in batches.
///
/// [send] is your code, for example an HTTPS POST to your collector. Events
/// are only kept in memory until [flush] is called.
class BatchingAnalyticsAdapter implements AnalyticsAdapter {
  BatchingAnalyticsAdapter(this.send, {this.batchSize = 20});

  final Future<void> Function(List<Map<String, Object>> batch) send;
  final int batchSize;
  final _queue = <Map<String, Object>>[];

  @override
  void track(String event, Map<String, Object> params) {
    _queue.add({'event': event, 'params': params});
    if (_queue.length >= batchSize) {
      // A failed batch stays queued and is retried on the next flush.
      unawaited(flush().catchError((Object _) {}));
    }
  }

  /// Sends all queued events. If [send] throws, the events are queued again.
  Future<void> flush() async {
    if (_queue.isEmpty) return;
    final batch = List.of(_queue);
    _queue.clear();
    try {
      await send(batch);
    } catch (_) {
      _queue.insertAll(0, batch);
      rethrow;
    }
  }
}

/// Drops events until the user has given consent.
///
/// This only filters events sent through trackplan. Analytics SDKs also
/// collect events on their own (for example app opens and sessions), so
/// disable their collection until consent as well, for example with
/// `FirebaseAnalytics.instance.setAnalyticsCollectionEnabled(false)` or
/// PostHog's `optOut()`.
class ConsentAnalyticsAdapter implements AnalyticsAdapter {
  ConsentAnalyticsAdapter(this.inner, {required this.hasConsent});

  final AnalyticsAdapter inner;
  final bool Function() hasConsent;

  @override
  void track(String event, Map<String, Object> params) {
    if (hasConsent()) inner.track(event, params);
  }
}
```

### Debug logging

`DebugAnalyticsAdapter` passes one line per event to a callback you choose,
for example `debugPrint`. It logs full payloads, which may include user or
device identifiers, so only add it in debug builds:

```dart
import 'package:flutter/foundation.dart';

final analytics = Analytics([
  FirebaseAnalyticsAdapter(),
  if (kDebugMode) DebugAnalyticsAdapter(debugPrint),
]);
```

## Testing

Every generated file includes `RecordingAnalyticsAdapter`, which keeps
events in memory:

```dart
test('checkout sends the order', () {
  final recorder = RecordingAnalyticsAdapter();
  final analytics = Analytics([recorder]);

  analytics.checkoutCompleted(
    orderId: 'A12',
    total: 50,
    paymentMethod: PaymentMethod.card,
  );

  expect(recorder.events.single.event, 'checkout_completed');
  expect(recorder.events.single.params['order_id'], 'A12');
});
```

`min`, `max` and `max_length` from the plan become `assert`s, so tests and
debug builds fail on out-of-range values. Release builds do not check them.

## CI

Fail the build when someone edits the plan but forgets to regenerate:

```sh
dart run trackplan check
```

The generated file contains `// dart format off` after its header, so
`dart format` in your project leaves it unchanged and `check` keeps passing.

## Library API

The CLI is the main interface. For build tools there is also a small
library: `validatePlan` returns diagnostics and the validated plan,
`generateDart` and `generateDocs` turn the plan into file contents.

## Privacy

trackplan makes no network calls and collects no telemetry. Analytics
payloads in your app can contain personal data such as device identifiers.
Where the law requires consent, gate both trackplan's adapters (see
`ConsentAnalyticsAdapter` above) and your analytics SDK's own collection, and
keep personal data out of event parameters where you can.

## License

MIT
