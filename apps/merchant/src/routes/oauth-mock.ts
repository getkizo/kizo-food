/**
 * Mock OAuth Routes for Development
 * Simulates OAuth flow without real providers
 */

import { Hono } from 'hono'

const mockOAuth = new Hono()

const MOCK_USERS = {
  google: {
    id: 'google_123456789',
    email: 'test@gmail.com',
    name: 'Test User (Google)',
    picture: 'https://via.placeholder.com/150',
  },
  apple: {
    id: 'apple_123456789',
    email: 'test@icloud.com',
    name: 'Test User (Apple)',
  },
  facebook: {
    id: 'facebook_123456789',
    email: 'test@facebook.com',
    name: 'Test User (Facebook)',
    picture: 'https://via.placeholder.com/150',
  },
}

/**
 * Mock OAuth Initiation
 * Shows a simple page to confirm mock login
 */
function createMockLoginPage(provider: 'google' | 'apple' | 'facebook') {
  const user = MOCK_USERS[provider]
  const displayName = provider.charAt(0).toUpperCase() + provider.slice(1)

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Mock ${displayName} Login</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          margin: 0;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        .card {
          background: white;
          border-radius: 12px;
          padding: 2rem;
          box-shadow: 0 10px 30px rgba(0,0,0,0.2);
          max-width: 400px;
          width: 90%;
          text-align: center;
        }
        h1 {
          margin: 0 0 0.5rem;
          font-size: 1.5rem;
          color: #1f2937;
        }
        .badge {
          display: inline-block;
          background: #fef3c7;
          color: #92400e;
          padding: 0.25rem 0.75rem;
          border-radius: 12px;
          font-size: 0.75rem;
          font-weight: 600;
          margin-bottom: 1.5rem;
        }
        .user-info {
          background: #f3f4f6;
          padding: 1rem;
          border-radius: 8px;
          margin-bottom: 1.5rem;
        }
        .user-info p {
          margin: 0.5rem 0;
          color: #4b5563;
        }
        .user-info strong {
          color: #1f2937;
        }
        .btn {
          display: inline-block;
          padding: 0.75rem 1.5rem;
          background: #6c63ff;
          color: white;
          text-decoration: none;
          border-radius: 6px;
          font-weight: 600;
          border: none;
          cursor: pointer;
          font-size: 1rem;
          width: 100%;
          transition: background 0.15s ease;
        }
        .btn:hover {
          background: #5850e6;
        }
        .help-text {
          margin-top: 1rem;
          font-size: 0.875rem;
          color: #6b7280;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Mock ${displayName} Login</h1>
        <div class="badge">DEVELOPMENT MODE</div>

        <div class="user-info">
          <p><strong>Email:</strong> ${user.email}</p>
          <p><strong>Name:</strong> ${user.name}</p>
          <p><strong>Provider:</strong> ${displayName}</p>
        </div>

        <form method="GET" action="/api/auth/oauth/${provider}/mock-callback">
          <button type="submit" class="btn">
            Continue with Mock ${displayName}
          </button>
        </form>

        <p class="help-text">
          This is a fake OAuth login for development.<br>
          Set <code>MOCK_OAUTH=false</code> to disable.
        </p>
      </div>
    </body>
    </html>
  `
}

/**
 * GET /api/auth/oauth/google (mock)
 */
mockOAuth.get('/api/auth/oauth/google', (c) => {
  return c.html(createMockLoginPage('google'))
})

/**
 * GET /api/auth/oauth/apple (mock)
 */
mockOAuth.get('/api/auth/oauth/apple', (c) => {
  return c.html(createMockLoginPage('apple'))
})

/**
 * GET /api/auth/oauth/facebook (mock)
 */
mockOAuth.get('/api/auth/oauth/facebook', (c) => {
  return c.html(createMockLoginPage('facebook'))
})

/**
 * Mock OAuth Callbacks
 * Simulates the OAuth provider redirecting back with a code
 */
mockOAuth.get('/api/auth/oauth/:provider/mock-callback', (c) => {
  const provider = c.req.param('provider') as 'google' | 'apple' | 'facebook'

  // Generate a fake code
  const code = `mock_${provider}_${Date.now()}`

  // Redirect to the main callback with the mock code
  const callbackUrl = `/?code=${code}&provider=${provider}&mock=true`
  return c.redirect(callbackUrl)
})

/**
 * POST /api/auth/oauth/:provider/callback (mock)
 * Exchange mock code for user data
 */
mockOAuth.post('/api/auth/oauth/:provider/callback', async (c) => {
  const provider = c.req.param('provider') as 'google' | 'apple' | 'facebook'
  const { code } = await c.req.json()

  // Verify it's a mock code
  if (!code || !code.startsWith('mock_')) {
    return c.json({ error: 'Invalid mock code' }, 400)
  }

  const user = MOCK_USERS[provider]

  // Return mock user data in the same format as real OAuth
  return c.json({
    existingUser: false,
    provider,
    providerId: user.id,
    email: user.email,
    fullName: user.name,
    profileData: {
      picture: user.picture || null,
    },
  })
})

export { mockOAuth }
