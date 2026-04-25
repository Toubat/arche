# Arche Design Philosophy

## Purpose

Arche is a contract-first framework for building coding-agent harnesses.

The core idea is simple:

- Models provide intelligence.
- Harnesses provide execution systems.
- Arche provides the reusable foundation for harnesses.

Arche prioritizes extensibility, deterministic behavior, and clean architectural boundaries over shipping many features early.

## Scope (Current)

Initial scope is intentionally narrow:

- `packages/core`: foundational contracts and semantics
- `apps/arche-cli`: first client surface for exercising the core

Everything else is deferred until the core contracts are stable.

## What Core Owns

Core defines stable interfaces, not provider-specific implementations.

Core responsibilities include:

- event and command contracts
- agent runtime lifecycle contracts
- tool-call semantics and hook phases
- model interface contracts
- filesystem interface contracts
- extension lifecycle semantics (register vs activate)

If a concern is required for interoperability and replayable behavior, it belongs in core.
If a concern is a concrete integration or product flavor, it should be outside core.

## Architectural Principles

### 1) Contract-First

Core is the source of truth for protocol and lifecycle contracts.
Integrations implement contracts; they do not redefine them.

### 2) Event-Driven Boundaries

Services communicate through explicit events and commands.
No hidden cross-service coupling.

### 3) Deterministic Semantics

Hook ordering, cancellation behavior, and event processing rules must be explicit and testable.

### 4) Extensibility by Design

Extensibility is the main selling point, not an add-on.
Outside developers should be able to extend behavior through a stable SDK surface.

### 5) Defer Complexity

Non-core packages and advanced integrations are deferred until core contract quality is high.

## What Is Deliberately Deferred

Examples of deferred items (for later phases):

- additional integration packages (`ai`, `fs`, SDK package split, etc.)
- web and gateway surfaces
- enterprise control-plane concerns
- advanced memory/scheduling/benchmarking modules
- execution guard integrations (e.g., AgentSH adapters)

Deferral is not rejection; it is sequencing.

## Near-Term Plan

1. Stabilize `packages/core` contracts.
2. Validate those contracts end-to-end through `apps/arche-cli`.
3. Add tests that lock semantic behavior (event order, hook strategy, lifecycle transitions).
4. Introduce new packages only after contract confidence is high.

## Success Criteria

Arche is succeeding when:

- extensions can be built without touching core internals
- interfaces stay stable while integrations evolve
- behavior is understandable from contracts and events
- new surfaces can be added without redesigning the kernel
