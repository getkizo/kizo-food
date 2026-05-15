# Mock OAuth for Development

**Quick way to test social login without configuring Google/Apple/Facebook OAuth!**

## Enable Mock OAuth

Add this to your `.env` file:

```bash
MOCK_OAUTH=true
```

Restart the server:
```bash
bun run dev
```

That's it! All three social login buttons (Google, Apple, Facebook) now work with fake data.

## What You'll See

1. **Yellow banner** says "Mock OAuth Mode"
2. **All social login buttons are enabled**
3. Click any button (Google, Apple, or Facebook)
4. You'll see a **mock login page** showing the test user
5. Click "Continue with Mock [Provider]"
6. Complete the onboarding flow normally

## Test Users

Each provider has a preset test user:

| Provider | Email | Name |
|----------|-------|------|
| Google | `test@gmail.com` | Test User (Google) |
| Apple | `test@icloud.com` | Test User (Apple) |
| Facebook | `test@facebook.com` | Test User (Facebook) |

## What Works

✅ **Full onboarding flow** — All steps work normally
✅ **Business setup** — Enter your restaurant details
✅ **Clover integration** — Test POS configuration
✅ **Account creation** — Creates real accounts in your database
✅ **Login** — Users created via mock OAuth can log in

## What's Different

- No real OAuth providers involved
- Shows a mock login page instead of redirecting to Google/Apple/Facebook
- Uses preset test data for user info
- Clear "DEVELOPMENT MODE" badge on mock login page

## Turn Off Mock OAuth

When you're ready to use real OAuth:

1. Set `MOCK_OAUTH=false` in `.env` (or remove the line)
2. Configure real OAuth credentials (see [docs/OAUTH-SETUP.md](./docs/OAUTH-SETUP.md))
3. Restart the server

## Use Cases

**Perfect for:**
- 🚀 Quick development without OAuth setup
- 🧪 Testing the complete onboarding flow
- 👥 Creating multiple test accounts easily
- 🎨 Frontend UI development

**Not suitable for:**
- ❌ Production use
- ❌ Testing real OAuth provider integration
- ❌ Security testing

## Example Flow

```bash
# 1. Enable mock OAuth
echo "MOCK_OAUTH=true" >> .env

# 2. Start server
bun run dev

# 3. Visit http://localhost:3000
# 4. Click "Continue with Google"
# 5. See mock login page
# 6. Click "Continue with Mock Google"
# 7. Enter business info
# 8. Complete setup!
```

## Screenshots

### Mock Login Page
Shows:
- Provider name (Google/Apple/Facebook)
- "DEVELOPMENT MODE" badge
- Test user email and name
- Button to continue

### Banner Message
Yellow banner at top of onboarding:
> **Mock OAuth Mode**
> Social login buttons use fake OAuth for testing. Set `MOCK_OAUTH=false` in .env to disable.

## How It Works

1. **Backend** checks `process.env.MOCK_OAUTH === 'true'`
2. If true, routes `/api/auth/oauth/*` go to mock handlers
3. Mock handlers return preset test data
4. Frontend treats it like real OAuth
5. Database stores accounts normally

## Troubleshooting

### Mock mode not working
- Check `.env` has `MOCK_OAUTH=true` exactly
- Restart the server after changing `.env`
- Clear browser cache

### Still seeing disabled buttons
- Make sure you restarted the server
- Check browser console for errors
- Visit `/api/auth/oauth/config` — should show `mockMode: true`

### Want to test email signup instead
- Email signup always works, regardless of mock OAuth setting
- Just click "Sign up with Email" instead

## Next Steps

Once you've tested with mock OAuth and want to go live:

1. **Disable mock OAuth**: Set `MOCK_OAUTH=false`
2. **Configure real OAuth**: See [docs/OAUTH-SETUP.md](./docs/OAUTH-SETUP.md)
3. **Test with real providers**: Click buttons → redirects to actual Google/Apple/Facebook
4. **Deploy**: Mock OAuth is automatically disabled in production (`NODE_ENV=production`)

## Notes

- Mock OAuth is only for development
- Each provider creates a different user (different provider IDs)
- You can create accounts with all three providers and they'll be separate users
- Mock data is hardcoded but you can customize it in `src/routes/oauth-mock.ts`

Happy developing! 🎉
