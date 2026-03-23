# Development Guide

Quick guide to getting started with the Merchant Onboarding UI in development mode.

## Quick Start - Mock OAuth (Recommended)

**Test social login instantly without configuring real OAuth!**

```bash
cd v2
bun install
bun run db:migrate

# Enable mock OAuth
echo "MOCK_OAUTH=true" >> .env

bun run dev
```

Visit http://localhost:3000 and **all three social login buttons work** with fake data!

See [MOCK-OAUTH.md](./MOCK-OAUTH.md) for details.

## Quick Start (Email Only - No OAuth)

You can also develop using just email signup:

```bash
cd v2
bun install
bun run db:migrate
bun run dev
```

Visit http://localhost:3000 and use **Email Signup** to create an account.

## What You'll See

When OAuth providers aren't configured, you'll see:

1. **Yellow banner** at the top explaining development mode
2. **Disabled social login buttons** (grayed out with tooltips)
3. **"Sign up with Email"** — fully functional

This lets you develop and test the onboarding flow without OAuth setup.

## Social Login (Optional)

To enable social login buttons, configure OAuth providers in your `.env` file:

### Google OAuth (Quickest to Set Up)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project → APIs & Services → Credentials
3. Create OAuth 2.0 Client ID (Web application)
4. Add redirect URI: `http://localhost:3000/api/auth/oauth/google/callback`
5. Copy Client ID and Secret to `.env`:

```bash
GOOGLE_CLIENT_ID=your-actual-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-actual-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/oauth/google/callback
```

Restart the server and the Google button will be enabled.

See [docs/OAUTH-SETUP.md](./docs/OAUTH-SETUP.md) for full OAuth setup instructions.

## Environment Variables

Required:
```bash
JWT_SECRET=your-jwt-secret-min-32-characters-long
```

Optional (for API key encryption):
```bash
MASTER_KEY_PASSPHRASE=your-secure-passphrase
```

Optional (for OAuth):
```bash
# See .env.example for all OAuth variables
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
# etc.
```

## Email Signup Flow

The email signup path works out of the box:

1. Click "Sign up with Email"
2. Enter: Full Name, Email, Password (min 8 chars)
3. Enter business info and slug
4. Choose POS integration (Manual or Clover)
5. Complete setup

## Testing Without a Real Database

The app uses SQLite (file-based), so no external database needed. Data is stored in:

```
v2/data/merchant.db
```

To reset: `rm data/merchant.db && bun run db:migrate`

## Common Development Tasks

### Run migrations
```bash
bun run db:migrate
```

### Seed test data
```bash
bun run db:seed
```

### Run tests
```bash
bun test
```

### Check which OAuth providers are enabled
Visit: http://localhost:3000/api/auth/oauth/config

Returns:
```json
{
  "google": false,
  "apple": false,
  "facebook": false
}
```

## UI Development Tips

### Design Tokens
All colors, spacing, and radii are defined as CSS custom properties in `public/css/styles.css`:

```css
--color-primary: #6c63ff
--spacing-lg: 1rem
--radius-medium: 8px
```

### Component Structure
- `public/index.html` - All UI markup
- `public/css/styles.css` - Styles using design tokens
- `public/js/app.js` - Frontend logic (vanilla JS)

### Accessibility Features
- All forms have proper labels and ARIA attributes
- Keyboard navigation works throughout
- Screen reader announcements via `aria-live`
- Focus management between steps

### Testing Different States

**Test OAuth disabled state:**
- Don't set OAuth env vars
- Yellow banner should appear
- Buttons should be disabled

**Test OAuth enabled state:**
- Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
- Restart server
- Google button should be enabled
- Banner should disappear if all providers are configured

**Test slug availability:**
- Type a slug in the business form
- Real-time "Available" or "Already taken" feedback
- Debounced API calls (400ms delay)

## Browser DevTools

Open DevTools Console to see:
- OAuth config check on page load
- API responses
- Any errors

## Troubleshooting

### Social login buttons stay disabled
- Check `.env` has actual OAuth credentials (not placeholder values)
- Restart the server after changing `.env`
- Check browser console for errors
- Visit `/api/auth/oauth/config` to verify

### "Access blocked: Authorization Error"
- This means you clicked a social login button without OAuth configured
- Now handled gracefully with error toast
- Use email signup instead

### Slug shows "Already taken"
- Someone already used that slug
- Try a different one or reset the database

### TypeScript errors
- This is a vanilla JS project (no TypeScript in the frontend)
- Backend is TypeScript, but uses Bun's built-in type checking

## Next Steps

Once basic onboarding works:

1. Configure OAuth providers (optional, see docs/OAUTH-SETUP.md)
2. Build the merchant dashboard
3. Add menu management UI
4. Implement order tracking interface
5. Add real Clover integration testing

## Need Help?

- **OAuth Setup**: See [docs/OAUTH-SETUP.md](./docs/OAUTH-SETUP.md)
- **Architecture**: See [docs/architecture/appliance-architecture.md](./docs/architecture/appliance-architecture.md)
- **UI Components**: See [.claude/CLAUDE.md](./.claude/CLAUDE.md) for design tokens

Happy coding! 🚀
