(function themePanelRuntime() {
  const engine = window.__symposiumTheme
  if (!engine) return

  let panel = null
  let working = null
  let ours = false

  const q = (sel) => panel.querySelector(sel)
  const all = (sel) => Array.from(panel.querySelectorAll(sel))

  const mode = () => engine.readMode()

  /** The panel edits a working copy so that "reset" is one click, not a
   *  reconstruction, and so a drag paints the page on every frame. */
  function current() {
    if (!working) working = engine.read() || Object.assign({}, engine.DEFAULTS)
    return working
  }

  function push(patch, preset) {
    const next = Object.assign({}, current(), patch)
    next.preset = preset === undefined ? "custom" : preset
    ours = true
    working = engine.save(next)
    ours = false
    render()
  }

  function swatchStyle(el, theme, section) {
    const p = engine.palette(theme, mode(), section)
    el.style.setProperty("--sw-paper", engine.hex(p.light))
    el.style.setProperty("--sw-line", engine.hex(p.lightgray))
    el.style.setProperty("--sw-ink", engine.hex(p.darkgray))
    el.style.setProperty("--sw-accent", engine.hex(p.secondary))
    el.style.setProperty("--sw-lift", engine.hex(p.tertiary))
  }

  function render() {
    const theme = current()
    const saved = !!engine.read()

    for (const input of all("input[type=range]")) {
      const key = input.dataset.key
      if (key && theme[key] !== undefined) input.value = String(theme[key])
    }
    for (const box of all("input[type=checkbox]")) {
      const key = box.dataset.key
      if (key) box.checked = !!theme[key]
    }

    for (const out of all("[data-out]")) {
      const key = out.dataset.out
      out.textContent = format(key, theme[key])
    }

    for (const button of all("[data-preset]"))
      button.setAttribute("aria-pressed", String(button.dataset.preset === theme.preset))
    for (const button of all("[data-spread]"))
      button.setAttribute(
        "aria-pressed",
        String(Math.abs(Number(button.dataset.spread) - theme.spread) < 0.001),
      )
    for (const button of all("[data-mode]"))
      button.setAttribute("aria-pressed", String(button.dataset.mode === savedMode()))
    const fontSelect = q("[data-key=font]")
    if (fontSelect) fontSelect.value = theme.font

    for (const chip of all(".tp-preset")) {
      const preset = engine.PRESETS[chip.dataset.preset]
      if (preset) swatchStyle(chip, Object.assign({}, theme, preset, { spread: 0 }), "")
    }
    for (const row of all(".tp-field-row")) {
      const slug = row.dataset.sectionSlug || ""
      swatchStyle(row, theme, slug)
      const shift = row.querySelector(".tp-field-shift")
      if (shift) {
        const turn = Math.round(engine.sectionTransform(slug).hue * theme.spread)
        shift.textContent = turn === 0 ? "your accent" : (turn > 0 ? "+" : "") + turn + "°"
      }
    }

    const status = q(".tp-status")
    if (status) {
      status.textContent = saved
        ? "saved on this device" + (theme.preset === "custom" ? " · custom" : " · " + theme.preset)
        : "the candlelit default, untouched"
    }
    const resetButton = q(".tp-reset")
    if (resetButton) resetButton.disabled = !saved
  }

  function format(key, value) {
    if (key === "hue") return Math.round(value) + "°"
    if (key === "measure") return Math.round(value) + "rem"
    if (key === "size") return Math.round(value * 100) + "%"
    return Math.round(value * 100) + "%"
  }

  function savedMode() {
    try {
      const saved = window.localStorage.getItem("theme")
      if (saved === "light" || saved === "dark") return saved
    } catch (err) {
      /* private mode */
    }
    return "auto"
  }

  /** Drive quartz's darkmode plugin from here rather than duplicating it: same
   *  key, same attribute, same event, so its toolbar button stays in step. */
  function setMode(next) {
    try {
      if (next === "auto") window.localStorage.removeItem("theme")
      else window.localStorage.setItem("theme", next)
    } catch (err) {
      /* private mode */
    }
    const resolved = next === "auto" ? engine.readMode() : next
    document.documentElement.setAttribute("saved-theme", resolved)
    document.body.classList.remove("theme-dark", "theme-light")
    document.body.classList.add("theme-" + resolved)
    document.dispatchEvent(new CustomEvent("themechange", { detail: { theme: resolved } }))
    engine.refresh()
    render()
  }

  /**
   * Every listener goes through here, and every one of them is registered for
   * cleanup. `nav` fires on first load as well as on every client-side
   * navigation, and micromorph reuses the panel's DOM node rather than
   * replacing it — so a control wired once per `nav` without a matching
   * teardown ends up carrying two handlers, then three, and a click toggles
   * itself back. That is the mobile-nav Sections-button bug, and it is
   * invisible in the source.
   */
  function on(el, type, handler) {
    if (!el) return
    el.addEventListener(type, handler)
    if (window.addCleanup) window.addCleanup(() => el.removeEventListener(type, handler))
  }

  function wire() {
    for (const input of all("input[type=range]"))
      on(input, "input", () => push({ [input.dataset.key]: Number(input.value) }))
    for (const box of all("input[type=checkbox]"))
      on(box, "change", () => push({ [box.dataset.key]: box.checked }))

    const fontSelect = q("[data-key=font]")
    on(fontSelect, "change", () => push({ font: fontSelect.value }))

    for (const button of all("[data-preset]"))
      on(button, "click", () => {
        const preset = engine.PRESETS[button.dataset.preset]
        if (preset) push(preset, button.dataset.preset)
      })
    for (const button of all("[data-spread]"))
      on(button, "click", () => push({ spread: Number(button.dataset.spread) }))
    for (const button of all("[data-mode]")) on(button, "click", () => setMode(button.dataset.mode))

    on(q(".tp-reset"), "click", () => {
      ours = true
      engine.reset()
      ours = false
      working = null
      render()
    })
  }

  function setup() {
    panel = document.querySelector(".theme-panel")
    if (!panel) return
    working = null
    wire()
    render()
  }

  document.addEventListener("nav", setup)
  document.addEventListener("themechange", () => {
    engine.refresh()
    if (panel && panel.isConnected) render()
  })
  window.addEventListener("symposium:theme-changed", () => {
    if (ours || !panel || !panel.isConnected) return
    working = null
    render()
  })
  setup()
})();