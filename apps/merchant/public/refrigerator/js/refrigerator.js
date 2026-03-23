/**
 * Refrigerator Log — standalone tablet app
 *
 * All data stored in localStorage (no backend). Each tablet has its own
 * settings and log entries keyed by STORAGE_PREFIX.
 *
 * Storage keys:
 *   bb_fridge_name       — display name (e.g. "Proteins")
 *   bb_fridge_ingredients — JSON string[] of ingredient keys (English canonical)
 *   bb_fridge_log        — JSON { [ingredientKey]: ISO timestamp }
 *   bb_fridge_lang       — 'en' | 'es'
 */

;(function () {
  'use strict'

  // ── Storage keys ──────────────────────────────────────────────────────────

  const KEY_NAME        = 'bb_fridge_name'
  const KEY_INGREDIENTS = 'bb_fridge_ingredients'
  const KEY_LOG         = 'bb_fridge_log'
  const KEY_LANG        = 'bb_fridge_lang'

  // ── i18n ──────────────────────────────────────────────────────────────────

  const TRANSLATIONS = {
    en: {
      appTitle:       'Refrigerator Log',
      log:            'Log',
      settings:       'Settings',
      fridgeName:     'Refrigerator Name',
      ingredients:    'Ingredients',
      ingredientHint: 'Tap a suggestion or type a custom ingredient and press Enter.',
      add:            'Add',
      clearAll:       'Clear All Entries',
      clearConfirm:   'Clear all log entries? This cannot be undone.',
      noEntries:      'No entries yet. Tap an ingredient above to record a timestamp.',
      language:       'Language',
      close:          'Close',
      copied:         'Recorded',
      agoDay:         'd ago',
      agoHour:        'h ago',
    },
    es: {
      appTitle:       'Registro de Refrigerador',
      log:            'Registro',
      settings:       'Configuración',
      fridgeName:     'Nombre del Refrigerador',
      ingredients:    'Ingredientes',
      ingredientHint: 'Toca una sugerencia o escribe un ingrediente personalizado y presiona Enter.',
      add:            'Agregar',
      clearAll:       'Borrar Todas las Entradas',
      clearConfirm:   '¿Borrar todas las entradas del registro? Esto no se puede deshacer.',
      noEntries:      'Sin entradas. Toca un ingrediente arriba para registrar la hora.',
      language:       'Idioma',
      close:          'Cerrar',
      copied:         'Registrado',
      agoDay:         'd atrás',
      agoHour:        'h atrás',
    },
  }

  /**
   * Preset ingredient bank with translations.
   * Key is the canonical English lowercase name (used as storage key).
   */
  const INGREDIENT_BANK = {
    // Proteins
    chicken:              { en: 'Chicken',              es: 'Pollo' },
    beef:                 { en: 'Beef',                 es: 'Res' },
    pork:                 { en: 'Pork',                 es: 'Cerdo' },
    salmon:               { en: 'Salmon',               es: 'Salmón' },
    shrimp:               { en: 'Shrimp',               es: 'Camarón' },
    tofu:                 { en: 'Tofu',                 es: 'Tofu' },
    eggs:                 { en: 'Eggs',                 es: 'Huevos' },
    // Prepared
    'gai tod':            { en: 'Gai Tod',              es: 'Gai Tod' },
    'northern thai curry':{ en: 'Northern Thai Curry',  es: 'Curry del Norte de Tailandia' },
    'half & half':        { en: 'Half & Half',          es: 'Half & Half' },
    // Produce
    broccoli:             { en: 'Broccoli',             es: 'Brócoli' },
    tomatoes:             { en: 'Tomatoes',             es: 'Tomates' },
    'green peppers':      { en: 'Green Peppers',        es: 'Pimientos Verdes' },
    cilantro:             { en: 'Cilantro',             es: 'Cilantro' },
    'red onions':         { en: 'Red Onions',           es: 'Cebollas Moradas' },
    'bean sprouts':       { en: 'Bean Sprouts',         es: 'Brotes de Soya' },
    lettuce:              { en: 'Lettuce',              es: 'Lechuga' },
    carrots:              { en: 'Carrots',              es: 'Zanahorias' },
    mushrooms:            { en: 'Mushrooms',            es: 'Champiñones' },
    'green onions':       { en: 'Green Onions',         es: 'Cebolletas' },
    garlic:               { en: 'Garlic',               es: 'Ajo' },
    ginger:               { en: 'Ginger',               es: 'Jengibre' },
    limes:                { en: 'Limes',                es: 'Limones' },
    basil:                { en: 'Basil',                es: 'Albahaca' },
    // Beverages / misc
    'thai tea':           { en: 'Thai Tea',             es: 'Té Tailandés' },
    'thai coffee':        { en: 'Thai Coffee',          es: 'Café Tailandés' },
    'matcha tea':         { en: 'Matcha Tea',           es: 'Té Matcha' },
    // Curries
    'red curry':          { en: 'Red Curry',            es: 'Curry Rojo' },
    'panang curry':       { en: 'Panang Curry',         es: 'Curry Panang' },
    'yellow curry':       { en: 'Yellow Curry',         es: 'Curry Amarillo' },
    'green curry':        { en: 'Green Curry',          es: 'Curry Verde' },
    'massaman curry':     { en: 'Massaman Curry',       es: 'Curry Massaman' },
    // Dairy / misc
    milk:                 { en: 'Milk',                 es: 'Leche' },
    butter:               { en: 'Butter',               es: 'Mantequilla' },
    cheese:               { en: 'Cheese',               es: 'Queso' },
    'coconut milk':       { en: 'Coconut Milk',         es: 'Leche de Coco' },
    rice:                 { en: 'Rice',                 es: 'Arroz' },
    noodles:              { en: 'Noodles',              es: 'Fideos' },
  }

  // ── State ─────────────────────────────────────────────────────────────────

  let lang        = loadLang()
  let fridgeName  = loadFridgeName()
  let ingredients = loadIngredients()
  let logEntries  = loadLog()

  // ── LocalStorage helpers ──────────────────────────────────────────────────

  function loadLang() {
    return localStorage.getItem(KEY_LANG) || 'en'
  }
  function saveLang(l) {
    localStorage.setItem(KEY_LANG, l)
  }

  function loadFridgeName() {
    return localStorage.getItem(KEY_NAME) || ''
  }
  function saveFridgeName(n) {
    localStorage.setItem(KEY_NAME, n)
  }

  function loadIngredients() {
    try { return JSON.parse(localStorage.getItem(KEY_INGREDIENTS) || '[]') }
    catch { return [] }
  }
  function saveIngredients(arr) {
    localStorage.setItem(KEY_INGREDIENTS, JSON.stringify(arr))
  }

  function loadLog() {
    try { return JSON.parse(localStorage.getItem(KEY_LOG) || '{}') }
    catch { return {} }
  }
  function saveLog(obj) {
    localStorage.setItem(KEY_LOG, JSON.stringify(obj))
  }

  // ── i18n helpers ──────────────────────────────────────────────────────────

  function t(key) {
    return (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) || TRANSLATIONS.en[key] || key
  }

  /** Get display name for an ingredient key in the current language. */
  function ingredientLabel(key) {
    const entry = INGREDIENT_BANK[key]
    if (entry) return entry[lang] || entry.en || key
    // Custom ingredient — capitalize first letter
    return key.charAt(0).toUpperCase() + key.slice(1)
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function renderAll() {
    renderHeader()
    renderButtons()
    renderLog()
    applyStaticTranslations()
  }

  function renderHeader() {
    const title = document.getElementById('app-title')
    const display = fridgeName || t('appTitle')
    title.textContent = display
  }

  function applyStaticTranslations() {
    setText('log-title', t('log'))
    setText('settings-title', t('settings'))
    setText('fridge-name-label', t('fridgeName'))
    setText('ingredients-label', t('ingredients'))
    setText('ingredients-hint', t('ingredientHint'))
    setText('add-ingredient-btn', t('add'))
    setText('clear-log-btn', t('clearAll'))
    const logEmpty = document.getElementById('log-empty')
    if (logEmpty) logEmpty.textContent = t('noEntries')
  }

  function setText(id, text) {
    const el = document.getElementById(id)
    if (el) el.textContent = text
  }

  function renderButtons() {
    const grid = document.getElementById('ingredient-buttons')
    grid.innerHTML = ''
    ingredients.forEach(function (key) {
      var btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'ingredient-btn'
      btn.textContent = ingredientLabel(key)
      btn.addEventListener('click', function () {
        recordIngredient(key, btn)
      })
      grid.appendChild(btn)
    })
  }

  function renderLog() {
    var body = document.getElementById('log-body')
    var empty = document.getElementById('log-empty')
    body.innerHTML = ''

    // Build sorted entries: most recent first
    var entries = []
    for (var key in logEntries) {
      if (logEntries.hasOwnProperty(key)) {
        entries.push({ key: key, ts: logEntries[key] })
      }
    }
    // Only show ingredients that are currently configured
    var activeSet = new Set(ingredients)
    entries = entries.filter(function (e) { return activeSet.has(e.key) })
    entries.sort(function (a, b) { return new Date(b.ts).getTime() - new Date(a.ts).getTime() })

    if (entries.length === 0) {
      empty.hidden = false
      return
    }
    empty.hidden = true

    var now = Date.now()
    entries.forEach(function (entry) {
      var tr = document.createElement('tr')
      var ageMs = now - new Date(entry.ts).getTime()
      var ageHours = ageMs / (1000 * 60 * 60)

      if (ageHours > 48) tr.className = 'log-row-old'
      else if (ageHours > 24) tr.className = 'log-row-aging'
      else tr.className = 'log-row-fresh'

      var tdName = document.createElement('td')
      tdName.className = 'log-name'
      tdName.textContent = ingredientLabel(entry.key)

      // Age badge
      if (ageHours >= 24) {
        var badge = document.createElement('span')
        badge.className = 'log-age-badge ' + (ageHours > 48 ? 'old' : 'aging')
        if (ageHours >= 24) {
          var days = Math.floor(ageHours / 24)
          badge.textContent = days + t('agoDay')
        }
        tdName.appendChild(badge)
      }

      var tdTime = document.createElement('td')
      tdTime.className = 'log-time'
      tdTime.textContent = formatTimestamp(entry.ts)

      tr.appendChild(tdName)
      tr.appendChild(tdTime)
      body.appendChild(tr)
    })
  }

  function formatTimestamp(isoStr) {
    var d = new Date(isoStr)
    var months = lang === 'es'
      ? ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']
      : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    var month = months[d.getMonth()]
    var day = d.getDate()
    var h = d.getHours()
    var m = d.getMinutes()
    var ampm = h >= 12 ? 'PM' : 'AM'
    h = h % 12 || 12
    var mStr = m < 10 ? '0' + m : '' + m
    return month + ' ' + day + ', ' + h + ':' + mStr + ' ' + ampm
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  function recordIngredient(key, btn) {
    logEntries[key] = new Date().toISOString()
    saveLog(logEntries)
    renderLog()

    // Visual feedback
    btn.classList.add('just-logged')
    setTimeout(function () { btn.classList.remove('just-logged') }, 600)
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  function openSettings() {
    document.getElementById('settings-panel').hidden = false
    document.getElementById('main-view').hidden = true
    document.getElementById('fridge-name-input').value = fridgeName
    renderSuggestions()
    renderActiveIngredients()
  }

  function closeSettings() {
    // Persist fridge name
    fridgeName = document.getElementById('fridge-name-input').value.trim()
    saveFridgeName(fridgeName)

    document.getElementById('settings-panel').hidden = true
    document.getElementById('main-view').hidden = false
    renderAll()
  }

  function renderSuggestions() {
    var grid = document.getElementById('suggestions-grid')
    grid.innerHTML = ''
    var keys = Object.keys(INGREDIENT_BANK)
    keys.forEach(function (key) {
      var chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'suggestion-chip'
      chip.textContent = ingredientLabel(key)
      if (ingredients.indexOf(key) !== -1) {
        chip.classList.add('added')
      } else {
        chip.addEventListener('click', function () {
          addIngredient(key)
        })
      }
      grid.appendChild(chip)
    })
  }

  function renderActiveIngredients() {
    var container = document.getElementById('active-ingredients')
    container.innerHTML = ''
    ingredients.forEach(function (key) {
      var chip = document.createElement('span')
      chip.className = 'active-chip'
      chip.textContent = ingredientLabel(key) + ' '
      var removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.className = 'chip-remove'
      removeBtn.setAttribute('aria-label', 'Remove')
      removeBtn.textContent = '\u00d7'
      chip.appendChild(removeBtn)
      removeBtn.addEventListener('click', function () {
        removeIngredient(key)
      })
      container.appendChild(chip)
    })
  }

  function addIngredient(key) {
    var normalised = key.trim().toLowerCase()
    if (!normalised) return
    if (ingredients.indexOf(normalised) !== -1) return // already added
    ingredients.push(normalised)
    saveIngredients(ingredients)
    renderSuggestions()
    renderActiveIngredients()
  }

  function removeIngredient(key) {
    ingredients = ingredients.filter(function (k) { return k !== key })
    saveIngredients(ingredients)
    renderSuggestions()
    renderActiveIngredients()
  }

  // ── Language toggle ───────────────────────────────────────────────────────

  function cycleLang() {
    lang = lang === 'en' ? 'es' : 'en'
    saveLang(lang)
    renderAll()
    // If settings is open, re-render suggestions too
    if (!document.getElementById('settings-panel').hidden) {
      renderSuggestions()
      renderActiveIngredients()
      applyStaticTranslations()
    }
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  function init() {
    document.getElementById('settings-btn').addEventListener('click', openSettings)
    document.getElementById('settings-close-btn').addEventListener('click', closeSettings)
    document.getElementById('lang-btn').addEventListener('click', cycleLang)

    // Add custom ingredient
    var addInput = document.getElementById('add-ingredient-input')
    var addBtn   = document.getElementById('add-ingredient-btn')
    addBtn.addEventListener('click', function () {
      addIngredient(addInput.value)
      addInput.value = ''
    })
    addInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        addIngredient(addInput.value)
        addInput.value = ''
      }
    })

    // Clear all entries
    document.getElementById('clear-log-btn').addEventListener('click', function () {
      if (confirm(t('clearConfirm'))) {
        logEntries = {}
        saveLog(logEntries)
        renderLog()
      }
    })

    renderAll()

    // Refresh age indicators every minute
    setInterval(renderLog, 60000)
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
