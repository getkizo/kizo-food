# ADR-004: Bun + SQLite Appliance

**Status:** Accepted
**Date:** 2026-01-15
**Deciders:** Kizo engineering

## Context

The Merchant Appliance must run reliably on cheap ARM hardware (Raspberry Pi 4/5, Orange Pi 5) with:

- Low idle memory footprint (< 150 MB)
- Fast cold-start (< 2 s) to survive power-loss restarts
- Zero external infrastructure dependency (no separate database server, message broker, or container runtime)
- Single-file deployment (no Docker, no Node.js ecosystem baggage)

Previous prototypes used Node.js + Express + better-sqlite3. The native module (`better-sqlite3`) required a C++ build step that routinely failed on ARM cross-compilation targets.

## Decision

Use **Bun** as the runtime and **bun:sqlite** (built-in SQLite binding) as the database.

### Bun

- Single binary, no npm-style global installation required on the target device
- `bun:sqlite` is a first-class built-in — no native addon compilation
- Compatible startup time: ~400 ms cold start vs ~1.2 s for equivalent Node.js app
- `bun install` is 10–30× faster than `npm install` — meaningful for on-device updates

### SQLite (WAL mode)

- Zero-dependency embedded database — survives power loss without a running server process
- WAL mode allows concurrent reads while a write is in progress
- `PRAGMA busy_timeout = 5000` prevents write starvation under brief contention
- Forward-only migrations (no rollback) eliminate migration version mismatch on partial updates
- Database file can be copied directly for backup (`bun run backup`)

### Hono

- 14 KB framework, edge-first design maps well to single-file Bun compilation
- Typed `c.var` context propagation replaces Express middleware hacks
- Built-in `hono/zod-validator` for request validation

## Consequences

**Positive:**
- Deployment is `tar -xzf release.tar.gz && bun install && systemctl restart kizo` — no Docker required
- SQLite WAL survives unclean shutdown; journal replay is automatic on next open
- On-device backups are a simple file copy

**Negative:**
- Bun is not Node.js — some npm packages that rely on Node internals (`node:cluster`, certain native addons) are incompatible. Evaluated packages must be tested under Bun.
- Horizontal scaling requires switching to a client–server database (PostgreSQL). Accepted trade-off: each appliance is single-tenant (one merchant), so vertical scaling on ARM hardware is sufficient.
- SQLite write throughput is bounded by a single writer. Measured peak: ~3,000 writes/s on Raspberry Pi 5 — adequate for restaurant order volumes.

## Alternatives Considered

| Alternative | Rejected because |
|---|---|
| Node.js + better-sqlite3 | Native addon breaks ARM cross-compilation |
| Node.js + Prisma + PostgreSQL | Requires a running Postgres process (extra RAM, failure point) |
| Deno + SQLite | Less mature native SQLite support at evaluation time; smaller ecosystem |
| Go + SQLite | Faster but significantly higher development cost; TypeScript is preferred for shared types with the frontend |
