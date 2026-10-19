# trackplan

Generate type-safe analytics code for Dart, Flutter and TypeScript from one
YAML tracking plan.

| Package | Install |
|---|---|
| Dart and Flutter: [pub.dev/packages/trackplan](https://pub.dev/packages/trackplan) | `dart pub add dev:trackplan` |
| TypeScript (web, React Native, Node): [npmjs.com/package/trackplan](https://www.npmjs.com/package/trackplan) | `npm install --save-dev trackplan` |

## The problem

```ts
analytics.track('chekout_completed', { total: '50' });
```

- A typo like `chekout_completed` silently creates a second event.
- Parameters drift: `total` is a string in one place and a number in another.
- The Flutter app and the web app name the same event differently, and no
  one place lists which events exist.

trackplan makes the YAML plan the single source of truth. It generates a
method per event, so a misspelled event or a missing parameter is a compile
error, and a CI command fails when the generated code is out of date.

## Quick start

### Flutter or Dart

```sh
dart pub add dev:trackplan
dart run trackplan init        # sample tracking_plan.yaml
dart run trackplan generate    # lib/analytics/analytics.g.dart
```

```dart
// Events from the sample plan written by `init`.
final analytics = Analytics([DebugAnalyticsAdapter(debugPrint)]);
analytics.signUpCompleted(method: SignUpMethod.google);
```

### TypeScript

```sh
npm install --save-dev trackplan
npx trackplan init             # sample tracking_plan.yaml
npx trackplan generate         # src/analytics/analytics.ts
```

```ts
// Events from the sample plan written by `init`.
const analytics = new Analytics([new DebugAnalyticsAdapter(console.log)]);
analytics.signUpCompleted({ method: 'google' });
```

## One plan, two languages

```yaml
version: 1

targets:
  dart:
    output: lib/analytics/analytics.g.dart
  typescript:
    output: src/analytics/analytics.ts

enums:
  payment_method:
    description: How the user paid.
    values: [card, paypal, cash]

events:
  checkout_completed:
    description: User finished payment successfully.
    owner: growth-team
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

Generated Dart (excerpt):

```dart
/// User finished payment successfully.
///
/// Owner: growth-team
void checkoutCompleted({
  required String orderId,
  required double total,
  required PaymentMethod paymentMethod,
  String? couponCode,
}) {
  assert(total >= 0, 'total must be >= 0');
  ...
  _track('checkout_completed', {
    'order_id': orderId,
    'total': total,
    'payment_method': paymentMethod.value,
    'coupon_code': ?couponCode,
  });
}
```

Generated TypeScript (excerpt):

```ts
/** How the user paid. */
export type PaymentMethod = 'card' | 'paypal' | 'cash';

checkoutCompleted(params: {
  orderId: string;
  total: number;
  paymentMethod: PaymentMethod;
  couponCode?: string | undefined;
}): void
```

Both send the same event name and snake_case payload keys, so dashboards see
one event no matter which app sent it. The full format, all error codes and
the generated code rules are in [spec/SPEC.md](spec/SPEC.md).

## Adapters

The generated class sends each event to a list of adapters that you
implement in a few lines, so trackplan works with any backend: Firebase
Analytics, PostHog, Mixpanel, Amplitude or your own API. trackplan itself
has no dependency on any analytics SDK, and the generated files have no
dependencies at all.

Ready-to-copy adapters (Firebase, PostHog, your own backend, consent) are in
the [Dart README](dart/README.md#adapters) and the
[TypeScript README](ts/README.md#adapters).

## Testing

Each generated file includes `RecordingAnalyticsAdapter`, so tests can check
analytics calls without mocks:

```dart
final recorder = RecordingAnalyticsAdapter();
Analytics([recorder]).productViewed(productId: 'P-1');
expect(recorder.events.single.event, 'product_viewed');
```

```ts
const recorder = new RecordingAnalyticsAdapter();
new Analytics([recorder]).productViewed({ productId: 'P-1' });
expect(recorder.events[0]?.event).toBe('product_viewed');
```

## CI

```sh
dart run trackplan check     # or: npx trackplan check
```

`check` exits with 1 when the generated file is missing or does not match
the plan, so a plan change without regenerated code fails the build.
`validate` reports problems with file, line and column:

```
tracking_plan.yaml:18:15 error TP030 Unknown type "float". Did you mean "double"?
```

`docs` writes `TRACKING_PLAN.md`, an event catalog for product managers.

## How it compares

- [Avo](https://avo.app) is a commercial tracking plan product.
- [Segment Typewriter](https://github.com/segmentio/typewriter) works with
  Segment only, does not generate Dart, and is not actively maintained for
  non-JavaScript SDKs.
- [analytics_gen](https://pub.dev/packages/analytics_gen) generates Dart
  only.

trackplan is free and open source (MIT), vendor-neutral through adapters,
and generates Dart and TypeScript from the same plan, with the same
validation results in both tools.

## Roadmap

Planned, not promised:

- Kotlin and Swift output
- A VS Code extension for plan editing
- User properties and global context params

See [CONTRIBUTING.md](CONTRIBUTING.md) for good first issues.

## Repository layout

| Folder | Contents |
|---|---|
| [`spec/`](spec/) | The tracking plan format (`SPEC.md`) and a JSON Schema for editor autocomplete |
| [`fixtures/`](fixtures/) | Shared test cases that both implementations must pass |
| [`dart/`](dart/) | The Dart package, with a Flutter example |
| [`ts/`](ts/) | The TypeScript package, with a web example |
| [`tool/`](tool/) | `parity.mjs`, which checks that both tools give the same results |

## Privacy

The tools make no network calls and collect no telemetry. Analytics payloads
in your apps can contain personal data such as device identifiers; gate
collection on consent where the law requires it.

## License

[MIT](LICENSE)
