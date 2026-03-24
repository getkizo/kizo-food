# kizo-food

Kizo sector for restaurants, cafés, and coffee shops — register, orders, kitchen display, stock, and payment hardware adapters.

This is a **sector repo** within the [Kizo platform](https://github.com/getkizo/kizo). It is registered as a git submodule of the main monorepo and can also be cloned and run independently.

---

## What's in this repo

### Apps

| Path | Description |
|---|---|
| `apps/shell` | Sector shell — loads and composes the modules below into a single deployable PWA |

### Modules

| Path | Description |
|---|---|
| `modules/register` | Point-of-sale register for table and counter service |
| `modules/orders` | Order management and status tracking |
| `modules/kitchen-display` | Kitchen display system (KDS) |
| `modules/menu` | Menu and item management |
| `modules/stock` | Inventory and stock control |

### Adapters

Adapters are open-source integrations that connect third-party hardware or services to the Kizo event bus. They are standalone projects — each has its own build system, README, and license.

| Path | Platform | Description |
|---|---|---|
| `adapters/baanbaan-counter` | Android | Counter-facing payment terminal. Drives a Finix D135 Bluetooth card reader via a WebSocket protocol. Handles tip selection, signature capture, and card payment. |

### Packages

| Path | Description |
|---|---|
| `packages/shared` | Shared domain types, event definitions, and utilities for modules in this sector |

---

## Repository structure and Git workflow

### This repo as a submodule

`kizo-food` is registered as a submodule of the [kizo monorepo](https://github.com/getkizo/kizo). If you cloned the monorepo, initialize it with:

```bash
git submodule update --init kizo-food
```

To update the monorepo to the latest commit of this sector:

```bash
cd kizo-food && git pull origin main
cd .. && git add kizo-food && git commit -m "chore: update kizo-food submodule"
```

### Working on this sector independently

You can clone and run this repo on its own — no monorepo required:

```bash
git clone https://github.com/getkizo/kizo-food.git
```

Each module and adapter is independently runnable. See the README inside each directory for setup instructions.

### Contributing

**Modules and packages** (under `modules/`, `packages/`) follow the Kizo platform conventions:

- Modules communicate exclusively through the event bus — no direct imports between modules.
- Each module exposes named events; see `packages/shared` for the event catalogue.
- PRs should include tests and must not introduce direct inter-module dependencies.

**Adapters** (under `adapters/`) are treated as independent open-source projects:

- Each adapter has its own `README.md`, `CHANGELOG.md`, and `LICENSE`.
- Adapters may have their own build system (Gradle, npm, etc.) separate from the sector's package manager.
- Contributions to an adapter follow that adapter's own contribution guidelines.
- Adapters implement an open protocol (WebSocket, REST, or event bus bridge) — they must not import from sector modules directly.

### Branching

| Branch | Purpose |
|---|---|
| `main` | Stable, deployable |
| `feat/*` | Feature branches — PRs target `main` |
| `fix/*` | Bug fix branches |

---

## License

Each adapter carries its own license (see `adapters/<name>/LICENSE`). All other code in this repo is proprietary — © Kizo. All rights reserved.
