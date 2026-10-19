# Changelog

Each package has its own changelog with details:
[Dart](dart/CHANGELOG.md) and [TypeScript](ts/CHANGELOG.md).

## 2026-10-19

- Tracking plan format version 1 ([spec/SPEC.md](spec/SPEC.md)) with a JSON
  Schema for editor autocomplete.
- Dart package 0.1.0 published on pub.dev.
- Dart package 0.2.0 and TypeScript package 0.2.0 (first npm release) with
  the same behavior: TP008 for tabs at the start of a line, more reserved
  names for params, and hardening from a security review.
- Shared fixtures and a parity check that runs both tools on the same plans.
- GitHub Actions workflows for both packages and the parity check.
