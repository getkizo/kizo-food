/**
 * Kizo Register Onboarding Application
 * Handles multi-step registration with social login and Clover integration
 */

/** Application State */
const state = {
  currentStep: 'welcome',
  userData: {
    provider: null,
    providerId: null,
    email: null,
    fullName: null,
    password: null,
  },
  businessData: {
    businessName: null,
    slug: null,
    phoneNumber: null,
    email: null,
  },
  posData: {
    posType: 'clover',
    cloverApiKey: null,
    cloverMerchantId: null,
    cloverSandbox: false,
  },
  tokens: {
    accessToken: null,
    refreshToken: null,
  },
}

/** Step-to-stepper mapping */
const STEP_MAP = {
  'welcome': 1,
  'email-signup': 1,
  'business': 2,
  'pos': 3,
  'success': 3,
}

/** Debounce timer for slug check */
let slugCheckTimer = null

/** OAuth provider availability */
const oauthConfig = {
  google: false,
  apple: false,
  facebook: false,
  mockMode: false,
}

/**
 * Initialize Application
 */
async function init() {
  // handleOAuthCallback must complete (including async session redemption)
  // before we call showStep('welcome'), otherwise the redirect-back flow
  // immediately gets overwritten by showStep('welcome').
  // If a session token is present, we hand off entirely and do not continue init.
  if (await handleOAuthCallback()) return

  // Wire up handlers BEFORE the async config check so buttons are always
  // clickable. The HTML renders the welcome step immediately (class="step active"),
  // and on slow devices (iPad, etc.) the user can tap Google before the fetch
  // resolves — without this order they get a dead button.
  setupEventListeners()
  toggleCloverSetup()
  setupPasskeyButton()

  await checkOAuthConfig()
  showStep('welcome')
}

/**
 * Check which OAuth providers are configured
 */
async function checkOAuthConfig() {
  try {
    const response = await fetch('/api/auth/oauth/config')
    const config = await response.json()

    oauthConfig.google = config.google
    oauthConfig.apple = config.apple
    oauthConfig.facebook = config.facebook
    oauthConfig.mockMode = config.mockMode || false

    // Update UI based on what's available
    updateOAuthButtons()
  } catch (error) {
    console.error('Failed to check OAuth config:', error)
    // Hide all OAuth buttons if check fails
    updateOAuthButtons()
  }
}

/**
 * Update OAuth button visibility and add helpful tooltips
 */
function updateOAuthButtons() {
  const providers = [
    { name: 'google', ids: ['google-login', 'google-login-modal'] },
    { name: 'apple', ids: ['apple-login', 'apple-login-modal'] },
    { name: 'facebook', ids: ['facebook-login', 'facebook-login-modal'] },
  ]

  providers.forEach(({ name, ids }) => {
    const isConfigured = oauthConfig[name]

    ids.forEach(id => {
      const btn = document.getElementById(id)
      if (!btn) return

      if (!isConfigured) {
        // Hide entirely — disabled buttons swallow touch events silently on mobile
        btn.hidden = true
      }
    })
  })

  // If no OAuth is configured, replace the social section with a direct login prompt
  const anyConfigured = oauthConfig.google || oauthConfig.apple || oauthConfig.facebook
  if (!anyConfigured) {
    showDirectLoginPrompt()
  }
}

/**
 * When no OAuth providers are configured, replace the social login section
 * with direct email action buttons and auto-open the login modal so returning
 * users (e.g. on a local-network iPad) immediately see the email/password form.
 */
function showDirectLoginPrompt() {
  // Hide the social login group and the "or" divider on the welcome screen
  const socialGroup = document.querySelector('#step-welcome .social-login')
  const divider = document.querySelector('#step-welcome .divider')
  if (socialGroup) socialGroup.hidden = true
  if (divider) divider.hidden = true

  // Replace with a direct "Log In" primary button above the signup button
  const emailSignupBtn = document.getElementById('email-signup')
  if (emailSignupBtn && !document.getElementById('direct-login-btn')) {
    const loginBtn = document.createElement('button')
    loginBtn.id = 'direct-login-btn'
    loginBtn.type = 'button'
    loginBtn.className = 'btn btn-primary full-width'
    loginBtn.textContent = 'Log In'
    loginBtn.addEventListener('click', () => showModal('login-modal'))
    emailSignupBtn.insertAdjacentElement('beforebegin', loginBtn)

    // Also insert a small divider between Log In and Sign Up
    const sep = document.createElement('div')
    sep.className = 'divider'
    sep.setAttribute('role', 'separator')
    sep.innerHTML = '<span>or</span>'
    loginBtn.insertAdjacentElement('afterend', sep)
  }

  // Auto-open the login modal so returning users don't have to hunt for it
  showModal('login-modal')
}

/**
 * Set up all event listeners
 */
function setupEventListeners() {
  // Social login buttons (welcome screen)
  document.getElementById('google-login').addEventListener('click', () => loginWithGoogle())
  document.getElementById('apple-login').addEventListener('click', () => loginWithApple())
  document.getElementById('facebook-login').addEventListener('click', () => loginWithFacebook())

  // Social login buttons (modal)
  document.getElementById('google-login-modal').addEventListener('click', () => loginWithGoogle())
  document.getElementById('apple-login-modal').addEventListener('click', () => loginWithApple())
  document.getElementById('facebook-login-modal').addEventListener('click', () => loginWithFacebook())

  // Email signup
  document.getElementById('email-signup').addEventListener('click', () => {
    showStep('email-signup')
  })

  // Email signup form
  document.getElementById('email-signup-form').addEventListener('submit', handleEmailSignup)
  document.getElementById('back-to-welcome-from-email').addEventListener('click', () => showStep('welcome'))

  // Check email availability on blur
  document.getElementById('signup-email').addEventListener('blur', async (e) => {
    const email = e.target.value.trim()
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!email || !emailRegex.test(email)) return
    await checkEmailAvailability(email)
  })

  // Show login modal
  document.getElementById('show-login').addEventListener('click', (e) => {
    e.preventDefault()
    showModal('login-modal')
  })

  // Close login modal
  document.getElementById('close-login').addEventListener('click', () => {
    hideModal('login-modal')
  })

  // Login form
  document.getElementById('login-form').addEventListener('submit', handleLogin)

  // Business form
  document.getElementById('business-form').addEventListener('submit', handleBusinessSubmit)
  document.getElementById('slug').addEventListener('input', handleSlugInput)
  document.getElementById('back-to-welcome').addEventListener('click', () => {
    showStep(state.userData.provider === 'email' ? 'email-signup' : 'welcome')
  })

  // POS type radio buttons
  document.querySelectorAll('input[name="posType"]').forEach((radio) => {
    radio.addEventListener('change', toggleCloverSetup)
  })

  document.getElementById('back-to-business').addEventListener('click', () => showStep('business'))
  document.getElementById('finish-setup').addEventListener('click', handleFinishSetup)

  // Success actions
  document.getElementById('copy-url').addEventListener('click', copyMerchantUrl)
  document.getElementById('go-to-dashboard').addEventListener('click', goToDashboard)

  // Password visibility toggles
  document.querySelectorAll('.btn-toggle-visibility').forEach((btn) => {
    btn.addEventListener('click', handlePasswordToggle)
  })

  // Close modal on outside click
  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
      hideModal(e.target.id)
    }
  })

  // Close modal on Escape
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.querySelector('.modal.active')
      if (modal) hideModal(modal.id)
    }
  })
}

/**
 * Social Login Functions
 */
function loginWithGoogle() {
  if (!oauthConfig.google) {
    showToast('Google OAuth is not configured. Please use email signup.', 'error')
    return
  }
  // Navigate synchronously — no DOM side-effects between tap and navigation
  // so iOS Safari does not treat this as a popup/blocked navigation.
  window.location.href = '/api/auth/oauth/google'
}

function loginWithApple() {
  if (!oauthConfig.apple) {
    showToast('Apple OAuth is not configured. Please use email signup.', 'error')
    return
  }
  window.location.href = '/api/auth/oauth/apple'
}

function loginWithFacebook() {
  if (!oauthConfig.facebook) {
    showToast('Facebook OAuth is not configured. Please use email signup.', 'error')
    return
  }
  window.location.href = '/api/auth/oauth/facebook'
}

/**
 * Handle OAuth callback from URL params
 */
/**
 * Handle OAuth callback — server-side flow with session redemption.
 *
 * The server exchanges the code with Google, stores the result for 60 s,
 * and redirects here with an opaque session token:
 *
 *   Existing user → /?session=<token>
 *   New user      → /?session=<token>&onboard=1
 *   Error         → /?error=<code>
 *
 * We POST /api/auth/oauth/session to redeem the token for real data.
 * This keeps JWTs out of the URL, browser history, and Referer headers.
 */
/**
 * Handle OAuth callback — returns true if it takes over page init.
 *
 * The server exchanges the code with Google, stores the result for 60 s,
 * and redirects here with an opaque session token:
 *
 *   Existing user → /?session=<token>
 *   New user      → /?session=<token>&onboard=1
 *   Error         → /?error=<code>
 */
async function handleOAuthCallback() {
  const p = new URLSearchParams(window.location.search)
  const error   = p.get('error')
  const session = p.get('session')

  if (error) {
    const messages = {
      access_denied:        'Sign-in was cancelled.',
      token_exchange_failed:'Could not complete sign-in. Please try again.',
      userinfo_failed:      'Could not fetch your account details. Please try again.',
      oauth_failed:         'Authentication failed. Please try again.',
    }
    // Let normal init proceed, but show the error toast after the page is set up
    setTimeout(() => {
      showToast(messages[error] || `Authentication failed: ${error}`, 'error')
    }, 100)
    window.history.replaceState({}, document.title, '/setup')
    return false
  }

  if (!session) return false   // normal page load — continue with init

  // Clean the URL immediately — token should never linger in history
  window.history.replaceState({}, document.title, '/setup')

  // Redeem the session before letting the rest of init run
  await redeemOAuthSession(session)
  return true   // we have taken over — caller should not call showStep('welcome')
}

/**
 * POST the opaque session token to the server and get back user data.
 * On success for an existing user, redirects to /dashboard.
 * On success for a new user, runs the full init flow then shows step 'business'.
 */
async function redeemOAuthSession(token) {
  try {
    const res = await fetch('/api/auth/oauth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Session expired or invalid')
    }

    const data = await res.json()

    if (data.existingUser) {
      // Known merchant — store tokens and redirect; no further init needed
      localStorage.setItem('accessToken', data.tokens.accessToken)
      localStorage.setItem('refreshToken', data.tokens.refreshToken)
      localStorage.setItem('merchantId', data.user.merchantId || '')
      // Diagnostic: verify storage persisted before navigating
      const stored = localStorage.getItem('accessToken')
      console.log('[OAuth] stored accessToken length:', stored?.length ?? 0, '| type:', typeof stored)
      if (!stored) {
        console.error('[OAuth] localStorage.setItem failed — accessToken not readable after write')
        showToast('Storage error: please disable private mode or allow site data', 'error')
        return
      }
      window.location.href = '/merchant'
      return
    }

    // New user — need full page init first so the DOM is ready, then show onboarding
    state.userData.provider   = data.provider || 'google'
    state.userData.providerId = data.providerId || ''
    state.userData.email      = data.email || ''
    state.userData.fullName   = data.fullName || ''

    await checkOAuthConfig()
    setupEventListeners()
    toggleCloverSetup()
    setupPasskeyButton()
    showStep('business')
    showToast('Account connected! Let\'s set up your restaurant.', 'success')
  } catch (err) {
    console.error('OAuth session redemption failed:', err)
    // Fall back to normal page init, show error
    await checkOAuthConfig()
    setupEventListeners()
    showStep('welcome')
    toggleCloverSetup()
    setupPasskeyButton()
    showToast(err.message || 'Sign-in failed. Please try again.', 'error')
  }
}

/**
 * Handle email signup form
 */
/**
 * Check if an email is available and show inline feedback.
 * Returns true if available, false if taken or on error.
 * @param {string} email
 * @returns {Promise<boolean>}
 */
async function checkEmailAvailability(email) {
  const emailInput = document.getElementById('signup-email')
  try {
    const res = await fetch(`/api/auth/check-email?email=${encodeURIComponent(email)}`)
    const data = await res.json()
    if (!data.available) {
      setFieldError(emailInput, 'This email is already registered. Try logging in instead.')
      return false
    }
    clearFieldError(emailInput)
    return true
  } catch {
    // Network error — let the server catch it at registration
    return true
  }
}

/**
 * Show an inline validation error on a form field.
 * @param {HTMLElement} input
 * @param {string} message
 */
function setFieldError(input, message) {
  clearFieldError(input)
  input.classList.add('input-error')
  const err = document.createElement('small')
  err.className = 'field-error'
  err.id = `${input.id}-error`
  err.textContent = message
  input.setAttribute('aria-describedby', err.id)
  input.insertAdjacentElement('afterend', err)
}

/**
 * Remove an inline validation error from a form field.
 * @param {HTMLElement} input
 */
function clearFieldError(input) {
  input.classList.remove('input-error')
  input.removeAttribute('aria-describedby')
  const existing = document.getElementById(`${input.id}-error`)
  if (existing) existing.remove()
}

async function handleEmailSignup(e) {
  e.preventDefault()

  const fullName = document.getElementById('signup-fullname').value.trim()
  const email = document.getElementById('signup-email').value.trim()
  const password = document.getElementById('signup-password').value
  const passwordConfirm = document.getElementById('signup-password-confirm').value

  if (!fullName || !email || !password) {
    showToast('Please fill in all required fields.', 'error')
    return
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    showToast('Please enter a valid email address.', 'error')
    return
  }

  if (password.length < 8) {
    showToast('Password must be at least 8 characters.', 'error')
    return
  }

  if (password !== passwordConfirm) {
    showToast('Passwords do not match.', 'error')
    return
  }

  const available = await checkEmailAvailability(email)
  if (!available) return

  state.userData.provider = 'email'
  state.userData.email = email
  state.userData.fullName = fullName
  state.userData.password = password

  showStep('business')
}

/**
 * Handle email/password login
 */
async function handleLogin(e) {
  e.preventDefault()

  const email = document.getElementById('login-email').value
  const password = document.getElementById('login-password').value

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Login failed')
    }

    const data = await response.json()

    localStorage.setItem('accessToken', data.tokens.accessToken)
    localStorage.setItem('refreshToken', data.tokens.refreshToken)
    localStorage.setItem('merchantId', data.user.merchantId)

    window.location.href = '/merchant'
  } catch (error) {
    console.error('Login error:', error)
    showToast(error.message, 'error')
  }
}

/**
 * Handle business form submission
 */
async function handleBusinessSubmit(e) {
  e.preventDefault()

  const formData = new FormData(e.target)

  state.businessData.businessName = formData.get('businessName')
  state.businessData.slug = formData.get('slug')
  state.businessData.phoneNumber = formData.get('phoneNumber')
  state.businessData.email = formData.get('email')

  if (!state.businessData.businessName || !state.businessData.slug) {
    showToast('Business name and slug are required.', 'error')
    return
  }

  if (!validateSlugFormat(state.businessData.slug)) {
    showToast('Invalid slug format. Use lowercase letters, numbers, and hyphens only.', 'error')
    return
  }

  const available = await checkSlugAvailability(state.businessData.slug)
  if (!available) {
    showToast('This slug is already taken. Please choose another.', 'error')
    return
  }

  showStep('pos')
}

/**
 * Validate slug format
 */
function validateSlugFormat(slug) {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) || /^[a-z0-9]$/.test(slug)
}

/**
 * Handle slug input with real-time validation and availability check
 */
function handleSlugInput(e) {
  const input = e.target
  const slug = input.value.toLowerCase().replace(/[^a-z0-9-]/g, '')
  input.value = slug

  const statusEl = document.getElementById('slug-status')

  if (slug.length < 2) {
    statusEl.textContent = ''
    statusEl.className = 'helper-text slug-status'
    return
  }

  // Debounce the availability check
  clearTimeout(slugCheckTimer)
  statusEl.textContent = 'Checking...'
  statusEl.className = 'helper-text slug-status'

  slugCheckTimer = setTimeout(async () => {
    const available = await checkSlugAvailability(slug)
    if (input.value === slug) {
      if (available) {
        statusEl.textContent = 'Available'
        statusEl.className = 'helper-text slug-status available'
      } else {
        statusEl.textContent = 'Already taken'
        statusEl.className = 'helper-text slug-status taken'
      }
    }
  }, 400)
}

/**
 * Check slug availability via API
 */
async function checkSlugAvailability(slug) {
  try {
    const response = await fetch(`/api/merchants/check-slug?slug=${encodeURIComponent(slug)}`)
    const data = await response.json()
    return data.available
  } catch (error) {
    console.error('Slug check error:', error)
    return true
  }
}

/**
 * Toggle Clover setup visibility based on POS type selection
 */
function toggleCloverSetup() {
  const posType = document.querySelector('input[name="posType"]:checked').value
  const cloverSetup = document.getElementById('clover-setup')

  state.posData.posType = posType

  if (posType === 'clover') {
    cloverSetup.classList.remove('hidden')
  } else {
    cloverSetup.classList.add('hidden')
  }
}

/**
 * Handle password visibility toggle
 */
function handlePasswordToggle(e) {
  const btn = e.currentTarget
  const targetId = btn.getAttribute('data-target')
  const input = document.getElementById(targetId)

  if (input.type === 'password') {
    input.type = 'text'
    btn.setAttribute('aria-label', 'Hide API key')
  } else {
    input.type = 'password'
    btn.setAttribute('aria-label', 'Show API key')
  }
}

/**
 * Handle finish setup button
 */
async function handleFinishSetup() {
  const posType = state.posData.posType

  if (posType === 'clover') {
    const apiKey = document.getElementById('clover-api-key').value.trim()
    const merchantId = document.getElementById('clover-merchant-id').value.trim()
    const sandbox = document.getElementById('clover-sandbox').checked

    if (!apiKey || !merchantId) {
      showToast('Please enter your Clover API key and Merchant ID.', 'error')
      return
    }

    state.posData.cloverApiKey = apiKey
    state.posData.cloverMerchantId = merchantId
    state.posData.cloverSandbox = sandbox
  }

  await registerMerchant()
}

/**
 * Register merchant account via API
 */
async function registerMerchant() {
  const loadingBtn = document.getElementById('finish-setup')
  loadingBtn.classList.add('loading')
  loadingBtn.disabled = true

  try {
    const registrationData = {
      email: state.userData.email || state.businessData.email,
      fullName: state.userData.fullName || 'Merchant Owner',
      businessName: state.businessData.businessName,
      slug: state.businessData.slug,
      phoneNumber: state.businessData.phoneNumber,
      provider: state.userData.provider !== 'email' ? state.userData.provider : undefined,
      providerId: state.userData.providerId || undefined,
    }

    // Include password for email signup
    if (state.userData.provider === 'email') {
      registrationData.password = state.userData.password
    }

    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registrationData),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Registration failed')
    }

    const data = await response.json()

    state.tokens.accessToken = data.tokens.accessToken
    state.tokens.refreshToken = data.tokens.refreshToken
    localStorage.setItem('accessToken', data.tokens.accessToken)
    localStorage.setItem('refreshToken', data.tokens.refreshToken)
    localStorage.setItem('merchantId', data.merchant.id)

    // If Clover is configured, store API key and sync
    if (state.posData.posType === 'clover') {
      await setupClover(data.merchant.id)
    }

    // Clear sensitive data from state
    state.userData.password = null

    // Show success screen
    document.getElementById('merchant-url').textContent = `${state.businessData.slug}.kizo.app`
    showStep('success')
  } catch (error) {
    console.error('Registration error:', error)
    showToast(error.message, 'error')
  } finally {
    loadingBtn.classList.remove('loading')
    loadingBtn.disabled = false
  }
}

/**
 * Set up Clover integration after registration
 */
async function setupClover(merchantId) {
  try {
    await fetch(`/api/merchants/${merchantId}/keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.tokens.accessToken}`,
      },
      body: JSON.stringify({
        keyType: 'pos',
        provider: 'clover',
        apiKey: state.posData.cloverApiKey,
        posMerchantId: state.posData.cloverMerchantId,
      }),
    })

    const syncResponse = await fetch(`/api/merchants/${merchantId}/sync-clover`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.tokens.accessToken}`,
      },
    })

    if (syncResponse.ok) {
      showToast('Clover integration configured!', 'success')
    } else {
      // API key stored but sync failed (likely auth issue)
      const errorData = await syncResponse.json().catch(() => ({}))
      console.warn('Clover sync failed:', errorData)
      showToast('Clover API key saved, but sync failed. Check your credentials in the dashboard.', 'error')
    }
  } catch (error) {
    console.error('Clover setup error:', error)
    showToast('Clover setup failed. You can configure it later from the dashboard.', 'error')
  }
}

/**
 * Copy merchant URL to clipboard
 */
function copyMerchantUrl() {
  const url = document.getElementById('merchant-url').textContent
  navigator.clipboard.writeText(`https://${url}`)
  showToast('URL copied to clipboard!', 'success')
}

/**
 * Navigate to dashboard
 */
function goToDashboard() {
  window.location.href = '/merchant'
}

/**
 * Show a step and update the stepper
 */
function showStep(stepName) {
  // Hide all steps
  document.querySelectorAll('.step').forEach((step) => {
    step.classList.remove('active')
  })

  // Show target step
  const targetStep = document.getElementById(`step-${stepName}`)
  targetStep.classList.add('active')

  // Update stepper
  updateStepper(stepName)

  // Focus the heading for screen readers
  const heading = targetStep.querySelector('h2')
  if (heading) heading.focus()

  state.currentStep = stepName
}

/**
 * Update the progress stepper
 */
function updateStepper(stepName) {
  const activeNum = STEP_MAP[stepName] || 1

  for (let i = 1; i <= 3; i++) {
    const stepEl = document.getElementById(`stepper-${i}`)
    stepEl.classList.remove('active', 'completed')
    stepEl.removeAttribute('aria-current')

    if (i < activeNum) {
      stepEl.classList.add('completed')
    } else if (i === activeNum) {
      stepEl.classList.add('active')
      stepEl.setAttribute('aria-current', 'step')
    }
  }
}

/**
 * Show modal with focus trap
 */
function showModal(modalId) {
  const modal = document.getElementById(modalId)
  modal.classList.add('active')

  // Focus the first focusable element
  const firstFocusable = modal.querySelector('button, input, [tabindex]')
  if (firstFocusable) firstFocusable.focus()
}

/**
 * Hide modal
 */
function hideModal(modalId) {
  document.getElementById(modalId).classList.remove('active')
}

/**
 * Show toast notification
 */
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast')
  toast.textContent = message
  toast.className = `toast ${type} show`

  setTimeout(() => {
    toast.classList.remove('show')
  }, 3000)
}

// ---------------------------------------------------------------------------
// Passkey (WebAuthn) login
// ---------------------------------------------------------------------------

/**
 * Show the passkey button in the login modal if a platform authenticator is
 * available (Touch ID / Face ID / Windows Hello).  Called during init().
 */
async function setupPasskeyButton() {
  const btn = document.getElementById('passkey-login')
  if (!btn || typeof window.WebAuthnClient === 'undefined') return

  const available = await window.WebAuthnClient.isPlatformAuthenticatorAvailable()
  if (!available) return

  btn.hidden = false

  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.textContent = 'Waiting for biometric…'

    try {
      const result = await window.WebAuthnClient.authenticate()
      // result = { accessToken, refreshToken, user, merchantId }
      localStorage.setItem('accessToken', result.accessToken)
      localStorage.setItem('refreshToken', result.refreshToken)
      localStorage.setItem('merchantId', result.merchantId || (result.user && result.user.merchantId) || '')
      window.location.href = '/merchant'
    } catch (err) {
      console.error('Passkey login failed:', err)
      showToast(err.message || 'Passkey sign-in failed', 'error')
      btn.disabled = false
      btn.innerHTML = `
        <svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M12 2C9.5 2 7.5 4 7.5 6.5V9H6a2 2 0 00-2 2v9a2 2 0 002 2h12a2 2 0 002-2v-9a2 2 0 00-2-2h-1.5V6.5C16.5 4 14.5 2 12 2z"/>
          <circle cx="12" cy="15" r="1.5" fill="currentColor" stroke="none"/>
          <line x1="12" y1="16.5" x2="12" y2="19"/>
        </svg>
        Sign in with Passkey`
    }
  })
}

// Initialize — surface any crash visibly so it's not swallowed as a silent
// unhandled promise rejection (especially important on mobile browsers).
function _safeInit() {
  init().catch((err) => {
    console.error('Login page init failed:', err)
    // Show a visible fallback so the user knows something went wrong
    const toast = document.getElementById('toast')
    if (toast) {
      toast.textContent = `Page error: ${err.message}. Please refresh.`
      toast.className = 'toast toast-error active'
    }
    // Still try to wire up the email login form manually as a last resort
    try { setupEventListeners() } catch (_) {}
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _safeInit)
} else {
  _safeInit()
}
