# Developer Setup Guide (Windows)

Complete guide to set up and run the Merchant Appliance v2 on Windows for development and testing.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Initial Setup](#initial-setup)
- [Database Setup](#database-setup)
- [Authentication Setup](#authentication-setup)
- [POS Integration Setup](#pos-integration-setup)
- [Printer Setup](#printer-setup)
- [Store PWA Development](#store-pwa-development)
- [Running the Application](#running-the-application)
- [Testing](#testing)
- [API Usage Examples](#api-usage-examples)
- [Troubleshooting](#troubleshooting)

## Prerequisites

### Required Software

1. **Bun Runtime** (v1.0.0 or higher)
   ```bash
   # Install Bun on Windows using PowerShell
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

2. **Git** (for version control)
   - Download from https://git-scm.com/download/win
   - Or install via `winget install Git.Git`

3. **Google Chrome** (required for HTML receipt rendering)
   - Download from https://www.google.com/chrome and install normally
   - The appliance auto-detects Chrome at its standard Windows path
   - Alternatively, set `CHROME_EXECUTABLE_PATH` in `.env` to a custom path

4. **Text Editor/IDE**
   - VS Code (recommended): https://code.visualstudio.com/
   - Or any editor with TypeScript support

### Optional Tools

- **Postman** or **Insomnia** for API testing
- **SQLite Browser** for database inspection: https://sqlitebrowser.org/

## Initial Setup

### 1. Clone the Repository

```bash
git clone https://github.com/kizo/merchant.git
cd merchant/v2
```

### 2. Install Dependencies

```bash
bun install
```

This installs:
- `hono` - Lightweight web framework (14KB)
- `sam-pattern` + `sam-fsm` - State management
- `@noble/ed25519` - Cryptographic signatures
- `puppeteer-core` - Headless Chrome bridge (uses your system Chrome, no download)
- `sharp` - Image processing (raster conversion for thermal printers)
- `receiptline` - Thermal printer markup renderer

### 3. Environment Configuration

```bash
# Copy the example environment file
cp .env.example .env
```

Edit `.env` and configure the following:

```env
# Server Configuration
NODE_ENV=development
PORT=3000
HOSTNAME=127.0.0.1

# Security - IMPORTANT: Change these!
MASTER_KEY_PASSPHRASE=your-secure-passphrase-here-min-16-chars
JWT_SECRET=your-jwt-secret-min-32-characters-long-random-string-change-me

# Database
DATABASE_PATH=./data/merchant.db

# CORS (for local frontend development)
CORS_ORIGIN=http://localhost:5173

# Cloudflare Tunnel (leave commented for local dev)
# CLOUDFLARE_TUNNEL_NAME=merchant-cluster-001
```

**Security Notes:**
- `MASTER_KEY_PASSPHRASE`: Used to derive encryption keys for API credentials. Must be at least 8 characters (12+ recommended).
- `JWT_SECRET`: Used to sign authentication tokens. Must be at least 32 characters.
- **Never commit `.env` to version control!**
- In development mode, a mock hardware UUID is used (based on your computer name). This is insecure and only for local testing.

**Quick Secret Generation:**

```bash
# Generate a random JWT secret (PowerShell)
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})

# Or use Bun
bun run -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Database Setup

### 1. Create Database Directory

```bash
# Create data directory if it doesn't exist
mkdir data
```

### 2. Run Migrations

```bash
bun run db:migrate
```

This creates the SQLite database with the following tables:
- `merchants` - Merchant profiles
- `users` - User accounts (owner, manager, staff)
- `refresh_tokens` - JWT refresh tokens
- `api_keys` - Encrypted POS/payment API credentials
- `orders` - Order records
- `menu_items` - Menu catalog
- `sam_state` - SAM pattern workflow state

### 3. (Optional) Seed Development Data

```bash
bun run db:seed
```

This creates:
- A test merchant: "Joe's Pizza" (slug: `joes-pizza`)
- An owner account: `owner@joespizza.com` / `password123`
- Sample menu items
- Sample orders

## Authentication Setup

The system uses JWT-based authentication with access tokens and refresh tokens.

### Authentication Flow

1. **Register** - Create a new merchant and owner account
2. **Login** - Obtain access token (15 min) + refresh token (7 days)
3. **Use API** - Include access token in `Authorization: Bearer <token>` header
4. **Refresh** - Exchange refresh token for new access token when expired
5. **Logout** - Revoke refresh tokens

### User Roles

- **Owner** - Full access (destructive operations, API key management)
- **Manager** - Can update merchant profile, manage menu, process orders
- **Staff** - Read-only access to orders and menu

## POS Integration Setup

The appliance supports multiple POS systems via adapters.

### Supported POS Systems

1. **Manual** (no POS) - Default for development
2. **Generic Webhook** - HTTP POST to any endpoint
3. **Square** - Square POS API integration
4. **Toast** - Toast POS API integration
5. **Clover** - Clover POS API integration

### Configure Clover Integration (Example)

If you have a Clover sandbox account:

1. **Obtain API Credentials**
   - Log in to Clover Developer Dashboard: https://sandbox.dev.clover.com/
   - Create a new app or use existing
   - Get your API token and merchant ID

2. **Store API Key** (after login)

   ```bash
   POST /api/merchants/:merchantId/keys
   Authorization: Bearer <access_token>
   Content-Type: application/json

   {
     "provider": "clover",
     "apiKey": "your-clover-api-token",
     "metadata": {
       "merchantId": "your-clover-merchant-id",
       "environment": "sandbox"
     }
   }
   ```

3. **Sync Merchant Profile from Clover**

   ```bash
   POST /api/merchants/:merchantId/sync-clover
   Authorization: Bearer <access_token>
   ```

   This fetches merchant details from Clover and updates the local profile.

See [CLOVER-SETUP.md](./CLOVER-SETUP.md) for detailed Clover integration instructions.

## Printer Setup

The appliance supports thermal receipt printers over TCP (raw port 9100) and HTTP
(Star WebPRNT).  No drivers are required — printing is pure TCP/IP.

### Protocol Selection

Choose the protocol in the dashboard under **Store Profile → Printer Settings**:

| Protocol key | Use with | Notes |
|---|---|---|
| `star-line` | Star TSP700 II | Star Line Mode commands (factory default) |
| `star-line-tsp100` | Star TSP100 III | Star Line variant; alignment uses `ESC a n` |
| `star-graphic` | Star TSP143 III | Raster bitmap — only working mode for this model |
| `webprnt` | Star TSP100 III (WebPRNT) | HTTP POST to port 80; see enablement note below |
| `generic-escpos` | Most non-Star printers | Standard ESC/POS; use as a fallback |

### Connecting a Printer

1. Connect the printer to the same LAN as the appliance.
2. Find the printer's IP address (print a self-test page: hold FEED while powering on).
3. In the dashboard, enter the IP under **Printer Settings** and save.
4. Click **Print Test Page** to verify connectivity.

### Enabling WebPRNT on the TSP100 III

WebPRNT is **not enabled by default**.  Enable it via the printer's web UI:

1. Open `http://<printer-ip>/` in a browser (default login: `root` / `public`).
2. Navigate to **WebPRNT** → check **Enable**.
3. Save and restart the printer.

If WebPRNT is not enabled the appliance automatically falls back to Star Graphic
raster mode (same quality, slower).

### Ticket Style

| Style key | Requires | Output |
|---|---|---|
| `classic` | Any protocol | Monospace text — works everywhere |
| `html` | `star-graphic` or `webprnt` + Chrome/Chromium | Proportional fonts, logo, gratuity table |

Set **Ticket Style** in the dashboard.  The HTML style requires a Chrome/Chromium
binary — see [Troubleshooting: "No system Chrome found"](#issue-no-system-chrome-found-when-printing-html-receipts).

### Printing a Test Page (CLI)

```bash
# Requires bun and a running server with a configured merchant
curl -X POST http://localhost:3000/api/merchants/<merchantId>/printers/test \
  -H "Authorization: Bearer <access_token>"
```

### Dev Scripts

Standalone receipt preview scripts live in `scripts/receipt-dev/` (not shipped
with the production appliance):

| Script | Purpose |
|---|---|
| `example-usage.js` | Generates sample raster buffers and writes PNG previews |
| `receipt-comparison.jsx` | React component for side-by-side ticket comparison |
| `hanuman-receipts.jsx` | Hanuman Thai Café real-data receipt preview |
| `hanuman-receipt-renderer.js` | Node renderer for `hanuman-receipts.jsx` |
| `convert-logo.py` | Converts a PNG logo to base64 `.txt` for `src/assets/printers/` |

Run with:
```bash
cd scripts/receipt-dev
bun run example-usage.js
```

---

## Store PWA Development

The customer-facing online store is a Progressive Web App (PWA) served directly
from the appliance.  There is no separate build step — HTML/CSS/JS are static
files in `v2/public/store/`.

### Architecture Overview

```
v2/public/store/
  index.html          ← customer entry point
  css/store.css
  js/store.js         ← SAM state machine (LOADING → BROWSING → CHECKOUT → …)
  js/store-menu.js    ← menu rendering, hours filtering
  js/store-cart.js    ← cart logic
  js/store-checkout.js← checkout form + payment flow
  js/store-push.js    ← Web Push subscription
  sw.js               ← Service Worker (offline cache)
  manifest.json       ← PWA manifest
```

URL layout (all on the same hostname):

| Path | Served by |
|---|---|
| `/` | Customer store (PWA) |
| `/merchant` | Staff dashboard |
| `/setup` | Initial onboarding |
| `/pay-return` | Converge payment return redirect |
| `/api/*` | REST API |

### Running the Store Locally

```bash
# Start the appliance
cd v2
bun run dev
```

Open `http://localhost:3000/` in a browser — this is the customer store.
Open `http://localhost:3000/merchant` for the staff dashboard.

The store resolves the merchant via `getApplianceMerchant()` (first active
merchant in the DB).  Run migrations and seed at least one merchant first:

```bash
bun run db:migrate
# then register via POST /api/auth/register or the /setup onboarding flow
```

### Payment Provider Setup (local dev)

Customer orders use Converge (Elavon) or Finix for card capture.

**To bypass payment in development:**

1. Register a merchant via `/setup`.
2. Place a test order at `/`.
3. At the payment step, the store POSTs to `/api/store/orders` and then
   redirects to the provider's hosted page.
4. For local dev without real credentials, set the merchant's `payment_provider`
   to `none` in the DB directly:

   ```sql
   UPDATE merchants SET payment_provider = 'none' WHERE id = '<merchantId>';
   ```

   Orders will be accepted immediately without a payment redirect.

**Converge sandbox:**

1. Apply for a Converge sandbox account at https://developer.elavon.com/.
2. Add your sandbox credentials via the dashboard (**Store Profile → Payment Settings**).
3. The `/pay-return` route handles the redirect back after payment.

**Finix sandbox:**

1. Create a sandbox account at https://finix.com/.
2. Add `FINIX_USERNAME` and `FINIX_PASSWORD` to `.env` (or store via the API key endpoint).
3. The store uses `/api/store/orders/pay` to create a Finix payment form.

### Customer Push Notifications (local dev)

Push requires HTTPS in production.  For local dev, push is silently skipped
(the subscription endpoint returns a 200 but notifications are not sent).

To test push end-to-end, use a tool like [ngrok](https://ngrok.com/) to expose
the local server over HTTPS:

```bash
ngrok http 3000
# use the ngrok HTTPS URL as your dev base
```

Then install the store as a PWA (Add to Home Screen) on a real iOS/Android device.

### Service Worker Cache Busting

The SW caches store assets aggressively.  During development, disable the SW:

1. Open DevTools → Application → Service Workers.
2. Check **Bypass for network**.

Or hard-reload with `Ctrl+Shift+R` (Windows/Linux) / `Cmd+Shift+R` (macOS).

---

## Running the Application

### Development Mode (with hot reload)

```bash
bun run dev
```

Server starts at `http://localhost:3000`

You should see:
```
🚀 Server running at http://127.0.0.1:3000
📊 Environment: development
🗄️  Database: ./data/merchant.db
```

### Production Mode

```bash
# Build first
bun run build

# Then start
bun run start
```

## Testing

### Run All Tests

```bash
bun test
```

### Run Specific Test File

```bash
bun test test/auth.test.ts
bun test test/clover-adapter.test.ts
```

### Watch Mode (re-runs on file changes)

```bash
bun run test:watch
```

### Test Coverage

The test suite covers:
- ✅ JWT utilities (sign, verify, expiration)
- ✅ Authentication flows (register, login, refresh, logout)
- ✅ Protected routes and authorization
- ✅ Merchant management (CRUD, Clover sync)
- ✅ POS adapters (Clover, Square, Toast, Manual)
- ✅ Order relay workflows (SAM pattern)

## API Usage Examples

### 1. Register a New Merchant

**Request:**
```bash
POST http://localhost:3000/api/auth/register
Content-Type: application/json

{
  "businessName": "Joe's Pizza",
  "slug": "joes-pizza",
  "email": "owner@joespizza.com",
  "password": "securePassword123!",
  "fullName": "Joe Smith"
}
```

**Response:**
```json
{
  "user": {
    "id": "u_abc123",
    "merchantId": "m_xyz789",
    "email": "owner@joespizza.com",
    "fullName": "Joe Smith",
    "role": "owner"
  },
  "merchant": {
    "id": "m_xyz789",
    "businessName": "Joe's Pizza",
    "slug": "joes-pizza"
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### 2. Login

**Request:**
```bash
POST http://localhost:3000/api/auth/login
Content-Type: application/json

{
  "email": "owner@joespizza.com",
  "password": "securePassword123!"
}
```

**Response:**
```json
{
  "user": {
    "id": "u_abc123",
    "merchantId": "m_xyz789",
    "email": "owner@joespizza.com",
    "fullName": "Joe Smith",
    "role": "owner"
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### 3. Get Current User

**Request:**
```bash
GET http://localhost:3000/api/auth/me
Authorization: Bearer <access_token>
```

**Response:**
```json
{
  "id": "u_abc123",
  "merchantId": "m_xyz789",
  "email": "owner@joespizza.com",
  "fullName": "Joe Smith",
  "role": "owner",
  "isActive": true,
  "createdAt": "2026-02-16T10:30:00Z",
  "lastLoginAt": "2026-02-16T14:25:00Z"
}
```

### 4. Refresh Access Token

**Request:**
```bash
POST http://localhost:3000/api/auth/refresh
Content-Type: application/json

{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### 5. Get Merchant Profile

**Request:**
```bash
GET http://localhost:3000/api/merchants/m_xyz789
Authorization: Bearer <access_token>
```

**Response:**
```json
{
  "id": "m_xyz789",
  "businessName": "Joe's Pizza",
  "slug": "joes-pizza",
  "description": "Authentic New York style pizza",
  "phone": "+1-555-0123",
  "email": "contact@joespizza.com",
  "address": "123 Main St, New York, NY 10001",
  "timezone": "America/New_York",
  "currency": "USD",
  "status": "active",
  "createdAt": "2026-02-15T08:00:00Z",
  "updatedAt": "2026-02-16T10:30:00Z"
}
```

### 6. Update Merchant Profile

**Request:**
```bash
PUT http://localhost:3000/api/merchants/m_xyz789
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "businessName": "Joe's Authentic Pizza",
  "phone": "+1-555-0199",
  "description": "The best New York style pizza in town since 1985"
}
```

**Response:**
```json
{
  "id": "m_xyz789",
  "businessName": "Joe's Authentic Pizza",
  "slug": "joes-pizza",
  "description": "The best New York style pizza in town since 1985",
  "phone": "+1-555-0199",
  "updatedAt": "2026-02-16T14:45:00Z"
}
```

### 7. Store POS API Key (Clover Example)

**Request:**
```bash
POST http://localhost:3000/api/merchants/m_xyz789/keys
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "provider": "clover",
  "apiKey": "your-clover-api-token-here",
  "metadata": {
    "merchantId": "CLOVER_MERCHANT_ID",
    "environment": "sandbox"
  }
}
```

**Response:**
```json
{
  "success": true,
  "provider": "clover",
  "createdAt": "2026-02-16T15:00:00Z"
}
```

### 8. Sync Merchant Profile from Clover

**Request:**
```bash
POST http://localhost:3000/api/merchants/m_xyz789/sync-clover
Authorization: Bearer <access_token>
```

**Response:**
```json
{
  "success": true,
  "synced": {
    "businessName": "Joe's Pizza",
    "phone": "+1-555-0123",
    "email": "contact@joespizza.com"
  },
  "syncedAt": "2026-02-16T15:05:00Z"
}
```

### 9. Place an Order (Customer - No Auth Required)

**Request:**
```bash
POST http://localhost:3000/joes-pizza/orders
Content-Type: application/json

{
  "customerName": "John Doe",
  "customerPhone": "+1-555-9876",
  "customerEmail": "john@example.com",
  "items": [
    {
      "menuItemId": "item_123",
      "quantity": 2,
      "specialInstructions": "Extra cheese please"
    }
  ],
  "totalAmount": 3599,
  "paymentMethod": "card"
}
```

**Response:**
```json
{
  "orderId": "o_def456",
  "merchantSlug": "joes-pizza",
  "status": "pending",
  "totalAmount": 3599,
  "estimatedReadyTime": "2026-02-16T16:15:00Z",
  "createdAt": "2026-02-16T15:30:00Z"
}
```

### 10. Logout (Revoke Tokens)

**Request:**
```bash
POST http://localhost:3000/api/auth/logout
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response:**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

## Troubleshooting

### Issue: "No system Chrome found" when printing HTML receipts

**Cause:** The "Beautiful (HTML)" ticket style requires Google Chrome. The appliance uses `puppeteer-core` which does not bundle its own browser.

**Solution (Windows dev):** Install [Google Chrome](https://www.google.com/chrome) normally. It will be found automatically at `C:\Program Files\Google\Chrome\Application\chrome.exe`.

**Solution (non-standard path):** Set `CHROME_EXECUTABLE_PATH` in `.env`:
```env
CHROME_EXECUTABLE_PATH=C:\path\to\your\chrome.exe
```

**Solution (ARM appliance):**
```bash
sudo apt install -y chromium-browser
```
The appliance auto-detects `/usr/bin/chromium-browser` on Debian/Ubuntu/Raspberry Pi OS.

**Note:** This only affects the HTML ticket style. Classic (Monospace) receipts work without Chrome.

---

### Issue: "Cannot find module bun:sqlite"

**Solution:** Make sure you're running with Bun, not Node.js:
```bash
bun run dev  # ✅ Correct
node src/server.ts  # ❌ Won't work
```

### Issue: "JWT_SECRET is required"

**Solution:** Set `JWT_SECRET` in your `.env` file (min 32 characters):
```env
JWT_SECRET=your-random-32-character-secret-here-change-this
```

### Issue: "Database locked" error

**Solution:** Close any SQLite browser/tool that might have the database open, or delete `data/merchant.db` and re-run migrations.

### Issue: "Invalid token" on API requests

**Solution:**
1. Check token expiration (access tokens expire in 15 minutes)
2. Use the refresh endpoint to get a new access token
3. Ensure `Authorization: Bearer <token>` header is correctly formatted

### Issue: Port 3000 already in use

**Solution:** Change the port in `.env`:
```env
PORT=3001
```

Or kill the process using port 3000:
```bash
# PowerShell
Get-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess | Stop-Process

# Or use a different port
$env:PORT=3001; bun run dev
```

### Issue: CORS errors when calling from frontend

**Solution:** Update `CORS_ORIGIN` in `.env` to match your frontend URL:
```env
CORS_ORIGIN=http://localhost:5173
```

### Issue: Clover API returns 401 Unauthorized

**Solution:**
1. Verify your Clover API token is valid
2. Check you're using the correct environment (sandbox vs production)
3. Ensure the token has the necessary permissions in Clover Dashboard

## Next Steps

1. **Explore the API** - Import the API collection into Postman/Insomnia
2. **Read Architecture Docs** - See `../docs/architecture/` for system design
3. **Review ADRs** - Check `../docs/architecture/ADRs/` for architectural decisions
4. **Set up POS Integration** - See `CLOVER-SETUP.md` for Clover integration
5. **Build a Frontend** - Connect a React/Vue app to the REST API

## Additional Resources

- [Main README](./README.md) - Project overview and quick start
- [Architecture Documentation](../docs/architecture/README.md) - System design
- [Clover Setup Guide](./CLOVER-SETUP.md) - Clover POS integration
- [ADR-004: Bun + SQLite Appliance](../docs/architecture/ADRs/ADR-004-bun-sqlite-appliance.md)
- [ADR-005: Envelope Encryption](../docs/architecture/ADRs/ADR-005-envelope-encryption.md)
- [ADR-006: Ed25519 Code Signing](../docs/architecture/ADRs/ADR-006-ed25519-code-signing.md)

## Support

- **GitHub Issues**: Report bugs or request features
- **Email**: dev@kizo.app
- **Documentation**: `docs/architecture/`

---

**Happy Coding! 🚀**
