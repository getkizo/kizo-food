/**
 * Camera capture module — getUserMedia → snap → existing crop pipeline.
 *
 * Architecture:
 *   - One shared camera modal (reused across all three upload contexts)
 *   - Each "Camera" button stores its target dimensions + callback via data attrs
 *   - On snap: video frame drawn to hidden canvas → Blob → synthetic File
 *     → passed into window.processImageFile() (same pipeline as file upload)
 *   - Supports front/rear camera toggle (facingMode)
 *   - Detects camera availability on init; hides buttons on devices with no camera
 *
 * Integration:
 *   - Requires window.processImageFile(file, w, h, callback) — exposed by dashboard.js
 *   - Reads data- attributes from .btn-camera buttons:
 *       data-target-w    — output width  (default 1024)
 *       data-target-h    — output height (default 768)
 *       data-context     — string label for aria ("menu item" | "logo" | "banner")
 *
 * Exposes: window.Camera = { isSupported, init }
 */

;(function () {
  'use strict'

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    stream: null,
    facingMode: 'environment',   // rear camera first (tablet mounted at counter)
    onSnap: null,                // (File) => void — set when modal opens
    targetW: 1024,
    targetH: 768,
  }

  const isSupported =
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices !== 'undefined' &&
    typeof navigator.mediaDevices.getUserMedia === 'function'

  // ---------------------------------------------------------------------------
  // DOM refs (resolved lazily after DOMContentLoaded)
  // ---------------------------------------------------------------------------

  let modal, video, switchBtn, snapBtn, closeBtn

  function resolveRefs() {
    modal     = document.getElementById('camera-modal')
    video     = document.getElementById('camera-video')
    switchBtn = document.getElementById('camera-switch-btn')
    snapBtn   = document.getElementById('camera-snap-btn')
    closeBtn  = document.getElementById('camera-close-btn')
  }

  // ---------------------------------------------------------------------------
  // Stream management
  // ---------------------------------------------------------------------------

  async function startStream() {
    stopStream()

    const constraints = {
      video: {
        facingMode: { ideal: state.facingMode },
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    }

    try {
      state.stream = await navigator.mediaDevices.getUserMedia(constraints)
      video.srcObject = state.stream
    } catch (err) {
      console.error('[Camera] getUserMedia failed:', err)
      showCameraError(err)
    }
  }

  function stopStream() {
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop())
      state.stream = null
      video.srcObject = null
    }
  }

  function showCameraError(err) {
    const viewport = document.getElementById('camera-viewport')
    let msg = 'Camera unavailable.'
    if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
      msg = 'Camera permission denied. Please allow camera access in your browser settings.'
    } else if (err?.name === 'NotFoundError') {
      msg = 'No camera found on this device.'
    } else if (err?.name === 'NotReadableError') {
      msg = 'Camera is already in use by another app.'
    }
    viewport.innerHTML = `<p class="camera-error-msg">${msg}</p>`
    snapBtn.disabled = true
  }

  // ---------------------------------------------------------------------------
  // Open / close modal
  // ---------------------------------------------------------------------------

  /**
   * @param {number} targetW
   * @param {number} targetH
   * @param {(file: File) => void} onSnap  — called with a synthetic File on snap
   */
  function openCamera(targetW, targetH, onSnap) {
    state.targetW = targetW
    state.targetH = targetH
    state.onSnap  = onSnap
    snapBtn.disabled = false

    // Restore video element if it was replaced by error message
    const viewport = document.getElementById('camera-viewport')
    if (!viewport.contains(video)) {
      viewport.innerHTML = ''
      const overlay = document.createElement('div')
      overlay.className = 'camera-overlay'
      overlay.setAttribute('aria-hidden', 'true')
      viewport.appendChild(video)
      viewport.appendChild(overlay)
    }

    modal.hidden = false
    modal.focus()
    startStream()
  }

  function closeCamera() {
    stopStream()
    modal.hidden = true
    state.onSnap = null
  }

  // ---------------------------------------------------------------------------
  // Snap — draw video frame to canvas, convert to File, pipe into crop modal
  // ---------------------------------------------------------------------------

  function snap() {
    if (!video.srcObject || video.readyState < 2) return

    const canvas = document.getElementById('image-canvas')
    const vw = video.videoWidth  || state.targetW
    const vh = video.videoHeight || state.targetH

    canvas.width  = vw
    canvas.height = vh
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, vw, vh)

    canvas.toBlob((blob) => {
      if (!blob) return
      const file = new File([blob], 'camera-snap.jpg', { type: 'image/jpeg' })
      closeCamera()

      // Feed into the dashboard's existing processImageFile pipeline
      // which will open the crop modal for final framing.
      if (typeof window.processImageFile === 'function' && state.onSnap) {
        state.onSnap(file)
      }
    }, 'image/jpeg', 0.92)
  }

  // ---------------------------------------------------------------------------
  // Wire camera buttons (called once after DOM ready)
  // ---------------------------------------------------------------------------

  /**
   * Detect camera availability and set up all .btn-camera buttons.
   * Called from init() after getUserMedia availability is confirmed.
   */
  async function wireCameraButtons() {
    // Quick check: does this device have a video input at all?
    let hasCamera = false
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      hasCamera = devices.some((d) => d.kind === 'videoinput')
    } catch {
      hasCamera = false
    }

    if (!hasCamera) return   // No camera — leave all buttons hidden

    // Show all camera buttons and wire them up
    document.querySelectorAll('.btn-camera').forEach((btn) => {
      btn.hidden = false

      btn.addEventListener('click', () => {
        const targetW = parseInt(btn.dataset.targetW || '1024', 10)
        const targetH = parseInt(btn.dataset.targetH || '768', 10)

        // The callback passed to openCamera receives the snapped File.
        // We forward it to processImageFile (exposed by dashboard.js).
        const onSnap = (file) => {
          if (typeof window.processImageFile !== 'function') return

          // Determine which preview/state setter to call based on button id
          const id = btn.id

          if (id === 'photo-camera-btn') {
            window.processImageFile(file, targetW, targetH, (dataUrl) => {
              // Reach into dashboard state the same way the file input handler does
              if (window._dashboardSetPhoto) window._dashboardSetPhoto(dataUrl)
            })
          } else if (id === 'logo-camera-btn') {
            window.processImageFile(file, targetW, targetH, (dataUrl) => {
              if (window._dashboardSetBrand) window._dashboardSetBrand('logo', dataUrl)
            })
          } else if (id === 'banner-camera-btn') {
            window.processImageFile(file, targetW, targetH, (dataUrl) => {
              if (window._dashboardSetBrand) window._dashboardSetBrand('banner', dataUrl)
            })
          }
        }

        openCamera(targetW, targetH, onSnap)
      })
    })
  }

  // ---------------------------------------------------------------------------
  // Init — called once DOM is ready
  // ---------------------------------------------------------------------------

  function init() {
    if (!isSupported) return   // No getUserMedia — skip everything

    resolveRefs()

    // Modal controls
    closeBtn.addEventListener('click', closeCamera)
    snapBtn.addEventListener('click', snap)

    switchBtn.addEventListener('click', async () => {
      state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment'
      await startStream()
    })

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeCamera()
    })

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) closeCamera()
    })

    // Wire all camera buttons (async — enumerateDevices)
    wireCameraButtons()
  }

  // ---------------------------------------------------------------------------
  // dashboard.js integration hooks
  //
  // dashboard.js exposes its internal image-result setters via window._dashboard*
  // so camera.js can call them after processImageFile returns a data URL.
  // These are set by dashboard.js when it initialises the upload areas.
  // ---------------------------------------------------------------------------

  // Expose public API
  window.Camera = { isSupported, init }

  // Auto-init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }

})()
