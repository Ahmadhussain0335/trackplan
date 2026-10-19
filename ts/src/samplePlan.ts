/** The plan written by `trackplan init`. */
export const samplePlan = `# Tracking plan for trackplan. Each event becomes a type-safe method.
# Event and param names are lowercase snake_case.
version: 1

meta:
  name: My App
  description: Analytics events for My App.

targets:
  dart:
    output: lib/analytics/analytics.g.dart
    class_name: Analytics
  typescript:
    output: src/analytics/analytics.ts
    class_name: Analytics

enums:
  sign_up_method:
    description: How the user signed up.
    values: [email, google, apple]

events:
  sign_up_completed:
    description: User created an account.
    params:
      method:
        type: enum
        enum: sign_up_method

  screen_viewed:
    description: User opened a screen.
    params:
      screen_name:
        type: string
        max_length: 100
`;
