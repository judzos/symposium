(function accountSyncRuntime() {
  const LEARNING_KEY = "symposium:learning:v1"
  const PROGRESS_KEY = "symposium:progress:v1"
  const THEME_KEY = "symposium:theme:v1"
  const AUTH_KEY = "symposium:auth:v1"
  const PROVIDER_KEY = "symposium:auth-provider:v1"
  const DAY = 86400000
  let clientPromise = null
  let configPromise = null
  let panel = null
  let syncing = false
  let timer = null
  let lastSync = 0
  let renderVersion = 0

  const base = () => (document.body?.dataset?.basepath ?? "").replace(/\/$/, "")

  const providerName = (provider) =>
    ({ github: "GitHub", discord: "Discord" })[provider] ??
    String(provider ?? "").replace(/^./, (letter) => letter.toUpperCase())

  function providerLabel(user, remembered) {
    const identities = [
      ...(user?.identities ?? []).map((identity) => identity?.provider),
      ...(user?.app_metadata?.providers ?? []),
    ].filter((provider, index, all) => provider && all.indexOf(provider) === index)
    if (remembered && (!identities.length || identities.includes(remembered))) {
      return "via " + providerName(remembered)
    }
    if (identities.length === 1) return "via " + providerName(identities[0])
    if (identities.length > 1) return identities.map(providerName).join(" + ") + " connected"
    const fallback = user?.app_metadata?.provider
    return fallback ? "via " + providerName(fallback) : ""
  }

  function rememberedProvider() {
    try {
      return window.sessionStorage.getItem(PROVIDER_KEY) ?? ""
    } catch {
      return ""
    }
  }

  function el(tag, props, ...children) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props ?? {})) {
      if (key === "class") node.className = value
      else if (key === "text") node.textContent = value
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value)
      else node.setAttribute(key, value)
    }
    for (const child of children) if (child) node.appendChild(child)
    return node
  }

  function config() {
    if (!configPromise) {
      configPromise = fetch(base() + "/static/sync-config.json")
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null)
    }
    return configPromise
  }

  function loadScript(src) {
    if (window.supabase?.createClient) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const existing = document.querySelector("script[data-symposium-supabase]")
      if (existing) {
        existing.addEventListener("load", resolve, { once: true })
        existing.addEventListener("error", reject, { once: true })
        return
      }
      const script = document.createElement("script")
      script.src = src
      script.async = true
      script.dataset.symposiumSupabase = "1"
      script.onload = resolve
      script.onerror = reject
      document.head.appendChild(script)
    })
  }

  async function client() {
    if (!clientPromise) {
      clientPromise = (async () => {
        const cfg = await config()
        if (!cfg?.enabled) return null
        await loadScript(base() + "/static/supabase.js")
        return window.supabase.createClient(cfg.url, cfg.publishableKey, {
          auth: {
            flowType: "pkce",
            detectSessionInUrl: true,
            persistSession: true,
            storageKey: AUTH_KEY,
          },
        })
      })()
    }
    return clientPromise
  }

  function parse(key, fallback) {
    try {
      const value = JSON.parse(window.localStorage.getItem(key) || "null")
      return value && typeof value === "object" ? value : fallback
    } catch {
      return fallback
    }
  }

  const reviewedAt = (entry) =>
    Number(entry?.reviewedAt ?? entry?.seenAt ?? Date.parse(entry?.seen ?? "")) || 0
  const rank = (tier) => ({ unseen: 0, seen: 1, read: 2 })[tier] ?? 0

  function enrollmentMeta(state) {
    const meta =
      state?.enrolledMeta && typeof state.enrolledMeta === "object" ? { ...state.enrolledMeta } : {}
    for (const slug of state?.enrolled ?? [])
      if (!meta[slug]) meta[slug] = { on: true, updatedAt: 0 }
    return meta
  }

  function mergeDaily(local, remote) {
    if (!local) return remote ?? null
    if (!remote) return local
    const localDate = String(local.date ?? "")
    const remoteDate = String(remote.date ?? "")
    if (localDate !== remoteDate) return remoteDate > localDate ? remote : local
    return {
      date: localDate,
      introduced: Math.max(Number(local.introduced ?? 0), Number(remote.introduced ?? 0)),
      reviewed: Math.max(Number(local.reviewed ?? 0), Number(remote.reviewed ?? 0)),
    }
  }

  function mergeLearning(local, remote) {
    const out = {
      ...(local ?? {}),
      sched: { ...(local?.sched ?? {}) },
      tracks: { ...(local?.tracks ?? {}) },
      enrolledMeta: enrollmentMeta(local),
      daily: mergeDaily(local?.daily, remote?.daily),
    }
    const localSettingsAt = Number(local?.settingsUpdatedAt ?? 0)
    const remoteSettingsAt = Number(remote?.settingsUpdatedAt ?? 0)
    if (remote?.settings && (!local?.settings || remoteSettingsAt > localSettingsAt)) {
      out.settings = { ...remote.settings }
    }
    out.settingsUpdatedAt = Math.max(localSettingsAt, remoteSettingsAt)
    for (const [id, entry] of Object.entries(remote?.sched ?? {})) {
      if (!out.sched[id] || reviewedAt(entry) > reviewedAt(out.sched[id])) out.sched[id] = entry
    }
    for (const [slug, entry] of Object.entries(enrollmentMeta(remote))) {
      if (
        !out.enrolledMeta[slug] ||
        Number(entry?.updatedAt ?? 0) > Number(out.enrolledMeta[slug]?.updatedAt ?? 0)
      ) {
        out.enrolledMeta[slug] = entry
      }
    }
    for (const [id, entry] of Object.entries(remote?.tracks ?? {})) {
      if (!out.tracks[id] || Number(entry?.updatedAt ?? 0) > Number(out.tracks[id]?.updatedAt ?? 0))
        out.tracks[id] = entry
    }
    out.enrolled = Object.entries(out.enrolledMeta)
      .filter(([, entry]) => entry?.on)
      .map(([slug]) => slug)
      .sort()
    return out
  }

  function mergeProgress(local, remote, syncTrail) {
    const out = {
      version: 1,
      pages: { ...(local?.pages ?? {}) },
      trail: Array.isArray(local?.trail) ? [...local.trail] : [],
      seeded: !!(local?.seeded || remote?.seeded),
    }
    for (const [slug, entry] of Object.entries(remote?.pages ?? {})) {
      const mine = out.pages[slug]
      if (!mine) {
        out.pages[slug] = entry
        continue
      }
      out.pages[slug] = {
        ...mine,
        ...entry,
        tier: rank(entry?.tier) > rank(mine?.tier) ? entry.tier : mine.tier,
        firstSeen: Math.min(mine.firstSeen ?? Infinity, entry.firstSeen ?? Infinity),
        lastSeen: Math.max(mine.lastSeen ?? 0, entry.lastSeen ?? 0),
        dwell: Math.max(mine.dwell ?? 0, entry.dwell ?? 0),
        scroll: Math.max(mine.scroll ?? 0, entry.scroll ?? 0),
        visits: Math.max(mine.visits ?? 0, entry.visits ?? 0),
      }
    }
    if (syncTrail) {
      const seen = new Set()
      const cutoff = Date.now() - 90 * DAY
      out.trail = [...out.trail, ...(remote?.trail ?? [])]
        .filter((entry) => entry?.slug && Number(entry?.at ?? 0) >= cutoff)
        .sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0))
        .filter((entry) => {
          const key = entry.slug + ":" + entry.at
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
    }
    return out
  }

  /**
   * The reader's palette. Last write wins, on the stamp the theme engine puts
   * on every save — there is nothing to merge inside a palette, since it is one
   * decision rather than an accumulating record like a schedule or a reading
   * map.
   *
   * A reset is a `theme.off` tombstone rather than an absent key, for the same
   * reason an un-enrolled lesson is: a device that has no theme and a device
   * that has *chosen* to have no theme are different states, and only the
   * second one should be able to clear the other.
   */
  function mergeTheme(local, remote) {
    if (!local) return remote ?? null
    if (!remote) return local
    return Number(remote.updatedAt ?? 0) > Number(local.updatedAt ?? 0) ? remote : local
  }

  function localBundle() {
    return {
      version: 1,
      learning: parse(LEARNING_KEY, { enrolled: [], enrolledMeta: {}, tracks: {}, sched: {} }),
      progress: parse(PROGRESS_KEY, { version: 1, pages: {}, trail: [], seeded: false }),
      theme: parse(THEME_KEY, null),
    }
  }

  function mergeBundle(local, remote, syncTrail) {
    return {
      version: 1,
      learning: mergeLearning(local?.learning, remote?.learning),
      progress: mergeProgress(local?.progress, remote?.progress, syncTrail),
      theme: mergeTheme(local?.theme, remote?.theme),
    }
  }

  function cloudBundle(bundle, syncTrail) {
    return {
      version: 1,
      learning: {
        sched: bundle.learning?.sched ?? {},
        enrolled: bundle.learning?.enrolled ?? [],
        enrolledMeta: enrollmentMeta(bundle.learning),
        tracks: bundle.learning?.tracks ?? {},
        daily: bundle.learning?.daily ?? null,
        settings: bundle.learning?.settings ?? null,
        settingsUpdatedAt: Number(bundle.learning?.settingsUpdatedAt ?? 0),
      },
      progress: {
        version: 1,
        pages: bundle.progress?.pages ?? {},
        seeded: !!bundle.progress?.seeded,
        ...(syncTrail ? { trail: bundle.progress?.trail ?? [] } : {}),
      },
      ...(bundle.theme ? { theme: bundle.theme } : {}),
    }
  }

  function storeBundle(bundle) {
    window.localStorage.setItem(LEARNING_KEY, JSON.stringify(bundle.learning))
    window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(bundle.progress))
    if (bundle.theme) {
      window.localStorage.setItem(THEME_KEY, JSON.stringify(bundle.theme))
      // The engine reads localStorage, not this bundle, so a palette that
      // arrived from another device sits in storage doing nothing until
      // something asks for it to be applied. Nothing else on the page will.
      window.__symposiumTheme?.refresh()
    }
  }

  async function syncNow() {
    if (syncing) return false
    const cfg = await config()
    const api = await client()
    if (!cfg?.enabled || !api) return false
    const { data: sessionData } = await api.auth.getSession()
    const user = sessionData?.session?.user
    if (!user) return false
    syncing = true
    paintStatus("Syncing…")
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const { data: row, error: readError } = await api
          .from(cfg.table)
          .select("payload,revision")
          .eq("user_id", user.id)
          .maybeSingle()
        if (readError) throw readError
        const merged = mergeBundle(localBundle(), row?.payload ?? {}, !!cfg.syncTrail)
        storeBundle(merged)
        const payload = cloudBundle(merged, !!cfg.syncTrail)
        if (!row) {
          const { error } = await api
            .from(cfg.table)
            .insert({ user_id: user.id, payload, revision: 1 })
          if (error?.code === "23505") continue
          if (error) throw error
        } else {
          const nextRevision = Number(row.revision ?? 0) + 1
          const { data: updated, error } = await api
            .from(cfg.table)
            .update({ payload, revision: nextRevision, updated_at: new Date().toISOString() })
            .eq("user_id", user.id)
            .eq("revision", row.revision)
            .select("revision")
            .maybeSingle()
          if (error) throw error
          if (!updated) continue
        }
        lastSync = Date.now()
        paintStatus("Synced just now")
        window.dispatchEvent(new CustomEvent("symposium:cloud-merged"))
        return true
      }
      throw new Error("progress changed on another device; retry")
    } catch (error) {
      paintStatus("Sync failed — local progress is safe")
      console.warn("Symposium progress sync failed", error)
      return false
    } finally {
      syncing = false
    }
  }

  function scheduleSync() {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      if (Date.now() - lastSync > 1000) syncNow()
    }, 1500)
  }

  function paintStatus(message) {
    const node = panel?.querySelector(".sync-status")
    if (node) node.textContent = message
  }

  async function signIn(provider) {
    const api = await client()
    if (!api) return
    try {
      window.sessionStorage.setItem(PROVIDER_KEY, provider)
    } catch {
      /* the identity list still provides a safe fallback */
    }
    const redirectTo = window.location.origin + window.location.pathname + window.location.search
    const { error } = await api.auth.signInWithOAuth({ provider, options: { redirectTo } })
    if (error) {
      try {
        window.sessionStorage.removeItem(PROVIDER_KEY)
      } catch {}
      paintStatus("Could not start sign-in")
    }
  }

  async function deleteCloud(userId) {
    if (!window.confirm("Delete the synced cloud copy? Progress on this device will remain."))
      return
    const cfg = await config()
    const api = await client()
    const { error } = await api.from(cfg.table).delete().eq("user_id", userId)
    paintStatus(
      error ? "Could not delete cloud progress" : "Cloud progress deleted; local copy kept",
    )
  }

  async function render() {
    const version = ++renderVersion
    document.querySelectorAll(".sync-panel").forEach((node) => node.remove())
    panel = null
    const slug = document.body?.dataset?.slug ?? ""
    if (slug !== "learn" && slug !== "review" && slug !== "settings") return false
    const cfg = await config()
    if (version !== renderVersion || !cfg?.enabled) return false
    const api = await client()
    if (version !== renderVersion || !api) return false
    const { data } = await api.auth.getSession()
    if (version !== renderVersion) return false
    const session = data?.session
    const host = document.querySelector(".sync-mount") ?? document.querySelector(".center")
    if (!host) return false
    panel = el("aside", { class: "sync-panel", "aria-label": "Progress sync" })
    if (!session) {
      panel.append(
        el(
          "div",
          { class: "sync-row" },
          el("strong", { text: "Progress is saved on this device." }),
          el("button", {
            class: "sync-btn",
            type: "button",
            text: "Sync with GitHub",
            onclick: () => signIn("github"),
          }),
          el("button", {
            class: "sync-btn",
            type: "button",
            text: "Sync with Discord",
            onclick: () => signIn("discord"),
          }),
        ),
        el(
          "div",
          { class: "sync-row" },
          el("span", {
            text: cfg.syncTrail
              ? "Signing in syncs cards, paths, daily progress, page completion, your appearance settings, and the full reading map."
              : "Signing in syncs cards, paths, daily progress, page completion, and your appearance settings.",
          }),
          el("span", { class: "sync-status" }),
        ),
      )
    } else {
      const label =
        session.user?.user_metadata?.user_name ??
        session.user?.user_metadata?.full_name ??
        session.user?.email ??
        "signed-in reader"
      const provider = providerLabel(session.user, rememberedProvider())
      const avatar = session.user?.user_metadata?.avatar_url
      const identity = el(
        "span",
        { class: "sync-identity" },
        avatar ? el("img", { class: "sync-avatar", src: avatar, alt: "" }) : null,
        el("strong", { text: "Syncing as " + label }),
        provider ? el("span", { class: "sync-provider", text: provider }) : null,
      )
      panel.append(
        el(
          "div",
          { class: "sync-row" },
          identity,
          el("button", { class: "sync-btn", type: "button", text: "Sync now", onclick: syncNow }),
          el("button", {
            class: "sync-btn",
            type: "button",
            text: "Sign out",
            onclick: async () => {
              await api.auth.signOut()
              try {
                window.sessionStorage.removeItem(PROVIDER_KEY)
              } catch {}
              render()
            },
          }),
          el("button", {
            class: "sync-btn sync-danger",
            type: "button",
            text: "Delete cloud copy",
            onclick: () => deleteCloud(session.user.id),
          }),
        ),
        el(
          "div",
          { class: "sync-row" },
          el("span", {
            text: cfg.syncTrail
              ? "Cards, paths, daily progress, appearance, and the complete reading map are recoverable. Local progress remains the working copy."
              : "Cards, paths, daily progress, page completion, and appearance are recoverable. Local progress remains the working copy.",
          }),
          el("span", { class: "sync-status", text: lastSync ? "Synced" : "Ready to sync" }),
        ),
      )
    }
    host.replaceChildren(panel)
    return true
  }

  async function setup() {
    const cfg = await config()
    if (!cfg?.enabled) return
    const api = await client()
    if (!api) return
    if (!(await render())) return
    const { data } = await api.auth.getSession()
    if (data?.session && !lastSync) await syncNow()
  }

  document.addEventListener("nav", setup)
  window.addEventListener("symposium:state-changed", scheduleSync)
  window.addEventListener("pagehide", () => {
    if (!syncing) syncNow()
  })
  setup()
})();