# Mock OAuth — Development Mode

Fast-track social login testing without configuring real OAuth providers.

## What It Does

When `MOCK_OAUTH=true` is set in `.env`, all three social login buttons (Google, Apple, Facebook) are enabled and return fake user data instantly — no OAuth app registration required.

Each click on a social login button calls a mock OAuth endpoint that creates (or reuses) a local test account and issues real JWT tokens. The rest of the application behaves identically to production.

## Setup

```bash
# 1. Add to your .env
echo "MOCK_OAUTH=true" >> .env

# 2. Start the server
bun run dev
```

Visit `http://localhost:3000` — all three social login buttons work.

## Mock Users

Each provider returns a fixed fake identity:

| Button | Email | Name |
|---|---|---|
| Google | `mock-google@example.com` | Mock Google User |
| Apple | `mock-apple@example.com` | Mock Apple User |
| Facebook | `mock-facebook@example.com` | Mock Facebook User |

If a user with that email already exists in the database, the mock endpoint logs them in. Otherwise it registers a new account. This means you can test both first-time signup and returning login flows.

## How It Works

In mock mode the server registers additional routes:

```
GET  /api/auth/oauth/mock/:provider          # Initiates mock OAuth (instant redirect)
GET  /api/auth/oauth/mock/:provider/callback # Issues tokens for the fake identity
```

The real OAuth routes (`/api/auth/oauth/google`, etc.) are still registered alongside the mock routes, so toggling `MOCK_OAUTH` on and off does not break any client-side code.

## Security

`MOCK_OAUTH=true` is **silently ignored in `NODE_ENV=production`**. The mock endpoints are never registered in production builds. Do not rely on this for access control — just don't set `MOCK_OAUTH=true` in production `.env` files.

## Disabling Mock OAuth

Remove or comment out `MOCK_OAUTH` from `.env` and restart:

```bash
# Remove the line
sed -i '/^MOCK_OAUTH/d' .env
bun run dev
```

Social login buttons will show as disabled (greyed out with a tooltip) until real OAuth credentials are configured. Email signup continues to work with no changes.

## Configuring Real OAuth

See [docs/OAUTH-SETUP.md](./docs/OAUTH-SETUP.md) for step-by-step instructions for Google, Apple, and Facebook.
