/**
 * store-voice.js — Voice ordering for the customer store
 *
 * Workflow (one dish at a time):
 *   1. Customer taps the mic button
 *   2. Browser speech recognition listens for one utterance
 *   3. Transcript is parsed: qty + item name + modifiers + spice stars
 *   4. Best-matching menu item is found via fuzzy search
 *   5. Modifier sheet opens with voice-matched selections pre-filled
 *   6. Customer reviews, adjusts if needed, and taps "Add to Order"
 *
 * Example utterances:
 *   "one spring roll"
 *   "one pad thai chicken 2 stars"
 *   "one pad see ew tofu, extra tofu, 5 stars, vegan"
 *
 * Exposes: window.StoreVoice = { init }
 */

;(function () {
  'use strict'

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition

  // ---------------------------------------------------------------------------
  // Number helpers
  // ---------------------------------------------------------------------------

  const WORD_NUM = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    a: 1, an: 1,
  }

  /** Parse an optional leading quantity from a transcript string. */
  function parseQty(text) {
    const m = text.match(/^(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|a|an)\b/i)
    if (!m) return { qty: 1, rest: text }
    const word = m[1].toLowerCase()
    const qty  = WORD_NUM[word] != null ? (WORD_NUM[word] || 1) : parseInt(m[1], 10)
    return { qty, rest: text.slice(m[0].length).trim() }
  }

  /** Convert a number word or digit string to an integer. */
  function wordToNum(s) {
    const lower = s.toLowerCase()
    return WORD_NUM[lower] != null ? WORD_NUM[lower] : parseInt(s, 10)
  }

  // ---------------------------------------------------------------------------
  // Fuzzy matching (Levenshtein distance-based)
  // ---------------------------------------------------------------------------

  /** Levenshtein edit distance between two strings. */
  function levenshtein(a, b) {
    if (a === b) return 0
    var m = a.length, n = b.length
    if (!m) return n
    if (!n) return m
    var prev = []
    for (var i = 0; i <= n; i++) prev[i] = i
    for (var i = 1; i <= m; i++) {
      var curr = [i]
      for (var j = 1; j <= n; j++) {
        curr[j] = a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1])
      }
      prev = curr
    }
    return prev[n]
  }

  /**
   * Normalize Thai romanization spelling variants before comparison.
   * Maps aspirated digraphs to their unaspirated equivalents so that
   * speech-recognition outputs like "ka" match menu text "kha".
   */
  function phoneticNorm(s) {
    return s
      .replace(/kh/g, 'k')
      .replace(/ph/g, 'p')
      .replace(/th/g, 't')
      .replace(/aa/g, 'a')
      .replace(/ee/g, 'i')
      .replace(/oo/g, 'u')
  }

  /** Similarity (0–1) between two words using edit distance. */
  function wordSim(a, b) {
    if (a === b) return 1.0
    if (a.includes(b) || b.includes(a)) return 0.9
    // Try phonetic normalization — Thai aspirated digraphs
    var pa = phoneticNorm(a), pb = phoneticNorm(b)
    if (pa === pb) return 1.0
    if (pa.includes(pb) || pb.includes(pa)) return 0.9
    var dist = Math.min(levenshtein(a, b), levenshtein(pa, pb))
    return Math.max(0, 1 - dist / Math.max(a.length, b.length))
  }

  /**
   * Compute a match score (0–1) between a voice query and a menu item name.
   * Uses per-word Levenshtein similarity so near-misses from speech
   * recognition (e.g. "ka" → "kha", "tie" → "thai") still score well.
   */
  function fuzzyScore(query, candidate) {
    query     = query.toLowerCase().trim()
    candidate = candidate.toLowerCase().trim()
    if (candidate === query)       return 1.0
    if (candidate.includes(query)) return 0.95

    // Include 2+ char words (Thai dish names have short key words: kha, ew, ka)
    var qWords = query.split(/\s+/).filter(function (w) { return w.length > 1 })
    var cWords = candidate.split(/\s+/)
    if (!qWords.length) return candidate.includes(query) ? 0.5 : 0

    var total = 0
    for (var i = 0; i < qWords.length; i++) {
      var best = 0
      for (var j = 0; j < cWords.length; j++) {
        best = Math.max(best, wordSim(qWords[i], cWords[j]))
      }
      total += best
    }
    return (total / qWords.length) * 0.9
  }

  /** Find the best item in allItems matching query. Returns null if score < 0.3. */
  function findBestItem(query, allItems) {
    var best = null, bestScore = 0
    for (var i = 0; i < allItems.length; i++) {
      var score = fuzzyScore(query, allItems[i].name)
      if (score > bestScore) { bestScore = score; best = allItems[i] }
    }
    return bestScore >= 0.3 ? best : null
  }

  // ---------------------------------------------------------------------------
  // Transcript parsing
  // ---------------------------------------------------------------------------

  /** True if a modifier group name looks like a spice / star level selector. */
  function isStarGroup(groupName) {
    return /spice|star|heat|level|pepper|mild|hot/i.test(groupName)
  }

  /**
   * Match voice segments against a modifier group's options.
   * Returns an array of modifier IDs that match, respecting maxAllowed.
   */
  function matchGroup(group, segments, stars) {
    // Star / spice group — find the mod with the matching star count
    if (stars !== null && isStarGroup(group.name)) {
      const starMod = group.modifiers.find(m => {
        const n = m.name.match(/(\d+)/)?.[1]
        return n && parseInt(n) === stars
      })
      return starMod ? [starMod.id] : []
    }

    // Text-segment matching — score each modifier against each segment
    const selected = []
    for (const mod of group.modifiers) {
      if (mod.stockStatus === 'out_today') continue
      for (const seg of segments) {
        if (fuzzyScore(seg, mod.name) >= 0.45) {
          selected.push(mod.id)
          break
        }
      }
    }

    // Respect maxAllowed
    if (group.maxAllowed === 1 && selected.length > 1) return [selected[0]]
    return selected
  }

  /**
   * Parse a voice transcript into { item, qty, voiceMods, confidence }.
   * Returns null if no matching item is found.
   *
   * @param {string}   transcript - Raw speech-to-text string
   * @param {object[]} menu       - model.menu (categories with items)
   */
  function parseTranscript(transcript, menu) {
    // 1. Flatten all items, deduplicating across __popular__
    const allItems = []
    const seen = new Set()
    for (const cat of menu) {
      if (cat.id === '__popular__') continue
      for (const item of (cat.items || [])) {
        if (!seen.has(item.id)) { allItems.push(item); seen.add(item.id) }
      }
    }
    if (!allItems.length) return null

    // 2. Strip leading quantity
    const { qty, rest: afterQty } = parseQty(transcript.trim())

    // 3. Split remainder by commas → segments
    const rawSegs = afterQty.split(',').map(s => s.trim()).filter(Boolean)

    // 4. Extract star rating from any segment (e.g. "2 stars", "five stars")
    let stars = null
    const segments = rawSegs.map(seg => {
      const m = seg.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+stars?/i)
      if (m) {
        stars = wordToNum(m[1])
        return seg.replace(m[0], '').trim()
      }
      return seg
    }).filter(Boolean)

    // 5. First segment = item name; rest = modifier hints
    if (!segments.length) return null
    const [itemQuery, ...modSegments] = segments

    // 6. Find best matching menu item
    const bestItem = findBestItem(itemQuery, allItems)
    if (!bestItem) return null
    const bestScore = fuzzyScore(itemQuery, bestItem.name)

    // 7. Match modifiers for each group
    const voiceMods = {}
    for (const group of (bestItem.modifierGroups || [])) {
      voiceMods[group.id] = matchGroup(group, modSegments, stars)
    }

    return { item: bestItem, qty, voiceMods, stars, confidence: bestScore }
  }

  // ---------------------------------------------------------------------------
  // Apply to SAM model
  // ---------------------------------------------------------------------------

  /**
   * Open the modifier sheet for item with voice-matched pre-selections.
   * Uses selectItem() to set defaults, then toggleModifier() to reconcile.
   */
  function applyVoiceOrder({ item, qty, voiceMods }) {
    // Open modifier sheet — selectItem sets required-single-select defaults
    window.Store.actions.selectItem(item)

    // Read state immediately (SAM present is synchronous)
    const model  = window.Store.getModel()
    const current = model.selectedModifiers || {}

    // Reconcile each group where we have a voice preference
    for (const [groupId, targetIds] of Object.entries(voiceMods)) {
      if (!targetIds.length) continue  // no voice preference → keep defaults
      const currentIds = current[groupId] || []

      // Add voice-matched mods not yet selected
      for (const id of targetIds) {
        if (!currentIds.includes(id)) {
          window.Store.actions.toggleModifier(groupId, id)
        }
      }
      // Remove defaults that weren't mentioned
      for (const id of currentIds) {
        if (!targetIds.includes(id)) {
          window.Store.actions.toggleModifier(groupId, id)
        }
      }
    }

    // Set quantity (setItemQty only if > 1; default is already 1)
    if (qty > 1) window.Store.actions.setItemQty(qty)
  }

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------

  let _toastTimer = null

  function showToast(msg, durationMs) {
    let el = document.getElementById('voice-toast')
    if (!el) {
      el = document.createElement('div')
      el.id    = 'voice-toast'
      el.className = 'voice-toast'
      el.setAttribute('role', 'status')
      el.setAttribute('aria-live', 'polite')
      document.body.appendChild(el)
    }
    el.textContent = msg
    el.classList.add('voice-toast--visible')
    clearTimeout(_toastTimer)
    if (durationMs !== Infinity) {
      _toastTimer = setTimeout(() => el.classList.remove('voice-toast--visible'), durationMs ?? 3000)
    }
  }

  function hideToast() {
    clearTimeout(_toastTimer)
    const el = document.getElementById('voice-toast')
    if (el) el.classList.remove('voice-toast--visible')
  }

  // ---------------------------------------------------------------------------
  // Mic button state
  // ---------------------------------------------------------------------------

  let _recognition = null
  let _listening   = false

  function setListening(listening) {
    _listening = listening
    const btn = document.getElementById('voice-mic-btn')
    if (!btn) return
    btn.classList.toggle('voice-mic-btn--listening', listening)
    btn.setAttribute('aria-pressed', String(listening))
    btn.setAttribute('aria-label', listening ? 'Stop listening' : 'Order by voice')
  }

  // ---------------------------------------------------------------------------
  // Core recognition flow
  // ---------------------------------------------------------------------------

  function processTranscript(transcript) {
    const model = window.Store.getModel()
    if (!model?.menu?.length) {
      showToast("Menu not loaded yet. Try again.", 3000)
      return
    }

    const parsed = parseTranscript(transcript, model.menu)
    if (!parsed) {
      showToast(`Couldn't find "${transcript}". Try saying the dish name.`, 4000)
      return
    }

    hideToast()
    applyVoiceOrder(parsed)
  }

  function _doListen() {
    const model = window.Store.getModel()
    if (!model || model.appState !== 'BROWSING') return

    _recognition = new SR()
    _recognition.lang            = 'en-US'
    _recognition.continuous      = false
    _recognition.interimResults  = false
    _recognition.maxAlternatives = 3

    _recognition.onstart = () => {
      setListening(true)
      showToast('Listening…', Infinity)
    }

    _recognition.onresult = (e) => {
      // Try ALL alternatives and pick the highest-confidence match
      const alts = Array.from(e.results[0]).map(r => r.transcript)
      const transcript = alts[0]
      showToast(`"${transcript}"`, 2500)

      const menu = window.Store.getModel()?.menu ?? []
      let bestParsed = null
      for (const alt of alts) {
        const parsed = parseTranscript(alt, menu)
        if (parsed && (!bestParsed || parsed.confidence > bestParsed.confidence)) {
          bestParsed = parsed
        }
      }

      if (!bestParsed) {
        showToast(`Couldn't find "${transcript}". Try saying the dish name.`, 4000)
        return
      }
      hideToast()
      applyVoiceOrder(bestParsed)
    }

    _recognition.onnomatch = () => {
      showToast("Didn't catch that. Try again.", 3000)
    }

    _recognition.onerror = (e) => {
      if (e.error === 'aborted' || e.error === 'no-speech') return
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        // Browser blocked mic — permissions were denied after the prompt
        showToast("Microphone access denied. Enable it in your browser settings.", 5000)
        return
      }
      showToast("Couldn't access microphone. Try again.", 4000)
    }

    _recognition.onend = () => {
      setListening(false)
      // If toast still shows "Listening…", clear it
      const el = document.getElementById('voice-toast')
      if (el?.textContent === 'Listening…') hideToast()
    }

    _recognition.start()
  }

  /**
   * Ensure microphone permission is granted, then start speech recognition.
   *
   * Chrome / Edge do NOT show the browser permission dialog when
   * SpeechRecognition.start() is called — they fire onerror:'not-allowed'
   * instead. The only way to trigger the native "Allow / Block" prompt is
   * via getUserMedia(). We call it as the FIRST await in the click handler
   * to preserve the user-gesture context, stop the stream immediately (we
   * only need the grant), then hand off to SpeechRecognition.
   */
  async function startListening() {
    if (!SR) {
      showToast('Voice ordering is not supported in this browser.', 4000)
      return
    }

    // Already listening → stop
    if (_listening) {
      _recognition?.stop()
      return
    }

    // Call getUserMedia immediately — this is the first await in the click
    // handler, so the user-gesture context is preserved. It will trigger the
    // browser's native Allow/Block prompt if needed, succeed silently if
    // already granted, or throw NotAllowedError if denied.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(t => t.stop())
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        showToast('Microphone access denied. Enable it in your browser settings.', 5000)
      } else {
        showToast("Couldn't access microphone. Try again.", 4000)
      }
      return
    }

    _doListen()
  }

  // ---------------------------------------------------------------------------
  // Mic button DOM
  // ---------------------------------------------------------------------------

  function createMicButton() {
    const btn = document.createElement('button')
    btn.id        = 'voice-mic-btn'
    btn.className = 'voice-mic-btn'
    btn.type      = 'button'
    btn.setAttribute('aria-label',   'Order by voice')
    btn.setAttribute('aria-pressed', 'false')
    btn.innerHTML = `
      <!-- Mic icon (default state) -->
      <svg class="voice-icon voice-icon--mic" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true">
        <rect x="9" y="2" width="6" height="12" rx="3"/>
        <path d="M5 10a7 7 0 0 0 14 0"/>
        <line x1="12" y1="17" x2="12" y2="21"/>
        <line x1="8" y1="21" x2="16" y2="21"/>
      </svg>
      <!-- Stop icon (listening state) -->
      <svg class="voice-icon voice-icon--stop" viewBox="0 0 24 24" fill="currentColor"
           aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="2"/>
      </svg>
    `
    btn.addEventListener('click', startListening)
    return btn
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  function init() {
    if (!SR) return  // Silently degrade on unsupported browsers

    const browsing = document.getElementById('state-browsing')
    if (!browsing) return

    const btn = createMicButton()
    browsing.appendChild(btn)

    // Shift mic button up when cart bar is visible
    const cartBar = document.getElementById('cart-bar')
    if (cartBar) {
      function syncMicPos() {
        btn.classList.toggle('voice-mic-btn--above-cart', !cartBar.hidden)
      }
      new MutationObserver(syncMicPos).observe(cartBar, { attributes: true, attributeFilter: ['hidden'] })
      syncMicPos()
    }
  }

  window.StoreVoice = { init }
})()
