# Quick Start Checklist (Windows Developer)

Follow these steps to get the Merchant Appliance v2 running on your Windows machine in under 5 minutes.

## ✅ Pre-Flight Checklist

### 1. Install Bun Runtime

```powershell
# Run in PowerShell (as Administrator recommended)
irm bun.sh/install.ps1 | iex

# Verify installation
bun --version
```

Expected output: `1.0.0` or higher

### 2. Navigate to v2 Directory

```bash
cd YOUR_PATH\kizo-food\apps\merchant
```

### 3. Install Dependencies

```bash
bun install
```

Expected output:
```
+ hono@4.x.x
+ sam-pattern@1.5.10
+ sam-fsm@0.9.24
+ @noble/ed25519@2.0.0
```

### 4. Configure Environment

```bash
# Copy example file
cp .env.example .env
```

**Edit `.env` and update these TWO critical values:**

```env
MASTER_KEY_PASSPHRASE=YourSecurePassphrase2026!
JWT_SECRET=abcdef1234567890abcdef1234567890abcdef1234567890
```

> **Note:** Both must be changed from defaults! JWT_SECRET needs 32+ characters.

### 5. Initialize Database

```bash
bun run db:migrate
```

Expected output:
```
✅ Database initialized: ./data/merchant.db
✅ Created tables: merchants, users, refresh_tokens, api_keys, orders, menu_items, sam_state
```

### 6. (Optional) Seed Test Data

```bash
bun run db:seed
```

This creates:
- Test merchant: `joes-pizza`
- Test user: `owner@joespizza.com` / `password123`
- Sample menu items

### 7. Start Development Server

```bash
bun run dev
```

Expected output:
```
🚀 Server running at http://127.0.0.1:3000
📊 Environment: development
🗄️  Database: ./data/merchant.db
```

## 🧪 Verify It's Working

### Test 1: Health Check

Open browser or run:
```bash
curl http://localhost:3000/health
```

Expected: `{"status":"ok"}`

### Test 2: Register a Test Account

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Test Pizza\",\"slug\":\"test-pizza\",\"email\":\"test@example.com\",\"password\":\"password123\",\"fullName\":\"Test User\"}"
```

Expected: JSON with `accessToken` and `refreshToken`

### Test 3: Login

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"test@example.com\",\"password\":\"password123\"}"
```

Expected: JSON with `accessToken` and `refreshToken`

### Test 4: Access Protected Route

```bash
# Replace <TOKEN> with accessToken from login response
curl http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer <TOKEN>"
```

Expected: JSON with user details

## 🎉 Success!

If all tests pass, you're ready to develop!

## 📚 Next Steps

1. **Read Full Documentation**: [DEVELOPER-SETUP.md](./DEVELOPER-SETUP.md)
2. **Explore API Endpoints**: See [DEVELOPER-SETUP.md#api-usage-examples](./DEVELOPER-SETUP.md#api-usage-examples)
3. **Set up Clover Integration**: [CLOVER-SETUP.md](./CLOVER-SETUP.md)
4. **Run Tests**: `bun test`

## 🚨 Troubleshooting

### "Bun not found"
- Restart terminal/PowerShell after installing Bun
- Or add manually to PATH: `C:\Users\<YourUsername>\.bun\bin`

### "Port 3000 already in use"
- Change port in `.env`: `PORT=3001`
- Or kill process: `Get-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess | Stop-Process`

### "JWT_SECRET is required"
- Make sure you edited `.env` and set `JWT_SECRET` to 32+ characters

### "Cannot find module bun:sqlite"
- Use `bun run dev`, NOT `node src/server.ts`

## 📞 Get Help

- Full setup guide: [DEVELOPER-SETUP.md](./DEVELOPER-SETUP.md)
- Architecture docs: [../docs/architecture/](../docs/architecture/)
- Report issues: GitHub Issues

---

**Total Setup Time: ~5 minutes** ⏱️
