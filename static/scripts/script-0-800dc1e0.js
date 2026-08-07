(function progressRuntime() {
  const KEY = "symposium:progress:v1"
  // written by the community graph plugin on every nav, since long before this
  // existed. A flat set of slugs: no order, no duration. Enough to seed from.
  const LEGACY_KEY = "graph-visited"

  const DAY = 86400000
  const TRAIL_WINDOW = 90 * DAY

  // Half the estimated reading time, not all of it. Requiring the full estimate
  // sets the bar at cover-to-cover reading and pins a third of the corpus at the
  // cap, which is the one thing a per-page budget exists to avoid.
  const WPM = 220
  const SHARE = 0.5
  const DWELL_MIN = 15000
  const DWELL_MAX = 120000
  const SCROLL_TARGET = 0.8

  const TIERS = { unseen: 0, seen: 1, read: 2 }

  function budget(words) {
    const ms = ((SHARE * (Number(words) || 0)) / WPM) * 60000
    return Math.min(DWELL_MAX, Math.max(DWELL_MIN, Math.round(ms)))
  }

  const rank = (t) => TIERS[t] ?? 0

  /** Tiers only ever advance: re-reading updates the record, never the rung. */
  function higher(a, b) {
    return rank(b) > rank(a) ? b : a
  }

  function tierFor(rec, words) {
    if (!rec) return "unseen"
    const met = (rec.dwell ?? 0) >= budget(words) && (rec.scroll ?? 0) >= SCROLL_TARGET
    return higher(rec.tier ?? "seen", met ? "read" : "seen")
  }

  function blank() {
    return { version: 1, pages: {}, trail: [], seeded: false }
  }

  function load() {
    try {
      const raw = window.localStorage.getItem(KEY)
      const s = raw ? JSON.parse(raw) : null
      if (!s) return blank()
      return {
        version: 1,
        pages: s.pages && typeof s.pages === "object" ? s.pages : {},
        trail: Array.isArray(s.trail) ? s.trail : [],
        seeded: !!s.seeded,
      }
    } catch {
      return blank()
    }
  }

  function save(state) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state))
    } catch {
      /* private browsing, quota, or a locked-down profile — nothing to do */
    }
  }

  /**
   * Prune first, then append. A consecutive repeat merges into the leg it
   * repeats rather than adding one: a reload, an in-page anchor, or a tab
   * regaining focus is not a new move through the graph.
   *
   * A -> B -> A does *not* collapse, and should not — going back is a real move,
   * and dropping it would draw a leg from B to wherever you went next, which is
   * a route nobody took.
   */
  function appendTrail(trail, entry, now) {
    const out = []
    for (let i = 0; i < trail.length; i++) {
      if (now - (trail[i].at ?? 0) <= TRAIL_WINDOW) out.push(trail[i])
    }
    const last = out[out.length - 1]
    if (last && last.slug === entry.slug) {
      out[out.length - 1] = {
        slug: last.slug,
        at: entry.at,
        dwell: (last.dwell ?? 0) + (entry.dwell ?? 0),
        scroll: Math.max(last.scroll ?? 0, entry.scroll ?? 0),
      }
      return out
    }
    out.push(entry)
    return out
  }

  /**
   * Seed from the graph plugin's visited set, once, at `seen` and no higher.
   *
   * A returning reader has months of history in that key and starting them at
   * zero is a lie in the unhelpful direction. Promoting any of it to `read`
   * would be a lie in the other: that set records nothing about how long anyone
   * stayed. Records already held here always win — a seed must never overwrite
   * a measurement.
   */
  function seed(state, slugs, now) {
    if (state.seeded) return state
    state.seeded = true
    if (!Array.isArray(slugs)) return state
    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i]
      if (typeof slug !== "string" || !slug) continue
      if (state.pages[slug]) continue
      state.pages[slug] = {
        tier: "seen",
        firstSeen: now,
        lastSeen: now,
        dwell: 0,
        scroll: 0,
        visits: 1,
        seeded: true,
      }
    }
    return state
  }

  function readLegacy() {
    try {
      const raw = window.localStorage.getItem(LEGACY_KEY)
      const list = raw ? JSON.parse(raw) : []
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  // ---- the numbers --------------------------------------------------------
  /**
   * Explored, Connected and the Frontier for one field, given a predicate for
   * "has this page been read".
   *
   * **Explored** weights each page by its degree within the field, so a page the
   * field keeps returning to counts for more than a leaf. It is the headline
   * because it is truthful *and* moves: on the real graph, 25 pages read as a
   * connected cluster reads 27.1% against 11.7% of the page count, and the same
   * 25 read scattered reads 13.5%.
   *
   * **Connected** is the purer crosslink statement — both ends of an edge read —
   * and cannot be gamed by skimming. It is not the headline because it is
   * quadratic in what you have read and spends the first fifty pages near zero,
   * and a number that reads as broken while the reader is doing the right thing
   * teaches them to ignore it.
   *
   * **Frontier** is the only one a reader can act on: unread pages one link from
   * something read, ranked by how many read pages point at them.
   *
   * One pass over a few hundred integers. No memoisation and no incremental
   * update: caching here would buy microseconds and risk a number that is
   * quietly wrong, and invalidating it on a tier change is exactly the bug that
   * would make it so.
   */
  function coverage(graph, field, isRead) {
    const nodes = graph?.nodes ?? []
    const edges = graph?.edges ?? []
    const read = new Set()
    let degreeTotal = 0
    let degreeRead = 0
    let pages = 0
    let pagesRead = 0

    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].f !== field) continue
      pages++
      degreeTotal += nodes[i].d
      if (isRead(nodes[i].s)) {
        read.add(i)
        pagesRead++
        degreeRead += nodes[i].d
      }
    }

    let edgeTotal = 0
    let edgeBoth = 0
    const adjacency = new Map()
    for (let e = 0; e < edges.length; e++) {
      const a = edges[e][0]
      const b = edges[e][1]
      if (nodes[a]?.f !== field) continue
      edgeTotal++
      const readA = read.has(a)
      const readB = read.has(b)
      if (readA && readB) {
        edgeBoth++
      } else if (readA || readB) {
        const outer = readA ? b : a
        adjacency.set(outer, (adjacency.get(outer) ?? 0) + 1)
      }
    }

    const frontier = [...adjacency.entries()]
      .map(([i, from]) => ({ slug: nodes[i].s, title: nodes[i].t, degree: nodes[i].d, from }))
      // most-pointed-at first; then the better connected page, because it opens
      // more of the field; then by slug, so the order is never arbitrary
      .sort((p, q) => q.from - p.from || q.degree - p.degree || p.slug.localeCompare(q.slug))

    return {
      pages,
      pagesRead,
      explored: degreeTotal ? degreeRead / degreeTotal : 0,
      connected: edgeTotal ? edgeBoth / edgeTotal : 0,
      frontier,
    }
  }

  /**
   * Where to start, when nothing has been read yet.
   *
   * A first visit shows zeros and an empty frontier, and zeros read as a broken
   * feature rather than an unstarted one — the same failure learning mode hit
   * with an empty review queue, and it takes the same fix. Computed from the
   * index, so it cannot go stale the way a hand-written list would.
   */
  function entryPoints(graph, field) {
    return (graph?.nodes ?? [])
      .filter((n) => n.f === field)
      .sort((a, b) => b.d - a.d || a.s.localeCompare(b.s))
      .map((n) => ({ slug: n.s, title: n.t, degree: n.d, from: 0 }))
  }

  /** Cards at `state: "review"` over cards in the field. A different question. */
  function retention(cards, field, sched) {
    let total = 0
    let held = 0
    for (const card of cards ?? []) {
      if (card.section !== field) continue
      total++
      if (sched?.[card.id]?.state === "review") held++
    }
    return { total, held, share: total ? held / total : 0 }
  }

  /**
   * How far down the page the reader has been. A page that fits the viewport has
   * nothing to scroll past and is satisfied on arrival — otherwise every short
   * entity page would be unreadable by construction.
   */
  function scrolled() {
    const doc = document.documentElement
    const view = window.innerHeight || doc.clientHeight || 0
    const height = Math.max(doc.scrollHeight || 0, document.body?.scrollHeight || 0)
    if (height <= view + 4) return 1
    const y = window.scrollY || doc.scrollTop || 0
    return Math.min(1, Math.max(0, (y + view) / height))
  }

  // The visit in progress. `since` is null while the tab is hidden, and
  // `flushed` is how much of the accrued dwell has already been written — a
  // visit commits more than once (every visibility change, and again on
  // pagehide) and must not be counted twice.
  let live = null

  function accrue() {
    if (!live || live.since == null) return
    const now = Date.now()
    live.dwell += now - live.since
    live.since = now
  }

  function begin() {
    const marker = document.querySelector("[data-progress-words]")
    const slug = document.body?.dataset?.slug ?? ""
    if (!marker || !slug) {
      live = null
      return
    }
    const words = parseInt(marker.getAttribute("data-progress-words") || "0", 10) || 0
    live = {
      slug,
      words,
      dwell: 0,
      flushed: 0,
      scroll: scrolled(),
      since: document.visibilityState === "hidden" ? null : Date.now(),
    }

    // `seen` is written on arrival rather than on leaving, so a reader who
    // closes the tab immediately still leaves the record that they were here.
    const state = load()
    const now = Date.now()
    const prev = state.pages[slug]
    state.pages[slug] = {
      tier: higher(prev?.tier ?? "unseen", "seen"),
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      dwell: prev?.dwell ?? 0,
      scroll: prev?.scroll ?? 0,
      visits: (prev?.visits ?? 0) + 1,
    }
    save(state)
  }

  /**
   * Fold the visit so far into the stored record. Dwell accumulates across
   * visits — three passes of forty seconds is a page worked through, and the
   * budget is a bar to clear rather than a stopwatch to beat in one sitting.
   */
  function commit() {
    if (!live) return
    accrue()
    const gained = live.dwell - live.flushed
    if (gained <= 0 && live.flushed > 0) return
    live.flushed = live.dwell

    const state = load()
    const now = Date.now()
    const prev = state.pages[live.slug]
    const rec = {
      tier: prev?.tier ?? "seen",
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      dwell: (prev?.dwell ?? 0) + Math.max(0, gained),
      scroll: Math.max(prev?.scroll ?? 0, live.scroll),
      visits: prev?.visits ?? 1,
    }
    rec.tier = tierFor(rec, live.words)
    state.pages[live.slug] = rec
    state.trail = appendTrail(
      state.trail,
      { slug: live.slug, at: now, dwell: Math.max(0, gained), scroll: live.scroll },
      now,
    )
    save(state)
  }

  function onNav() {
    commit()
    begin()
  }

  function onVisibility() {
    if (!live) return
    if (document.visibilityState === "hidden") {
      accrue()
      live.since = null
      // a hidden tab may never come back, so bank what it earned
      commit()
    } else if (live.since == null) {
      live.since = Date.now()
    }
  }

  function onScroll() {
    if (!live) return
    const s = scrolled()
    if (s > live.scroll) live.scroll = s
  }

  /**
   * Ask to be exempt from eviction under storage pressure. Once per page load
   * rather than once ever: Chrome decides on engagement, so a reader denied on
   * their first visit should be asked again as a regular one. It does nothing
   * for Safari's seven-day cap — installing the site is what fixes that.
   */
  function persist() {
    try {
      navigator.storage?.persist?.()
    } catch {
      /* unsupported, or a permissions policy that forbids asking */
    }
  }

  // ---- the band -----------------------------------------------------------

  const base = () => (document.body?.dataset?.basepath ?? "").replace(/\/$/, "")

  let graphPromise = null
  function graph() {
    if (!graphPromise) {
      graphPromise = fetch(base() + "/static/graph.json")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    }
    return graphPromise
  }

  /**
   * Cards are fetched only if this browser has a schedule at all.
   *
   * Not for the bandwidth: `learning-mode` fetches `cards.json` on every page
   * regardless (its `setup()` awaits it before deciding whether to render
   * anything), so on this site the 652KB is already in flight and the browser
   * cache serves the second ask. The gate is about *dependence* — progress has
   * to work with learning mode disabled or absent, which is most of the reason
   * it exists, and a reader with no schedule has no recall number to show
   * whether the file arrives or not.
   */
  let cardsPromise = null
  function cards(sched) {
    if (!sched || !Object.keys(sched).length) return Promise.resolve(null)
    if (!cardsPromise) {
      cardsPromise = fetch(base() + "/static/cards.json")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.cards ?? null)
        .catch(() => null)
    }
    return cardsPromise
  }

  function learningSched() {
    try {
      const raw = window.localStorage.getItem("symposium:learning:v1")
      return raw ? (JSON.parse(raw).sched ?? null) : null
    } catch {
      return null
    }
  }

  const pct = (n) => Math.round(n * 100) + "%"

  function el(tag, props, ...children) {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(props ?? {})) {
      if (k === "class") node.className = v
      else if (k === "text") node.textContent = v
      else node.setAttribute(k, v)
    }
    for (const c of children) if (c) node.appendChild(c)
    return node
  }

  function stat(value, label, title) {
    return el(
      "div",
      { class: "pb-stat", title },
      el("span", { class: "pb-value", text: value }),
      el("span", { class: "pb-label", text: label }),
    )
  }

  /**
   * Frontier links, with their case forced inline.
   *
   * `custom.scss` lowercases a broad sweep of chrome — including bare `p` and
   * `a` — and it is emitted *outside* `@layer quartz-base` while component CSS
   * is emitted *inside* it. Unlayered rules beat layered ones whatever their
   * specificity, so no selector this component can write will win: the shipped
   * `.progress-band .pb-next a` rule lost to a bare `a`. These are page titles,
   * and "LLM Agent" rendering as "llm agent" is wrong, so the style goes on the
   * element, which outranks both.
   */
  const CASE = "text-transform:none"

  function links(list, limit) {
    const wrap = el("span", { class: "pb-links" })
    list.slice(0, limit).forEach((p, i) => {
      if (i) wrap.appendChild(document.createTextNode(", "))
      wrap.appendChild(el("a", { href: base() + "/" + p.slug, text: p.title, style: CASE }))
    })
    return wrap
  }

  function renderBand(host, field, state, graphData, cardList) {
    const cov = coverage(graphData, field, (slug) => rank(state.pages[slug]?.tier) >= TIERS.read)
    host.textContent = ""

    const row = el("div", { class: "pb-row" })
    row.appendChild(
      stat(
        pct(cov.explored),
        "explored",
        "Share of this field's links that sit on pages you have read",
      ),
    )
    row.appendChild(
      stat(pct(cov.connected), "connected", "Share of this field's links with both ends read"),
    )
    row.appendChild(
      stat(cov.pagesRead + "/" + cov.pages, "pages", "Pages read, of the pages in this field"),
    )

    if (cardList) {
      const r = retention(cardList, field, learningSched())
      if (r.total)
        row.appendChild(stat(pct(r.share), "recalled", "Cards in this field you are holding"))
    }
    host.appendChild(row)

    // Nothing read yet: an empty frontier and three zeros read as a broken
    // feature, so name where to start instead.
    const started = cov.pagesRead > 0
    const list = started ? cov.frontier : entryPoints(graphData, field)
    if (list.length) {
      const line = el("p", { class: "pb-next", style: CASE })
      line.appendChild(
        document.createTextNode(started ? "Next, from where you are: " : "Start here: "),
      )
      line.appendChild(links(list, 3))
      host.appendChild(line)
    }
    const map = el("p", { class: "pb-map" })
    map.appendChild(el("a", { href: mapLink(field), text: "View this field on the map →", style: CASE }))
    host.appendChild(map)
    host.dataset.progressFilled = "1"
  }

  async function band() {
    const host = document.querySelector("[data-progress-band]")
    if (!host) return
    const field = host.getAttribute("data-progress-band")
    const graphData = await graph()
    if (!graphData) return
    const sched = learningSched()
    const cardList = await cards(sched)
    // the page may have changed underneath a slow fetch
    if (!host.isConnected) return
    renderBand(host, field, load(), graphData, cardList)
  }

  function onNavBand() {
    band()
  }

  // ---- the map ------------------------------------------------------------

  const svg = "http://www.w3.org/2000/svg"
  const svgEl = (tag, attrs = {}) => {
    const node = document.createElementNS(svg, tag)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
    return node
  }

  const readableField = (field) =>
    String(field)
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")

  function mapField() {
    const raw = new URLSearchParams(window.location.search).get("field")
    return raw || null
  }

  function nodeTier(slug, state) {
    return rank(state.pages[slug]?.tier)
  }

  function point(node, fields, field) {
    if (field) return { x: 50 + node.x * 900, y: 50 + node.y * 500 }
    const box = fields[node.f]?.box
    if (!box) return { x: 0, y: 0 }
    return { x: 50 + (box.x + node.x * box.w) * 900, y: 50 + (box.y + node.y * box.h) * 500 }
  }

  function mapLink(field) {
    const query = field ? "?field=" + encodeURIComponent(field) : ""
    return base() + "/map" + query
  }

  function renderMap(host, graphData, state) {
    const fields = graphData.fields ?? {}
    const names = Object.keys(fields).sort()
    let field = mapField()
    if (!fields[field]) field = null
    // A graph of the whole corpus cannot be operated on at phone tap sizes. A
    // field is the useful initial view there; desktop keeps the whole field of
    // study in sight unless a hub sent the reader here with a filter.
    if (!field && window.matchMedia?.("(max-width: 800px)").matches) field = names[0] ?? null

    host.textContent = ""
    const controls = el("div", { class: "progress-map-controls", role: "navigation", "aria-label": "Map field" })
    const addFilter = (name, label) => {
      const selected = (field ?? "") === (name ?? "")
      const a = el("a", { href: mapLink(name), text: label, class: selected ? "selected" : "" })
      if (selected) a.setAttribute("aria-current", "page")
      controls.appendChild(a)
    }
    addFilter(null, "All fields")
    names.forEach((name) => addFilter(name, readableField(name)))
    host.appendChild(controls)

    const shown = (graphData.nodes ?? []).filter((node) => !field || node.f === field)
    const shownSet = new Set(shown.map((node) => node.s))
    const byIndex = graphData.nodes ?? []
    const coords = new Map(shown.map((node) => [node.s, point(node, fields, field)]))
    // A field has its own frontier. In the all-fields view they are unioned;
    // cross-field links are deliberately absent from graph.json, so this is the
    // same question repeated for each field rather than one blurry global one.
    const frontier = new Set()
    const frontierFields = field ? [field] : names
    frontierFields.forEach((name) => {
      const cov = coverage(graphData, name, (slug) => nodeTier(slug, state) >= TIERS.read)
      cov.frontier.forEach((node) => frontier.add(node.slug))
    })
    const drawing = svgEl("svg", {
      class: "progress-map-graph",
      viewBox: "0 0 1000 600",
      role: "img",
      "aria-label": field ? `${readableField(field)} reading map` : "Reading map of all fields",
    })

    // An edge is never a target, so one path for every tier class is enough.
    // Nodes are individual anchors because they are the map's controls.
    const edgePaths = [0, 1, 2]
    edgePaths.forEach((tier) => drawing.appendChild(svgEl("path", { class: `pm-edge pm-edge-${tier}` })))
    const edgeData = ["", "", ""]
    for (const [a, b] of graphData.edges ?? []) {
      const left = byIndex[a]
      const right = byIndex[b]
      if (!left || !right || !shownSet.has(left.s) || !shownSet.has(right.s)) continue
      const p = coords.get(left.s)
      const q = coords.get(right.s)
      const tier = Math.min(nodeTier(left.s, state), nodeTier(right.s, state))
      edgeData[tier] += `M${p.x},${p.y}L${q.x},${q.y}`
    }
    edgePaths.forEach((tier, i) => drawing.querySelector(`.pm-edge-${tier}`).setAttribute("d", edgeData[i]))

    // Trail entries are a route, not graph edges: only consecutive records make
    // a leg. Filtering must not join A to C merely because an intervening B was
    // in another field. Old state is pruned here as well as on record, so an
    // imported or hand-edited store cannot revive a stale route.
    const recent = (state.trail ?? []).filter((entry) => Date.now() - (entry.at ?? 0) <= TRAIL_WINDOW)
    const trail = svgEl("g", { class: "pm-trail", "data-progress-trail": "" })
    for (let i = 1; i < recent.length; i++) {
      const a = recent[i - 1]
      const b = recent[i]
      if (!shownSet.has(a.slug) || !shownSet.has(b.slug)) continue
      const p = coords.get(a.slug)
      const q = coords.get(b.slug)
      if (!p || !q || (field && (a.slug === b.slug))) continue
      const age = Math.max(a.at ?? 0, b.at ?? 0)
      const share = Math.max(0, Math.min(1, (Date.now() - age) / TRAIL_WINDOW))
      // Recent legs lead the eye; the oldest remain just visible enough to say
      // where the route began. Separate segments are necessary for a temporal
      // fade: an SVG stroke gradient fades in space, not in time.
      trail.appendChild(
        svgEl("path", {
          class: "pm-trail-leg",
          d: `M${p.x},${p.y}L${q.x},${q.y}`,
          opacity: 0.14 + (1 - share) * 0.66,
          "stroke-width": 1 + (1 - share) * 2,
        }),
      )
    }
    drawing.appendChild(trail)

    const label = svgEl("text", { class: "pm-hover-label", x: 0, y: 0, "text-anchor": "middle", visibility: "hidden" })
    for (const node of shown) {
      const p = coords.get(node.s)
      const tier = nodeTier(node.s, state)
      if (frontier.has(node.s)) {
        drawing.appendChild(svgEl("circle", { class: "pm-frontier", cx: p.x, cy: p.y, r: Math.max(10, Math.min(16, 8 + Math.sqrt(node.d || 1) * 1.7)) }))
      }
      const a = svgEl("a", { href: base() + "/" + node.s, class: "pm-node-link", "aria-label": node.t })
      const circle = svgEl("circle", { class: `pm-node pm-node-${tier}`, cx: p.x, cy: p.y, r: Math.max(5, Math.min(11, 4 + Math.sqrt(node.d || 1) * 1.7)), tabindex: "0" })
      const title = svgEl("title")
      title.textContent = `${node.t} — ${["unseen", "seen", "read"][tier]}`
      a.append(circle, title)
      const showLabel = () => {
        label.textContent = node.t
        label.setAttribute("x", p.x)
        label.setAttribute("y", p.y - 14)
        label.setAttribute("visibility", "visible")
      }
      a.addEventListener("mouseenter", showLabel)
      a.addEventListener("focus", showLabel)
      a.addEventListener("mouseleave", () => label.setAttribute("visibility", "hidden"))
      a.addEventListener("blur", () => label.setAttribute("visibility", "hidden"))
      drawing.appendChild(a)
    }
    drawing.appendChild(label)
    host.appendChild(drawing)

    const legend = el("p", { class: "progress-map-legend" })
    ;[[0, "unseen"], [1, "seen"], [2, "read"]].forEach(([tier, name]) => {
      legend.appendChild(el("span", { class: `pm-key pm-node-${tier}` }))
      legend.appendChild(document.createTextNode(name + " "))
    })
    host.appendChild(legend)

    const table = el("table", { class: "progress-map-table" })
    table.innerHTML = "<thead><tr><th>field</th><th>explored</th><th>connected</th><th>pages</th></tr></thead>"
    const body = el("tbody")
    names.forEach((name) => {
      const cov = coverage(graphData, name, (slug) => nodeTier(slug, state) >= TIERS.read)
      const row = el("tr")
      row.append(
        el("th", { text: readableField(name), scope: "row" }),
        el("td", { text: pct(cov.explored) }),
        el("td", { text: pct(cov.connected) }),
        el("td", { text: `${cov.pagesRead}/${cov.pages}` }),
      )
      body.appendChild(row)
    })
    table.appendChild(body)
    host.appendChild(table)
    host.dataset.progressMapFilled = "1"
  }

  async function map() {
    const host = document.querySelector("[data-progress-map]")
    if (!host) return
    const graphData = await graph()
    if (graphData && host.isConnected) renderMap(host, graphData, load())
  }

  document.addEventListener("nav", onNav)
  document.addEventListener("nav", onNavBand)
  document.addEventListener("nav", map)
  document.addEventListener("visibilitychange", onVisibility)
  window.addEventListener("pagehide", commit)
  window.addEventListener("scroll", onScroll, { passive: true })
  window.addEventListener("resize", onScroll, { passive: true })

  save(seed(load(), readLegacy(), Date.now()))
  persist()
})();