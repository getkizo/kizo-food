# OAuth Social Login Setup Guide

This guide explains how to configure social login (Google, Apple ID, Facebook) for the Merchant onboarding flow.

## Overview

The merchant onboarding UI now supports:
- **Google** - Sign in with Google
- **Apple ID** - Sign in with Apple
- **Facebook** - Continue with Facebook
- **Email/Password** - Traditional registration (fallback)

## Quick Start

1. **Run the database migration** to add OAuth support:
   ```bash
   cd v2
   bun run src/db/run-migration.ts 001_add_oauth_support.sql
   ```

2. **Configure OAuth credentials** in `.env` file (see sections below)

3. **Start the server**:
   ```bash
   bun run dev
   ```

4. **Visit** http://localhost:3000 to see the onboarding UI

## Google OAuth Setup

### 1. Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Navigate to "APIs & Services" > "Credentials"

### 2. Configure OAuth Consent Screen

1. Go to "OAuth consent screen"
2. Choose "External" user type
3. Fill in required fields:
   - App name: "Kizo Register"
   - User support email: your email
   - Developer contact: your email
4. Add scopes:
   - `openid`
   - `email`
   - `profile`

### 3. Create OAuth 2.0 Client ID

1. Go to "Credentials" > "Create Credentials" > "OAuth client ID"
2. Application type: "Web application"
3. Authorized redirect URIs:
   - Development: `http://localhost:3000/api/auth/oauth/google/callback`
   - Production: `https://yourdomain.com/api/auth/oauth/google/callback`
4. Copy Client ID and Client Secret

### 4. Update .env

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/oauth/google/callback
```

## Apple OAuth Setup

### 1. Apple Developer Account

1. Go to [Apple Developer Portal](https://developer.apple.com/)
2. Navigate to "Certificates, Identifiers & Profiles"

### 2. Create App ID

1. Go to "Identifiers" > Click "+"
2. Select "App IDs" > Continue
3. Select "App" > Continue
4. Description: "Kizo Register"
5. Bundle ID: `com.kizo.merchant`
6. Enable "Sign in with Apple"
7. Register

### 3. Create Service ID

1. Go to "Identifiers" > Click "+"
2. Select "Services IDs" > Continue
3. Description: "Kizo Register Web"
4. Identifier: `com.kizo.merchant.service`
5. Enable "Sign in with Apple"
6. Configure:
   - Domains: `yourdomain.com` (or `localhost` for dev)
   - Return URLs: `http://localhost:3000/api/auth/oauth/apple/callback`
7. Save

### 4. Create Key

1. Go to "Keys" > Click "+"
2. Key Name: "Kizo Sign in with Apple"
3. Enable "Sign in with Apple"
4. Configure > Select your App ID
5. Download the key file (`.p8`)
6. Note the Key ID

### 5. Generate Client Secret

Apple requires a JWT as the client secret. You'll need to generate this using your Key ID, Team ID, and the `.p8` key file.

Example script (Node.js):
```javascript
const jwt = require('jsonwebtoken')
const fs = require('fs')

const privateKey = fs.readFileSync('path/to/AuthKey_KEYID.p8')

const clientSecret = jwt.sign(
  {
    iss: 'YOUR_TEAM_ID',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400 * 180, // 6 months
    aud: 'https://appleid.apple.com',
    sub: 'com.kizo.merchant.service',
  },
  privateKey,
  {
    algorithm: 'ES256',
    header: {
      alg: 'ES256',
      kid: 'YOUR_KEY_ID',
    },
  }
)

console.log(clientSecret)
```

### 6. Update .env

```bash
APPLE_CLIENT_ID=com.kizo.merchant.service
APPLE_CLIENT_SECRET=eyJhbGc... # Generated JWT
APPLE_REDIRECT_URI=http://localhost:3000/api/auth/oauth/apple/callback
```

## Facebook OAuth Setup

### 1. Create Facebook App

1. Go to [Facebook Developers](https://developers.facebook.com/)
2. Click "My Apps" > "Create App"
3. Choose "Consumer" use case
4. App Display Name: "Kizo Register"
5. Create App ID

### 2. Configure Facebook Login

1. In the app dashboard, add "Facebook Login" product
2. Choose "Web" platform
3. Site URL: `http://localhost:3000`
4. Settings > Basic:
   - Add App Domains: `localhost`
5. Facebook Login > Settings:
   - Valid OAuth Redirect URIs: `http://localhost:3000/api/auth/oauth/facebook/callback`

### 3. Get App Credentials

1. Settings > Basic
2. Copy App ID and App Secret

### 4. Update .env

```bash
FACEBOOK_APP_ID=your-app-id
FACEBOOK_APP_SECRET=your-app-secret
FACEBOOK_REDIRECT_URI=http://localhost:3000/api/auth/oauth/facebook/callback
```

## Database Schema Changes

The migration adds the following:

### oauth_accounts table
Stores OAuth provider linkages for users:
```sql
- id: Primary key
- user_id: Link to users table
- provider: 'google', 'apple', 'facebook'
- provider_user_id: Provider's unique user ID
- email: Email from provider
- profile_data: JSON (name, picture, etc.)
- access_token: OAuth access token
- refresh_token: OAuth refresh token
- expires_at: Token expiration
```

### users table additions
- `oauth_provider`: Provider name or NULL
- `oauth_provider_id`: Provider's user ID or NULL

## Testing

### Local Development

1. Configure OAuth apps with localhost redirect URIs
2. Update `.env` with development credentials
3. Run: `bun run dev`
4. Visit: http://localhost:3000

### Production

1. Update OAuth apps with production redirect URIs
2. Use environment variables (not `.env` file) for secrets
3. Enable HTTPS
4. Update CORS_ORIGIN in `.env`

## Security Considerations

1. **Never commit OAuth secrets** to version control
2. **Use HTTPS in production** - OAuth providers require it
3. **Validate redirect URIs** to prevent open redirects
4. **Store tokens securely** - Consider encrypting OAuth tokens at rest
5. **Implement CSRF protection** - Use state parameter in OAuth flows
6. **Rate limit** OAuth endpoints to prevent abuse

## Troubleshooting

### "redirect_uri_mismatch" error
- Ensure the redirect URI in your code matches exactly what's configured in the OAuth provider dashboard
- Check for trailing slashes, http vs https, localhost vs 127.0.0.1

### "invalid_client" error
- Verify Client ID and Secret are correct
- For Apple: Ensure the client secret JWT hasn't expired

### "access_denied" error
- User cancelled the OAuth flow
- App not approved for certain scopes

### OAuth callback doesn't work
- Check that the OAuth route is mounted in server.ts
- Verify the endpoint is receiving the callback (check logs)
- Ensure CORS is configured correctly

## Email/Password Fallback

Users can still register with email/password if they prefer:
1. Click "Sign up with Email" on the onboarding page
2. Enter business details
3. A password field will be added (TODO: implement password collection UI)

## Next Steps

After implementing OAuth, consider:
1. **Account Linking** - Allow users to link multiple OAuth providers to one account
2. **Profile Sync** - Auto-update user profile from OAuth provider
3. **Refresh Tokens** - Implement token refresh flow
4. **Account Recovery** - OAuth users can't reset password, provide alternative recovery
5. **Testing** - Add OAuth flow tests

## Additional Resources

- [Google OAuth 2.0 Docs](https://developers.google.com/identity/protocols/oauth2)
- [Apple Sign In Docs](https://developer.apple.com/sign-in-with-apple/)
- [Facebook Login Docs](https://developers.facebook.com/docs/facebook-login/)
