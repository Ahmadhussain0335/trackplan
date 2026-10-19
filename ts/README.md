# trackplan

Type-safe analytics for TypeScript, generated from one YAML tracking plan. A
misspelled event or a missing parameter becomes a compile error. Works for
web, React Native and Node.

The same plan also generates Dart and Flutter code with the
[trackplan Dart package](https://pub.dev/packages/trackplan). See the
[main README](https://github.com/Ahmadhussain0335/trackplan#readme) and the
[plan format](https://github.com/Ahmadhussain0335/trackplan/blob/main/spec/SPEC.md).

## The problem

```ts
analytics.track('chekout_completed', { total: '50' });
```

- The typo creates a second event that nobody looks at.
- `total` is sent as a string in one place and as a number in another.
- The web app and the mobile app use different names for the same event.

With trackplan, the plan is the single source of truth and the call becomes:

```ts
analytics.checkoutCompleted({ orderId: 'A12', total: 50, paymentMethod: 'card' });
```

## Requirements

- Node.js 20 or later to run the tool.
- Generated code has no dependencies and compiles with `strict: true`
  (also with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax` and `erasableSyntaxOnly`). trackplan is only a dev
  dependency.

## Quick start

```sh
npm install --save-dev trackplan
npx trackplan init        # writes a sample tracking_plan.yaml
npx trackplan generate    # writes src/analytics/analytics.ts
```

```ts
import { Analytics, DebugAnalyticsAdapter } from './analytics/analytics.js';

// Replace DebugAnalyticsAdapter with a real adapter, see "Adapters" below.
const analytics = new Analytics([new DebugAnalyticsAdapter(console.log)]);
analytics.signUpCompleted({ method: 'google' });
```

A plan looks like this:

```yaml
version: 1

targets:
  typescript:
    output: src/analytics/analytics.ts

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

Parameter types are `string`, `int`, `double`, `bool`, `enum` (a string
literal union) and `list<string>`. Names are snake_case in the plan and on
the wire, and camelCase in TypeScript. Names that are reserved words get a
trailing underscore (`class` becomes `class_`), while the name sent to your
backend stays the same.

## Commands

| Command                  | What it does                                                                 |
| ------------------------ | ---------------------------------------------------------------------------- |
| `npx trackplan init`     | Writes a sample `tracking_plan.yaml`. Never overwrites a file.               |
| `npx trackplan validate` | Checks the plan and prints errors with line and column. `--json` for tools.  |
| `npx trackplan generate` | Writes the TypeScript file.                                                  |
| `npx trackplan check`    | Exits with 1 if the TypeScript file is missing or out of date. Use it in CI. |
| `npx trackplan docs`     | Writes `TRACKING_PLAN.md`, an event catalog for product managers.            |

Options:

| Option                                                     | Commands                                |
| ---------------------------------------------------------- | --------------------------------------- |
| `--plan <path>` (default `tracking_plan.yaml`)             | all                                     |
| `--out <path>`                                             | `generate`, `check`, `docs`             |
| `--allow-outside` (allow output paths outside the project) | `validate`, `generate`, `check`, `docs` |
| `--json`                                                   | `validate`                              |
| `--help`                                                   | all                                     |
| `--version`                                                | on its own: `npx trackplan --version`   |

Exit codes: `0` success, `1` the plan has errors or `check` failed, `2` the
tool could not run (bad arguments, missing file).

Example output:

```
tracking_plan.yaml:18:15 error TP030 Unknown type "float". Did you mean "double"?
1 error, 0 warnings.
```

For well-formed YAML, the Dart and TypeScript tools report the same codes,
positions and messages. This is checked by shared test fixtures and a parity
test that runs both tools on the same plans. For malformed YAML the two YAML
parsers can differ in which syntax error they report.

## Runtime checks

TypeScript types cannot express `min`, `max`, `max_length` or integers, so
by default these are only documented. To check them at runtime, set
`runtime_checks: true`; the generated methods then throw a `RangeError` for
out-of-range values, strings that are too long, and non-integers passed to
`int` params:

```yaml
targets:
  typescript:
    runtime_checks: true
```

## Adapters

The generated `Analytics` class sends every event to a list of adapters. An
adapter implements one method:

```ts
export interface AnalyticsAdapter {
  track(event: string, params: AnalyticsParams): void;
}
```

`params` is frozen, so an adapter cannot change what the next adapter sees.
The snippets below were checked against `firebase` 13.0.0 and `posthog-js`
1.438.12 in a project using bundler module resolution (Vite, webpack,
Next.js). trackplan itself does not depend on any analytics SDK.

### Firebase Analytics (web)

```ts
import { type Analytics as FirebaseAnalytics, logEvent } from 'firebase/analytics';

import type { AnalyticsAdapter, AnalyticsParams } from './analytics/analytics.js';

/**
 * Sends events to Firebase Analytics (web SDK).
 *
 * Firebase accepts only string and number parameter values, so booleans and
 * lists are converted here.
 */
export class FirebaseAnalyticsAdapter implements AnalyticsAdapter {
  private readonly analytics: FirebaseAnalytics;

  constructor(analytics: FirebaseAnalytics) {
    this.analytics = analytics;
  }

  track(event: string, params: AnalyticsParams): void {
    const converted: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(params)) {
      // Use 1 and 0 instead if you prefer numeric values.
      converted[key] =
        typeof value === 'boolean'
          ? String(value)
          : typeof value === 'object'
            ? value.join(',')
            : value;
    }
    logEvent(this.analytics, event, converted);
  }
}
```

Add `settings: {warn_provider_limits: [firebase]}` to your plan to get
warnings for Firebase's documented limits: event and parameter name length,
reserved event names and prefixes, number of parameters per event, string
length, parameter types other than string and number, and the number of
distinct events.

### PostHog

```ts
import posthog from 'posthog-js';

import type { AnalyticsAdapter, AnalyticsParams } from './analytics/analytics.js';

/** Sends events to PostHog (browser SDK, after `posthog.init(...)`). */
export class PostHogAnalyticsAdapter implements AnalyticsAdapter {
  track(event: string, params: AnalyticsParams): void {
    posthog.capture(event, { ...params });
  }
}
```

### Your own backend

See [`examples/web/src/main.ts`](https://github.com/Ahmadhussain0335/trackplan/blob/main/ts/examples/web/src/main.ts)
for an adapter that sends events to your own HTTPS collector with
`navigator.sendBeacon` or `fetch`.

### Consent

An adapter can drop events until the user has agreed:

```ts
export class ConsentAnalyticsAdapter implements AnalyticsAdapter {
  private readonly inner: AnalyticsAdapter;
  private readonly hasConsent: () => boolean;

  constructor(inner: AnalyticsAdapter, hasConsent: () => boolean) {
    this.inner = inner;
    this.hasConsent = hasConsent;
  }

  track(event: string, params: AnalyticsParams): void {
    if (this.hasConsent()) this.inner.track(event, params);
  }
}
```

This only filters events sent through trackplan. Analytics SDKs also collect
events on their own (for example page views and sessions), so disable their
collection until consent as well, for example with Firebase's
`setAnalyticsCollectionEnabled` or PostHog's `opt_out_capturing()`.

### Debug logging

`DebugAnalyticsAdapter` passes one line per event to a function you choose,
for example `console.log`. It logs full payloads, which may include user or
device identifiers, so only add it in development builds.

## Testing

Every generated file includes `RecordingAnalyticsAdapter`, which keeps
events in memory:

```ts
import { expect, it } from 'vitest';

import { Analytics, RecordingAnalyticsAdapter } from './analytics/analytics.js';

it('checkout sends the order', () => {
  const recorder = new RecordingAnalyticsAdapter();
  const analytics = new Analytics([recorder]);

  analytics.checkoutCompleted({ orderId: 'A12', total: 50, paymentMethod: 'card' });

  expect(recorder.events[0]?.event).toBe('checkout_completed');
  expect(recorder.events[0]?.params['order_id']).toBe('A12');
});
```

## CI

Fail the build when someone edits the plan but forgets to regenerate:

```sh
npx trackplan check
```

The generated file starts with `/* eslint-disable */` after its header. If
you use Prettier, add the file to `.prettierignore` so formatting does not
change it and `check` keeps passing.

## Library API

The CLI is the main interface. For build tools there is also a small
library: `validatePlan` returns diagnostics and the validated plan;
`generateTypescript` and `generateDocs` turn the plan into file contents.

```ts
import { readFileSync } from 'node:fs';

import { formatDiagnostic, generateTypescript, validatePlan } from 'trackplan';

const result = validatePlan(readFileSync('tracking_plan.yaml'));
for (const d of result.diagnostics) console.log(formatDiagnostic(d, 'tracking_plan.yaml'));
if (result.plan) console.log(generateTypescript(result.plan, 'tracking_plan.yaml'));
```

## Versions

The npm package and the [Dart package](https://pub.dev/packages/trackplan)
share major and minor versions: `0.2.x` of both validate plans and report
diagnostics the same way. Patch versions can differ when a release only
changes one package's documentation.

## Privacy

trackplan makes no network calls and collects no telemetry. Analytics
payloads in your app can contain personal data such as device identifiers.
Where the law requires consent, gate both trackplan's adapters and your
analytics SDK's own collection, and keep personal data out of event
parameters where you can.

## License

MIT
