(function learningModeRuntime() {
  const KEY = "symposium:learning:v1"
  const PROGRESS_KEY = "symposium:progress:v1"
  const DAY = 86400000
  const MIN = 60000

  // A new card is not a review card until it has survived both steps in the same
  // sitting. Without them the first correct answer bought five days outright,
  // which is a bet on one recall of a card seen once.
  const LEARN_STEPS = [1, 10] // minutes
  const RELEARN_STEPS = [10] // minutes
  const GRADUATING = 5 // days — quantum.country's first gap, near enough
  const START_EASE = 2.3 // ~2.3x growth thereafter
  const EASY_BONUS = 1.3
  const HARD_MULT = 1.2

  const AGAIN = 0
  const HARD = 1
  const GOOD = 2
  const EASY = 3
  const GRADES = [
    { g: AGAIN, label: "Again", key: "1" },
    { g: HARD, label: "Hard", key: "2" },
    { g: GOOD, label: "Good", key: "3" },
    { g: EASY, label: "Easy", key: "4" },
  ]

  // Off by default. A first-time reader arrived to read, and a wiki that starts
  // quizzing people unasked is a wiki they leave; the toolbar control is how
  // they opt in. Hard mode is then a second, deliberate step inside that.
  const DEFAULTS = { on: false, hard: false, threshold: 60, newPerDay: 20, maxPerDay: 120 }

  const today = () => new Date().toISOString().slice(0, 10)
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 10)
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

  /**
   * A record written before learning steps existed has no `state`. It was graded
   * at least once and its interval was earned in whole days, so it is a review
   * card by definition — the migration adds fields and changes no schedule.
   */
  function migrate(entry) {
    if (!entry || entry.state) return entry
    return {
      ...entry,
      state: "review",
      step: null,
      dueAt: Date.parse(entry.due ?? today()) || Date.now(),
    }
  }

  function load() {
    try {
      const raw = window.localStorage.getItem(KEY)
      const s = raw ? JSON.parse(raw) : null
      const sched = {}
      for (const [id, entry] of Object.entries(s?.sched ?? {})) sched[id] = migrate(entry)
      return {
        enrolled: s?.enrolled ?? [],
        sched,
        daily: s?.daily ?? null,
        settings: { ...DEFAULTS, ...(s?.settings ?? {}) },
      }
    } catch {
      return { enrolled: [], sched: {}, daily: null, settings: { ...DEFAULTS } }
    }
  }

  function save(state) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state))
    } catch {
      /* private browsing, quota, or a locked-down profile — nothing to do */
    }
  }

  const reviewedAt = (entry) =>
    Number(entry?.reviewedAt ?? entry?.seenAt ?? Date.parse(entry?.seen ?? "")) || 0

  function mergeLearning(state, incoming) {
    state.enrolled = [...new Set([...(state.enrolled ?? []), ...(incoming?.enrolled ?? [])])].sort()
    for (const [id, entry] of Object.entries(incoming?.sched ?? {})) {
      const mine = state.sched[id]
      if (!mine || reviewedAt(entry) > reviewedAt(mine)) state.sched[id] = migrate(entry)
    }
    return state
  }

  function loadProgress() {
    try {
      const value = JSON.parse(window.localStorage.getItem(PROGRESS_KEY) || "null")
      return value && typeof value === "object" ? value : { version: 1, pages: {}, trail: [], seeded: false }
    } catch {
      return { version: 1, pages: {}, trail: [], seeded: false }
    }
  }

  function mergeProgress(local, incoming) {
    const out = { version: 1, pages: { ...(local?.pages ?? {}) }, trail: [], seeded: !!(local?.seeded || incoming?.seeded) }
    const rank = { unseen: 0, seen: 1, read: 2 }
    for (const [slug, entry] of Object.entries(incoming?.pages ?? {})) {
      const mine = out.pages[slug]
      if (!mine) { out.pages[slug] = entry; continue }
      out.pages[slug] = {
        ...mine, ...entry,
        tier: (rank[entry?.tier] ?? 0) > (rank[mine?.tier] ?? 0) ? entry.tier : mine.tier,
        firstSeen: Math.min(mine.firstSeen ?? Infinity, entry.firstSeen ?? Infinity),
        lastSeen: Math.max(mine.lastSeen ?? 0, entry.lastSeen ?? 0),
        dwell: Math.max(mine.dwell ?? 0, entry.dwell ?? 0),
        scroll: Math.max(mine.scroll ?? 0, entry.scroll ?? 0),
        visits: Math.max(mine.visits ?? 0, entry.visits ?? 0),
      }
    }
    const cutoff = Date.now() - 90 * DAY
    const seen = new Set()
    out.trail = [...(local?.trail ?? []), ...(incoming?.trail ?? [])]
      .filter((entry) => entry?.slug && (entry.at ?? 0) >= cutoff)
      .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
      .filter((entry) => {
        const key = `${entry.slug}:${entry.at}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    return out
  }

  /** Today's counters, rolled over the moment the date changes. */
  function daily(state) {
    const d = today()
    if (state.daily?.date !== d) state.daily = { date: d, introduced: 0, reviewed: 0 }
    return state.daily
  }

  // ---- the scheduler -------------------------------------------------------
  /**
   * SM-2 over four grades and a small state machine: new -> learning -> review,
   * and review -> relearning -> review on a lapse. Pure, so the review page can
   * call it speculatively to print what each button costs.
   */
  function schedule(prev, g) {
    const now = Date.now()
    const s = prev
      ? { ...prev }
      : { reps: 0, ivl: 0, ef: START_EASE, lapses: 0, state: "new", step: null }
    if (!s.state) {
      s.state = "review"
      s.step = null
    }

    const setDue = (ms) => {
      s.dueAt = now + ms
      s.due = stamp(s.dueAt)
    }
    const graduate = (days) => {
      s.state = "review"
      s.step = null
      s.ivl = Math.max(1, Math.round(days))
      setDue(s.ivl * DAY)
    }
    const hold = (steps, i) => {
      s.step = clamp(i, 0, steps.length - 1)
      setDue(steps[s.step] * MIN)
    }

    if (s.state === "new" || s.state === "learning") {
      // showing a new card *is* step 0 — it has already served the first step by
      // the time the reader grades it, so Good advances rather than entering.
      // Treating "new" as before-step-0 would cost every card an extra rep.
      const at = s.state === "new" ? 0 : s.step ?? 0
      if (g === AGAIN) {
        s.state = "learning"
        hold(LEARN_STEPS, 0)
      } else if (g === EASY) {
        graduate(GRADUATING * EASY_BONUS)
      } else if (g === HARD) {
        s.state = "learning"
        hold(LEARN_STEPS, at)
      } else if (at + 1 >= LEARN_STEPS.length) {
        graduate(GRADUATING)
      } else {
        s.state = "learning"
        hold(LEARN_STEPS, at + 1)
      }
    } else if (s.state === "relearning") {
      const at = s.step ?? 0
      if (g === AGAIN) hold(RELEARN_STEPS, 0)
      else if (g === EASY) graduate(Math.max(1, s.ivl))
      else if (g === HARD) hold(RELEARN_STEPS, at)
      else if (at + 1 >= RELEARN_STEPS.length) graduate(Math.max(1, s.ivl))
      else hold(RELEARN_STEPS, at + 1)
    } else if (g === AGAIN) {
      s.lapses += 1
      s.ef = Math.max(1.3, s.ef - 0.2)
      // the interval survives a lapse at half itself. A card held for ninety days
      // and dropped once is not a card that has never been seen, and sending it
      // back to zero is how a single bad afternoon costs a month of schedule.
      s.ivl = Math.max(1, Math.round(s.ivl * 0.5))
      s.state = "relearning"
      hold(RELEARN_STEPS, 0)
    } else {
      const mult = g === HARD ? HARD_MULT : g === EASY ? s.ef * EASY_BONUS : s.ef
      const grown = Math.max(s.ivl + 1, s.ivl * mult)
      s.ef = clamp(s.ef + (g === HARD ? -0.15 : g === EASY ? 0.15 : 0.05), 1.3, 2.8)
      graduate(grown)
    }

    if (g > AGAIN) s.reps += 1
    s.seen = today()
    s.seenAt = now
    s.reviewedAt = now
    return s
  }

  /**
   * Learning cards are due to the minute; review cards are due to the day. Both
   * matter: a ten-minute step that only came back at midnight would not be a
   * step, and a review scheduled at 3pm that only reappeared at 3pm the next day
   * would be missing from tomorrow morning's session.
   */
  function isDue(entry) {
    if (!entry) return true // never seen — a new card, and new cards are capped
    if (entry.state === "learning" || entry.state === "relearning") {
      return (entry.dueAt ?? 0) <= Date.now()
    }
    return (entry.due ?? "") <= today()
  }

  function shortIvl(entry) {
    if (entry.state === "learning" || entry.state === "relearning") {
      const mins = Math.max(1, Math.round(((entry.dueAt ?? 0) - Date.now()) / MIN))
      return mins >= 60 ? Math.round(mins / 60) + "h" : mins + "m"
    }
    const d = entry.ivl
    if (d >= 365) return Math.round((d / 365) * 10) / 10 + "y"
    if (d >= 30) return Math.round(d / 30) + "mo"
    return d + "d"
  }

  function dueLabel(entry) {
    if (!entry) return "new"
    if (entry.state === "learning" || entry.state === "relearning") {
      const mins = Math.round(((entry.dueAt ?? 0) - Date.now()) / MIN)
      return mins <= 0 ? "due now" : "due in " + mins + " min"
    }
    const days = Math.round((Date.parse(entry.due) - Date.parse(today())) / DAY)
    if (days <= 0) return "due now"
    if (days === 1) return "due tomorrow"
    return "due in " + days + " days"
  }

  const stateOf = (entry) => entry?.state ?? "new"

  // ---- the card index ------------------------------------------------------
  // Quartz stamps the site's path prefix on <body>, which is what makes this
  // correct at judzos.github.io/symposium as well as on a dev server at /.
  function base() {
    return (document.body.dataset.basepath ?? "").replace(/\/$/, "")
  }

  let indexPromise = null
  function cards() {
    if (!indexPromise) {
      indexPromise = fetch(base() + "/static/cards.json")
        .then((r) => (r.ok ? r.json() : { cards: [] }))
        .catch(() => ({ cards: [] }))
    }
    return indexPromise
  }

  function el(tag, props, ...children) {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(props ?? {})) {
      if (k === "class") node.className = v
      else if (k === "text") node.textContent = v
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v)
      else node.setAttribute(k, v)
    }
    for (const c of children) if (c) node.appendChild(c)
    return node
  }

  /**
   * One grade button, carrying the interval it buys. Four buttons a reader
   * cannot tell apart are worse than two they can, so the cost is printed on
   * each — and the digit that presses it, because the keyboard is the whole
   * difference between reviewing forty cards and reviewing four.
   */
  function gradeButton(entry, spec, onPick, withKey) {
    return el(
      "button",
      { class: "lm-btn lm-g lm-g" + spec.g, type: "button", onclick: () => onPick(spec.g) },
      el("span", { text: spec.label }),
      el("span", { class: "lm-ivl", text: shortIvl(schedule(entry, spec.g)) }),
      withKey ? el("span", { class: "lm-key", text: spec.key }) : null,
    )
  }

  function gradeButtons(entry, onPick, withKey) {
    return GRADES.map((spec) => gradeButton(entry, spec, onPick, withKey))
  }

  // ---- folding -------------------------------------------------------------
  // Quartz's own callout script toggles `is-collapsed` and sets the content's
  // grid rows; hard mode drives the same two things rather than fighting them,
  // so a card the reader folds by hand and one the gate folds look identical.
  function fold(block, open) {
    const content = block.querySelector(".callout-content")
    block.classList.toggle("is-collapsed", !open)
    if (content) content.style.gridTemplateRows = open ? "1fr" : "0fr"
  }

  // ---- matching DOM cards to index cards -----------------------------------
  function entriesOnPage(index) {
    const slug = document.body.dataset.slug ?? ""
    const onPage = index.cards.filter((c) => c.slug === slug)
    const out = []
    document.querySelectorAll('[data-callout="card"]').forEach((block, i) => {
      const prompt = (block.querySelector(".callout-title-inner")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
      const card = onPage.find((c) => c.prompt === prompt) ?? onPage[i] ?? null
      if (card) out.push({ card, block })
    })
    return out
  }

  // ---- grading in the prose, learning mode on, hard mode off ---------------
  function wireSoft(state, entries) {
    for (const { card, block } of entries) {
      const content = block.querySelector(".callout-content")
      if (!content || content.querySelector(".lm-grade")) continue
      const bar = el("div", { class: "lm-grade" })
      const status = el("span", { class: "lm-due", text: dueLabel(state.sched[card.id]) })
      const paint = () => {
        bar.textContent = ""
        const mark = (g) => {
          const fresh = !state.sched[card.id]
          state.sched[card.id] = schedule(state.sched[card.id], g)
          const d = daily(state)
          if (fresh) d.introduced += 1
          d.reviewed += 1
          save(state)
          status.textContent = dueLabel(state.sched[card.id])
          paint()
        }
        for (const b of gradeButtons(state.sched[card.id], mark, false)) bar.appendChild(b)
        bar.appendChild(status)
      }
      paint()
      content.appendChild(bar)
    }
  }

  // ---- hard mode -----------------------------------------------------------
  // The wall falls at every card: the prose below a card is hidden until that
  // card has been answered, and the tail of the page stays hidden until the
  // page's score clears the threshold. Answering is what opens a checkpoint —
  // a grade of Again still lets you read on, it just costs against the score.
  function wireHard(state, entries, article) {
    // a card outside the article — there is no prose below it to hold back, and
    // a gate that veils the wrong half of a page is worse than no gate at all
    if (entries.some((e) => !article.contains(e.block))) return false

    // Whether a card was already settled *before this visit* is a snapshot,
    // not a live read: grading during the visit must not feed back into the
    // gate, or retrying a card you just missed would unlock itself.
    const settled = new Set(entries.filter((e) => !isDue(state.sched[e.card.id])).map((e) => e.card.id))
    const visit = {} // cardId -> grade, this visit only
    const threshold = state.settings.threshold

    const answered = (e) => e.card.id in visit || settled.has(e.card.id)
    // Hard is a pass. It means recalled, slowly — the pass mark asks whether the
    // page landed, and a card you laboured over did land.
    const right = (e) => (e.card.id in visit ? visit[e.card.id] > AGAIN : settled.has(e.card.id))
    const scored = () => entries.filter(right).length
    const percent = () => Math.round((scored() / entries.length) * 100)

    // Quartz wraps the prose in a div inside <article>, and a card can sit a
    // level deeper again inside a list. So the veil is not "the children of
    // some root" — it is everything that follows the card in document order,
    // taken one nesting level at a time. That holds whatever the wrappers do.
    const veilAfter = (node) => {
      let n = node
      while (n && n !== article) {
        for (let s = n.nextElementSibling; s; s = s.nextElementSibling) {
          if (!s.classList.contains("lm-lock")) s.classList.add("lm-veiled")
        }
        n = n.parentElement
      }
    }

    const repaint = () => {
      article.querySelectorAll(".lm-veiled").forEach((n) => n.classList.remove("lm-veiled"))
      article.querySelectorAll(".lm-lock, .lm-pass").forEach((n) => n.remove())

      const pending = entries.find((e) => !answered(e))
      const passed = percent() >= threshold
      const anchor = pending ? pending.block : passed ? null : entries[entries.length - 1].block
      if (anchor) {
        veilAfter(anchor)
        anchor.after(pending ? lockPanel(pending) : scorePanel())
      } else if (Object.keys(visit).length) {
        entries[entries.length - 1].block.after(
          el(
            "div",
            { class: "lm-pass" },
            el(
              "p",
              {},
              el("strong", { text: percent() + "%" }),
              el("span", { text: " — the rest of the page is open." }),
            ),
          ),
        )
      }
    }

    const lockPanel = (pending) => {
      const n = entries.indexOf(pending) + 1
      return el(
        "div",
        { class: "lm-lock" },
        el(
          "p",
          {},
          el("strong", { text: "The rest of this page is behind this card." }),
          el("span", {
            text:
              " Answer it to read on — card " +
              n +
              " of " +
              entries.length +
              ", and " +
              threshold +
              "% of them to finish the page.",
          }),
        ),
      )
    }

    const scorePanel = () => {
      const missed = entries.filter((e) => visit[e.card.id] === AGAIN)
      const panel = el(
        "div",
        { class: "lm-lock" },
        el(
          "p",
          {},
          el("strong", { text: percent() + "% — this page needs " + threshold + "%." }),
          el("span", {
            text:
              " You remembered " +
              scored() +
              " of " +
              entries.length +
              ". Answer the " +
              missed.length +
              " you missed again to unlock the rest.",
          }),
        ),
      )
      panel.appendChild(
        el(
          "div",
          { class: "lm-bar" },
          el("button", {
            class: "lm-btn",
            type: "button",
            text:
              missed.length === 1
                ? "Retry the one you missed"
                : "Retry the " + missed.length + " you missed",
            onclick: () => {
              for (const e of missed) {
                delete visit[e.card.id]
                fold(e.block, false)
                paintBar(e)
              }
              repaint()
              missed[0]?.block.scrollIntoView?.({ behavior: "smooth", block: "center" })
            },
          }),
        ),
      )
      return panel
    }

    // one bar per card, inside the callout but outside .callout-content, so it
    // is still there to click while the answer is folded away
    const paintBar = (e) => {
      e.bar.textContent = ""
      const status = el("span", { class: "lm-due", text: dueLabel(state.sched[e.card.id]) })
      if (answered(e)) {
        const g = visit[e.card.id]
        e.bar.appendChild(
          el("span", { text: e.card.id in visit ? GRADES[g].label : "answered" }),
        )
        e.bar.appendChild(status)
        // a card settled in an earlier session is not due, so the gate lets it
        // through — but a reader re-reading the page may still want the test,
        // and refusing it would make hard mode a dead end on every revisit
        if (!(e.card.id in visit)) {
          e.bar.appendChild(
            el("button", {
              class: "lm-btn",
              type: "button",
              text: "Test again",
              onclick: () => {
                settled.delete(e.card.id)
                fold(e.block, false)
                paintBar(e)
                repaint()
              },
            }),
          )
        }
        return
      }
      const mark = (g) => {
        const fresh = !state.sched[e.card.id]
        visit[e.card.id] = g
        state.sched[e.card.id] = schedule(state.sched[e.card.id], g)
        const d = daily(state)
        if (fresh) d.introduced += 1
        d.reviewed += 1
        save(state)
        paintBar(e)
        repaint()
      }
      e.bar.appendChild(
        el("button", {
          class: "lm-btn",
          type: "button",
          text: "Show answer",
          onclick: () => {
            fold(e.block, true)
            e.bar.textContent = ""
            for (const b of gradeButtons(state.sched[e.card.id], mark, false)) e.bar.appendChild(b)
            e.bar.appendChild(status)
          },
        }),
      )
      e.bar.appendChild(status)
    }

    for (const e of entries) {
      e.bar = el("div", { class: "lm-cardbar" })
      e.block.appendChild(e.bar)
      if (!answered(e)) {
        // a card authored expanded — `[!card]` without the `-` — has no fold
        // control of its own, so leaving it folded when the mode goes off would
        // strand its answer. Mark it, and let teardown put it back.
        if (!e.block.classList.contains("is-collapsible")) e.block.dataset.lmFolded = "1"
        fold(e.block, false)
      }
      paintBar(e)
    }
    repaint()
    return true
  }

  // ---- enrolment ----------------------------------------------------------
  // Per-page is precise and tedious; per-topic exploits the hub-and-spoke shape
  // and is far less clicking. Both, with the grouping as the primary control.
  function scopeFor(index) {
    const slug = document.body.dataset.slug ?? ""
    const parts = slug.split("/")
    if (parts[0] === "sections" && parts[parts.length - 1] === "index" && parts.length === 3) {
      const section = parts[1]
      return {
        label: "this section",
        slugs: [...new Set(index.cards.filter((c) => c.section === section).map((c) => c.slug))],
      }
    }
    if (slug.includes("/topics/")) {
      const under = index.cards.filter((c) => (c.parents ?? []).includes(slug)).map((c) => c.slug)
      const self = index.cards.filter((c) => c.slug === slug).map((c) => c.slug)
      const slugs = [...new Set([...self, ...under])]
      if (slugs.length) return { label: "this topic", slugs }
    }
    const own = index.cards.filter((c) => c.slug === slug)
    return own.length ? { label: "this page", slugs: [slug] } : null
  }

  function enrolControl(state, index, count) {
    const scope = scopeFor(index)
    if (!scope) return null
    // a section scope holds 210 slugs against 1,111 cards, and this runs on every
    // page load — the sets are not premature, they are the difference between a
    // free control and a visible one on a phone
    const inScope = new Set(scope.slugs)
    const isOn = () => {
      const have = new Set(state.enrolled)
      return scope.slugs.every((s) => have.has(s))
    }
    const button = el("button", { class: "lm-btn", type: "button" })
    const note = el("span", {})
    const cardsInScope = index.cards.reduce((n, c) => n + (inScope.has(c.slug) ? 1 : 0), 0)
    const paint = () => {
      button.textContent = (isOn() ? "★ Learning " : "☆ Learn ") + scope.label
      button.setAttribute("aria-pressed", isOn() ? "true" : "false")
      // enrolling a section is a commitment measured in weeks, not clicks — say
      // how many so it is a decision rather than a surprise on /review
      if (scope.slugs.length > 1) {
        const days = Math.ceil(cardsInScope / Math.max(1, state.settings.newPerDay))
        note.textContent =
          scope.slugs.length +
          " pages · " +
          cardsInScope +
          " cards · about " +
          days +
          (days === 1 ? " day" : " days") +
          " to introduce at " +
          state.settings.newPerDay +
          "/day"
      } else {
        note.textContent = count + (count === 1 ? " card on this page" : " cards on this page")
      }
    }
    button.addEventListener("click", () => {
      const on = isOn()
      const set = new Set(state.enrolled)
      for (const s of scope.slugs) on ? set.delete(s) : set.add(s)
      state.enrolled = [...set].sort()
      save(state)
      paint()
    })
    paint()

    return el(
      "div",
      { class: "lm-panel" },
      button,
      note,
      el("a", { class: "lm-due", href: base() + "/review", text: "review queue →" }),
    )
  }

  // ---- the toolbar control -------------------------------------------------
  // The loader binds one component per plugin entry, so a second component in
  // the toolbar group is not expressible in quartz.config.yaml. Injecting next
  // to an existing toolbar member is the way in; it degrades to the sidebar if
  // that member is ever turned off.
  function toolbarHome() {
    const anchor = document.querySelector(".left button.darkmode, .left .search-button")
    const slot = anchor?.closest(".flex-component > *")
    if (slot?.parentElement) return { parent: slot.parentElement, style: slot.getAttribute("style") }
    const sidebar = document.querySelector(".left.sidebar")
    return sidebar ? { parent: sidebar, style: null } : null
  }

  const CAP_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"/></svg>'

  function numberRow(id, label, hint, get, set, lo, hi, step) {
    const input = el("input", {
      class: "lm-num",
      type: "number",
      min: String(lo),
      max: String(hi),
      step: String(step),
      id,
    })
    input.value = String(get())
    const commit = () => {
      const n = clamp(Math.round(Number(input.value)), lo, hi)
      input.value = String(Number.isFinite(n) ? n : get())
      set(Number(input.value))
    }
    input.addEventListener("change", commit)
    input.addEventListener("blur", commit)
    return {
      input,
      rows: [
        el("div", { class: "lm-row lm-needs-on" }, el("label", { for: id, text: label }), input),
        el("p", { class: "lm-hint", text: hint }),
      ],
    }
  }

  function toolbar(state, index, onChange) {
    document.getElementById("lm-toolbar")?.remove()
    const home = toolbarHome()
    if (!home) return

    const wrap = el("div", { class: "lm-toolbar", id: "lm-toolbar" })
    const toggle = el("button", { class: "lm-toggle", type: "button", "aria-label": "Learning mode" })
    toggle.innerHTML = CAP_ICON
    const more = el("button", {
      class: "lm-more",
      type: "button",
      text: "▾",
      "aria-label": "Learning mode settings",
      "aria-expanded": "false",
    })
    const pop = el("div", { class: "lm-pop", hidden: "" })

    const commit = () => {
      save(state)
      paint()
      onChange()
    }

    const onBox = el("input", { type: "checkbox", id: "lm-on" })
    onBox.checked = state.settings.on
    onBox.addEventListener("change", () => {
      state.settings.on = onBox.checked
      commit()
    })
    toggle.addEventListener("click", () => {
      state.settings.on = !state.settings.on
      onBox.checked = state.settings.on
      commit()
    })

    const hard = el("input", { type: "checkbox", id: "lm-hard" })
    hard.checked = state.settings.hard
    hard.addEventListener("change", () => {
      state.settings.hard = hard.checked
      commit()
    })

    const thr = numberRow(
      "lm-thr",
      "Pass mark",
      "Share of a page's cards you must remember before the tail unlocks.",
      () => state.settings.threshold,
      (n) => {
        state.settings.threshold = n
        commit()
      },
      0,
      100,
      5,
    )
    const fresh = numberRow(
      "lm-new",
      "New cards / day",
      "How many unseen cards enter the queue each day. The wiki holds far more than anyone can meet at once.",
      () => state.settings.newPerDay,
      (n) => {
        state.settings.newPerDay = n
        commit()
      },
      0,
      200,
      5,
    )
    const cap = numberRow(
      "lm-max",
      "Reviews / day",
      "Ceiling on cards already learned. 0 lifts it.",
      () => state.settings.maxPerDay,
      (n) => {
        state.settings.maxPerDay = n
        commit()
      },
      0,
      999,
      10,
    )

    const paint = () => {
      const on = state.settings.on
      toggle.setAttribute("aria-pressed", on ? "true" : "false")
      toggle.title = on
        ? state.settings.hard
          ? "Learning mode: hard (" + state.settings.threshold + "% to continue)"
          : "Learning mode: on"
        : "Learning mode: off"
      pop.querySelectorAll(".lm-row.lm-needs-on").forEach((r) => r.classList.toggle("is-off", !on))
      hard.disabled = !on
      thr.input.disabled = !on || !state.settings.hard
      fresh.input.disabled = !on
      cap.input.disabled = !on
    }

    const here = index.cards.filter((c) => c.slug === (document.body.dataset.slug ?? "")).length
    pop.append(
      el("h4", { text: "Learning mode" }),
      el("div", { class: "lm-row" }, el("label", { for: "lm-on", text: "Cards and scheduling" }), onBox),
      el("p", {
        class: "lm-hint",
        text: "Grade cards where they sit in the prose; they come back over expanding intervals.",
      }),
      ...fresh.rows,
      ...cap.rows,
      el("div", { class: "lm-row lm-needs-on" }, el("label", { for: "lm-hard", text: "Hard mode" }), hard),
      el("p", { class: "lm-hint", text: "Hold the rest of a page back until its cards are answered." }),
      ...thr.rows,
      el(
        "p",
        { class: "lm-foot" },
        el("span", { text: here ? here + (here === 1 ? " card here" : " cards here") : "no cards here" }),
        el("a", { href: base() + "/review", text: "review queue →" }),
      ),
    )

    const close = () => {
      pop.hidden = true
      more.setAttribute("aria-expanded", "false")
    }
    const onKey = (ev) => ev.key === "Escape" && close()
    more.addEventListener("click", (ev) => {
      ev.stopPropagation()
      pop.hidden = !pop.hidden
      more.setAttribute("aria-expanded", pop.hidden ? "false" : "true")
    })
    pop.addEventListener("click", (ev) => ev.stopPropagation())
    // these two live on document, so they outlive the control unless Quartz is
    // told to drop them on the next SPA navigation
    document.addEventListener("click", close)
    document.addEventListener("keydown", onKey)
    window.addCleanup?.(() => {
      document.removeEventListener("click", close)
      document.removeEventListener("keydown", onKey)
    })

    wrap.append(toggle, more, pop)
    paint()

    if (home.style) {
      const slot = el("div", { class: "lm-slot" })
      slot.setAttribute("style", home.style)
      slot.appendChild(wrap)
      home.parent.appendChild(slot)
    } else {
      home.parent.appendChild(wrap)
    }
  }

  // ---- building the day's session ------------------------------------------
  /**
   * Deal round-robin across pages. The index is sorted by slug, so a straight
   * filter hands back thirty consecutive cards off one concept page — which is
   * drilling a page, not reviewing a section, and buys none of the interference
   * that makes spaced practice work in the first place.
   */
  function interleave(list) {
    const lanes = new Map()
    for (const c of list) {
      if (!lanes.has(c.slug)) lanes.set(c.slug, [])
      lanes.get(c.slug).push(c)
    }
    const out = []
    const rows = [...lanes.values()]
    for (let i = 0; out.length < list.length; i++) {
      for (const row of rows) if (i < row.length) out.push(row[i])
    }
    return out
  }

  /**
   * Learning first — those are on a one-to-ten-minute timer and are the only
   * cards mid-acquisition. Then reviews, then whatever new cards the day still
   * has room for. Learning steps are never capped: capping them would abandon a
   * card halfway into being learned, which is worse than never starting it.
   */
  function session(state, pool) {
    const d = daily(state)
    const sched = state.sched
    const inState = (names) => pool.filter((c) => sched[c.id] && names.includes(sched[c.id].state) && isDue(sched[c.id]))

    const learning = inState(["learning", "relearning"])
    const reviews = inState(["review"])
    const unseen = pool.filter((c) => !sched[c.id])

    // cards mid-step whose minute has not arrived. They are not in the queue and
    // they are not finished either, and without this the session would declare
    // itself over while the card you just failed is ninety seconds away.
    const pending = pool
      .filter((c) => {
        const s = sched[c.id]
        return s && (s.state === "learning" || s.state === "relearning") && !isDue(s)
      })
      .map((c) => sched[c.id].dueAt ?? 0)

    const reviewRoom =
      state.settings.maxPerDay > 0 ? Math.max(0, state.settings.maxPerDay - d.reviewed) : reviews.length
    const newRoom = Math.max(0, state.settings.newPerDay - d.introduced)

    return {
      queue: [
        ...learning,
        ...interleave(reviews).slice(0, reviewRoom),
        ...interleave(unseen).slice(0, newRoom),
      ],
      learning: learning.length,
      reviews: reviews.length,
      unseen: unseen.length,
      soon: pending.length,
      soonest: pending.length ? Math.min(...pending) : 0,
      held: Math.max(0, reviews.length - reviewRoom) + Math.max(0, unseen.length - newRoom),
      introduced: d.introduced,
      reviewed: d.reviewed,
    }
  }

  // ---- the /review session -------------------------------------------------
  function renderReview(state, index, root, onChange) {
    const enrolled = new Set(state.enrolled)
    const pool = index.cards.filter((c) => enrolled.has(c.slug))
    // counted across this page-load only — the daily totals live in state, but
    // "how did the last twenty minutes go" is a property of the sitting
    const sitting = { done: 0, kept: 0, started: Date.now() }
    let plan = session(state, pool)
    let total = plan.queue.length
    let keyHandler = null
    let wake = null

    const detachKeys = () => {
      if (keyHandler) document.removeEventListener("keydown", keyHandler)
      keyHandler = null
      if (wake) window.clearTimeout(wake)
      wake = null
    }
    const attachKeys = (handler) => {
      detachKeys()
      keyHandler = (ev) => {
        if (ev.metaKey || ev.ctrlKey || ev.altKey) return
        const t = ev.target
        if (t instanceof HTMLElement && t.closest("input, textarea, select, [contenteditable]")) return
        if (handler(ev)) ev.preventDefault()
      }
      document.addEventListener("keydown", keyHandler)
    }
    window.addCleanup?.(detachKeys)

    const paint = () => {
      root.textContent = ""
      detachKeys()

      if (!state.settings.on) {
        root.appendChild(
          el(
            "div",
            { class: "lm-panel" },
            el("strong", { text: "Learning mode is off." }),
            el("span", {
              text:
                index.cards.length +
                " cards are written across " +
                (index.pages ?? 0) +
                " pages. Nothing is scheduled and no page holds you back until you turn it on.",
            }),
            el("button", {
              class: "lm-btn",
              type: "button",
              text: "Turn it on",
              onclick: () => {
                state.settings.on = true
                save(state)
                onChange()
              },
            }),
          ),
        )
        // an empty queue is the normal first visit, so say where the cards are
        // rather than leaving the page looking like the feature does not exist
        root.appendChild(startingPoints(index))
        root.appendChild(exportBar(state))
        return
      }

      const summary = el(
        "div",
        { class: "lm-panel" },
        el("span", { text: pool.length + " enrolled" }),
        el("strong", { text: plan.queue.length + " left today" }),
        el("span", {
          text:
            plan.reviews +
            " due · " +
            Math.max(0, state.settings.newPerDay - plan.introduced) +
            " new left of " +
            state.settings.newPerDay,
        }),
        plan.held
          ? el("span", { class: "lm-due", text: plan.held + " held back for later days" })
          : null,
      )
      root.appendChild(summary)

      if (!pool.length) {
        root.appendChild(
          el("p", {
            class: "lm-empty",
            text:
              "Nothing enrolled yet. Open a page carrying cards and press ☆ Learn — or " +
              "enrol a whole section from its hub.",
          }),
        )
        root.appendChild(startingPoints(index))
        root.appendChild(exportBar(state))
        return
      }

      if (!plan.queue.length) {
        root.appendChild(finished(state, plan, sitting))
        root.appendChild(exportBar(state))
        root.appendChild(enrolledList(state, pool, paint))
        // a card on a one-minute step is not a reason to make the reader reload;
        // wake when the soonest one lands and the queue will have it
        if (plan.soon) {
          wake = window.setTimeout(() => {
            plan = session(state, pool)
            paint()
          }, Math.max(1000, plan.soonest - Date.now() + 500))
        }
        return
      }

      const card = plan.queue[0]
      const entry = state.sched[card.id]
      const done = Math.max(0, total - plan.queue.length)
      const bar = el("div", { class: "lm-bar" })
      const answer = el("p", { class: "lm-answer", text: card.answer })
      answer.style.display = "none"

      const advance = (g) => {
        const wasNew = !state.sched[card.id]
        state.sched[card.id] = schedule(state.sched[card.id], g)
        const d = daily(state)
        if (wasNew) d.introduced += 1
        d.reviewed += 1
        sitting.done += 1
        if (g > AGAIN) sitting.kept += 1
        save(state)
        // rebuilt rather than shifted: a card graded Again is due again in a
        // minute, and the queue is the only thing that knows whether that minute
        // has passed. Recomputing is also what keeps the day caps honest.
        plan = session(state, pool)
        total = Math.max(total, done + 1 + plan.queue.length)
        paint()
      }

      const reveal = () => {
        answer.style.display = ""
        bar.textContent = ""
        for (const b of gradeButtons(entry, advance, true)) bar.appendChild(b)
        attachKeys((ev) => {
          const spec = GRADES.find((s) => s.key === ev.key)
          if (!spec) return false
          advance(spec.g)
          return true
        })
      }

      bar.appendChild(el("button", { class: "lm-btn", type: "button", text: "Show answer", onclick: reveal }))
      bar.appendChild(el("span", { class: "lm-key", text: "space" }))
      attachKeys((ev) => {
        if (ev.key !== " " && ev.key !== "Enter") return false
        reveal()
        return true
      })

      const kind = stateOf(entry)
      const credit = card.authors?.length ? " · " + card.authors.join(", ") : ""
      const progress = el("div", { class: "lm-progress" })
      progress.appendChild(
        el("div", { style: "width:" + Math.round((done / Math.max(1, total)) * 100) + "%" }),
      )

      root.appendChild(progress)
      root.appendChild(
        el(
          "div",
          { class: "lm-card" },
          el(
            "p",
            { class: "lm-source", style: "margin:0 0 0.9rem;padding:0;border:0;" },
            el("span", { class: "lm-tag lm-tag-" + kind, text: kind }),
            el("span", { text: " " + (done + 1) + " of " + total }),
          ),
          el("p", { class: "lm-prompt", text: card.prompt }),
          answer,
          bar,
          el(
            "p",
            { class: "lm-source" },
            el("a", { href: base() + "/" + card.slug, text: card.title }),
            el("span", { text: credit }),
          ),
        ),
      )
      root.appendChild(exportBar(state))
      root.appendChild(enrolledList(state, pool, paint))
    }
    paint()
  }

  /**
   * The end of a capped session is a real event — under the old uncapped queue
   * there was no such thing, because the queue was every card you had enrolled.
   */
  function finished(state, plan, sitting) {
    const wrap = el("div", { class: "lm-done" })
    const waiting = plan.soon
      ? plan.soon +
        (plan.soon === 1 ? " card comes back in " : " cards come back in ") +
        Math.max(1, Math.round((plan.soonest - Date.now()) / MIN)) +
        " min."
      : ""

    if (!sitting.done) {
      wrap.appendChild(
        el("p", {
          class: "lm-empty",
          text:
            waiting ||
            (plan.held
              ? "Nothing left for today. " + plan.held + " cards are waiting on tomorrow's allowance."
              : "Nothing due. Come back tomorrow."),
        }),
      )
      return wrap
    }
    const mins = Math.max(1, Math.round((Date.now() - sitting.started) / MIN))
    const pct = Math.round((sitting.kept / sitting.done) * 100)
    wrap.appendChild(el("p", { class: "lm-figure", text: sitting.done + " cards · " + pct + "% kept" }))
    wrap.appendChild(
      el("p", {
        class: "lm-meta",
        text:
          mins +
          (mins === 1 ? " minute" : " minutes") +
          ". " +
          (waiting ||
            (plan.held
              ? plan.held + " more are held for tomorrow — the cap is what keeps a section learnable."
              : "That is the whole of today's queue.")),
      }),
    )
    return wrap
  }

  function exportBar(state) {
    const bar = el("div", { class: "lm-bar" })
    bar.appendChild(
      el("button", {
        class: "lm-btn",
        type: "button",
        text: "Export progress",
        onclick: () => {
          const bundle = { format: "symposium-progress", version: 1, exportedAt: Date.now(), learning: state, progress: loadProgress() }
          const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" })
          const a = el("a", { href: URL.createObjectURL(blob), download: "symposium-progress.json" })
          document.body.appendChild(a)
          a.click()
          a.remove()
        },
      }),
    )
    const file = el("input", { type: "file", accept: "application/json" })
    file.style.display = "none"
    file.addEventListener("change", async () => {
      const f = file.files?.[0]
      if (!f) return
      try {
        const incoming = JSON.parse(await f.text())
        const learning = incoming.learning ?? incoming // legacy learning-only export
        if (!learning || typeof learning !== "object") throw new Error("not a learning export")
        mergeLearning(state, learning)
        if (incoming.progress) {
          window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(mergeProgress(loadProgress(), incoming.progress)))
        }
        // settings and today's counters are not imported: which mode this browser
        // reads in, and how much of today it has already spent, are properties of
        // the browser rather than of the schedule being carried into it
        save(state)
        window.location.reload()
      } catch {
        window.alert("That file is not a Symposium learning export.")
      }
    })
    bar.appendChild(el("button", { class: "lm-btn", type: "button", text: "Import", onclick: () => file.click() }))
    bar.appendChild(file)
    bar.appendChild(
      el("span", {
        class: "lm-meta",
        text: "Progress lives in this browser only. Export both cards and the reading map if it matters.",
      }),
    )
    return bar
  }

  /**
   * The queue is empty on every first visit, and an empty page reads as a broken
   * feature rather than an unenrolled one. Name the densest carded pages so there
   * is somewhere to go — computed from the index, so it cannot go stale the way a
   * hand-written list on review.md would.
   */
  function startingPoints(index) {
    const wrap = el("div", { class: "lm-enrolled" })
    if (!index.cards?.length) return wrap

    const byPage = new Map()
    for (const c of index.cards) {
      const row = byPage.get(c.slug) ?? { slug: c.slug, title: c.title, n: 0 }
      row.n += 1
      byPage.set(c.slug, row)
    }
    const top = [...byPage.values()].sort((a, b) => b.n - a.n || a.slug.localeCompare(b.slug)).slice(0, 8)

    // the hub enrols its whole section in one press, which is the cheapest way in
    const sections = [...new Set(index.cards.map((c) => c.section).filter(Boolean))]
    wrap.appendChild(el("strong", { text: "Where the cards are" }))
    const ul = el("ul")
    for (const s of sections) {
      const n = index.cards.filter((c) => c.section === s).length
      ul.appendChild(
        el(
          "li",
          {},
          el("a", { href: base() + "/sections/" + s + "/index", text: s.replace(/-/g, " ") }),
          el("span", { class: "lm-meta", text: " — section hub, " + n + " cards below it" }),
        ),
      )
    }
    for (const p of top) {
      ul.appendChild(
        el(
          "li",
          {},
          el("a", { href: base() + "/" + p.slug, text: p.title }),
          el("span", { class: "lm-meta", text: " " + p.n + " cards" }),
        ),
      )
    }
    wrap.appendChild(ul)
    return wrap
  }

  function enrolledList(state, pool, repaint) {
    const wrap = el("div", { class: "lm-enrolled" })
    if (!state.enrolled.length) return wrap
    wrap.appendChild(el("strong", { text: "Enrolled pages" }))
    const ul = el("ul")
    for (const slug of state.enrolled) {
      const n = pool.filter((c) => c.slug === slug).length
      ul.appendChild(
        el(
          "li",
          {},
          el("a", { href: base() + "/" + slug, text: slug.split("/").pop() }),
          el("span", { class: "lm-meta", text: " " + n + " cards " }),
          el("button", {
            class: "lm-btn",
            type: "button",
            text: "drop",
            onclick: () => {
              state.enrolled = state.enrolled.filter((s) => s !== slug)
              save(state)
              repaint()
            },
          }),
        ),
      )
    }
    wrap.appendChild(ul)
    return wrap
  }

  // ---- wiring -------------------------------------------------------------
  /** Undo everything we put on the page, so a settings change can re-run clean. */
  function teardown() {
    document
      .querySelectorAll(".lm-panel, .lm-grade, .lm-cardbar, .lm-lock, .lm-pass, #lm-review")
      .forEach((n) => n.remove())
    document.querySelectorAll(".lm-veiled").forEach((n) => n.classList.remove("lm-veiled"))
    document.querySelectorAll("[data-lm-folded]").forEach((b) => {
      delete b.dataset.lmFolded
      fold(b, true)
    })
  }

  async function setup() {
    teardown()
    const state = load()
    const index = await cards()
    // with no cards anywhere in the wiki there is no mode to be in, so the
    // control would be an inert switch — say nothing rather than promise a
    // feature the corpus cannot yet deliver
    if (!index.cards?.length) return

    const rerun = () => {
      teardown()
      page(state, index, rerun)
    }
    toolbar(state, index, rerun)
    page(state, index, rerun)
  }

  function page(state, index, rerun) {
    const center = document.querySelector(".center") ?? document.querySelector("article")?.parentElement
    if (!center) return

    if ((document.body.dataset.slug ?? "") === "review") {
      const root = el("div", { id: "lm-review" })
      center.appendChild(root)
      renderReview(state, index, root, rerun ?? (() => setup()))
      return
    }

    if (!state.settings.on) return

    const entries = entriesOnPage(index)
    const article = document.querySelector("article")
    const gated = entries.length && state.settings.hard && article && wireHard(state, entries, article)
    if (!gated) wireSoft(state, entries)

    const control = enrolControl(state, index, entries.length)
    if (control) center.appendChild(control)
  }

  document.addEventListener("nav", setup)
  document.addEventListener("render", setup)
})();