/**
 * WebAuthn (Passkey) client — fingerprint / Face ID / Windows Hello login
 *
 * Supports:
 *   - Passkey registration after email login (adds biometric credential)
 *   - Passkey authentication (sign in without password)
 *   - Credential management (list / delete passkeys)
 *
 * Exposes window.WebAuthnClient = { isSupported, register, authenticate }
 *
 * Requires:
 *   - window.authToken   set by app.js / dashboard.js after email login
 *   - Events dispatched:
 *       'webauthn:registered'       → after successful registration
 *       'webauthn:authenticated'    → after successful authentication
 *                                      detail: { accessToken, refreshToken, user, merchantId }
 */

;(function () {
  'use strict'

  // ---------------------------------------------------------------------------
  // Feature detection
  // ---------------------------------------------------------------------------

  const isSupported =
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator.credentials !== 'undefined'

  // ---------------------------------------------------------------------------
  // Helpers — base64url encode/decode (no padding)
  // ---------------------------------------------------------------------------

  /** Uint8Array → base64url string */
  function bufToB64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')
  }

  /** base64url string → Uint8Array */
  function b64urlToBuf(str) {
    // Pad to multiple of 4
    str = str.replace(/-/g, '+').replace(/_/g, '/')
    while (str.length % 4) str += '='
    const raw = atob(str)
    const buf = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i)
    return buf.buffer
  }

  // ---------------------------------------------------------------------------
  // Helpers — credential serialisation for wire format
  // ---------------------------------------------------------------------------

  /**
   * Convert a PublicKeyCredential (registration) to a plain object
   * matching what our server's /register/verify endpoint expects.
   */
  function serializeRegistration(cred) {
    const res = cred.response
    return {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        attestationObject: bufToB64url(res.attestationObject),
        clientDataJSON: bufToB64url(res.clientDataJSON),
        transports: res.getTransports ? res.getTransports() : [],
      },
    }
  }

  /**
   * Convert a PublicKeyCredential (authentication) to a plain object
   * matching what our server's /authenticate/verify endpoint expects.
   */
  function serializeAuthentication(cred) {
    const res = cred.response
    return {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        authenticatorData: bufToB64url(res.authenticatorData),
        clientDataJSON: bufToB64url(res.clientDataJSON),
        signature: bufToB64url(res.signature),
        userHandle: res.userHandle ? bufToB64url(res.userHandle) : null,
      },
    }
  }

  // ---------------------------------------------------------------------------
  // API calls
  // ---------------------------------------------------------------------------

  /** POST with JSON body, returns parsed JSON or throws. */
  async function apiPost(path, body, token) {
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const res = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  }

  // ---------------------------------------------------------------------------
  // Registration — enrol this device as a passkey
  // ---------------------------------------------------------------------------

  /**
   * Register a new passkey for the currently logged-in user.
   * Call this after the user has logged in via email/password.
   *
   * @param {string} token  - JWT access token from email login
   * @param {string} label  - Human-readable device label (e.g. "Kitchen Tablet")
   * @returns {Promise<{credentialId: string}>}
   */
  async function register(token, label) {
    if (!isSupported) throw new Error('WebAuthn not supported in this browser')

    // 1. Get options from server
    const options = await apiPost(
      '/api/auth/webauthn/register/options',
      { deviceLabel: label || 'Staff Device' },
      token
    )

    // 2. Convert base64url → ArrayBuffer for fields that need it
    options.challenge = b64urlToBuf(options.challenge)
    options.user.id = b64urlToBuf(options.user.id)

    if (options.excludeCredentials) {
      options.excludeCredentials = options.excludeCredentials.map((c) => ({
        ...c,
        id: b64urlToBuf(c.id),
      }))
    }

    // 3. Call browser authenticator
    let credential
    try {
      credential = await navigator.credentials.create({ publicKey: options })
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        throw new Error('Passkey creation was cancelled or timed out')
      }
      throw err
    }

    if (!credential) throw new Error('No credential returned by authenticator')

    // 4. Send to server for verification + storage
    const result = await apiPost(
      '/api/auth/webauthn/register/verify',
      serializeRegistration(credential),
      token
    )

    window.dispatchEvent(
      new CustomEvent('webauthn:registered', { detail: result })
    )

    return result
  }

  // ---------------------------------------------------------------------------
  // Authentication — sign in with a passkey (no password needed)
  // ---------------------------------------------------------------------------

  /**
   * Authenticate with a registered passkey.
   * On success, returns tokens and dispatches 'webauthn:authenticated'.
   *
   * @param {string|null} userId  - Optional userId hint (skip to allow any registered key)
   * @returns {Promise<{accessToken, refreshToken, user, merchantId}>}
   */
  async function authenticate(userId) {
    if (!isSupported) throw new Error('WebAuthn not supported in this browser')

    // 1. Get challenge + allowed credentials from server
    const options = await apiPost('/api/auth/webauthn/authenticate/options', {
      userId: userId || null,
    })

    // 2. Convert base64url fields
    options.challenge = b64urlToBuf(options.challenge)

    if (options.allowCredentials) {
      options.allowCredentials = options.allowCredentials.map((c) => ({
        ...c,
        id: b64urlToBuf(c.id),
      }))
    }

    // 3. Call browser authenticator (shows Touch ID / Face ID / Windows Hello UI)
    let credential
    try {
      credential = await navigator.credentials.get({ publicKey: options })
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        throw new Error('Passkey sign-in was cancelled or timed out')
      }
      throw err
    }

    if (!credential) throw new Error('No credential returned by authenticator')

    // 4. Send assertion to server for verification → get JWT
    const result = await apiPost(
      '/api/auth/webauthn/authenticate/verify',
      serializeAuthentication(credential)
    )

    window.dispatchEvent(
      new CustomEvent('webauthn:authenticated', { detail: result })
    )

    return result
  }

  // ---------------------------------------------------------------------------
  // Credential management (dashboard settings use)
  // ---------------------------------------------------------------------------

  /**
   * List all passkeys registered for the current user.
   * @param {string} token
   */
  async function listCredentials(token) {
    const res = await fetch('/api/auth/webauthn/credentials', {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }

  /**
   * Delete a registered passkey by credential row ID.
   * @param {string} token
   * @param {string} credentialId  - The `id` field from listCredentials()
   */
  async function deleteCredential(token, credentialId) {
    const res = await fetch(`/api/auth/webauthn/credentials/${credentialId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `HTTP ${res.status}`)
    }
    return res.json()
  }

  // ---------------------------------------------------------------------------
  // Convenience: check if platform authenticator is available
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the device has a platform authenticator (Touch ID / Face ID /
   * Windows Hello / Android fingerprint).  Used to conditionally show the passkey button.
   */
  async function isPlatformAuthenticatorAvailable() {
    if (!isSupported) return false
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
    } catch {
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Expose public API
  // ---------------------------------------------------------------------------

  window.WebAuthnClient = {
    isSupported,
    isPlatformAuthenticatorAvailable,
    register,
    authenticate,
    listCredentials,
    deleteCredential,
  }

})()
