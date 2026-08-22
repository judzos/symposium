
const NAV = () => document.getElementById("mobile-nav")

// "display: mobile-only" is a CSS wrapper, not a render condition, so this
// script runs on desktop too and every phone-only behaviour has to say so.
const onPhoneWidth = () => window.matchMedia("(max-width: 800px)").matches

const closeSheet = () => {
  delete document.body.dataset.sheet
  NAV()?.querySelectorAll("button[data-sheet]").forEach((b) => b.setAttribute("aria-expanded", "false"))
}

const openSheet = (key) => {
  if (document.body.dataset.sheet === key) return closeSheet()
  document.body.dataset.sheet = key
  NAV()?.querySelectorAll("button[data-sheet]").forEach((b) =>
    b.setAttribute("aria-expanded", String(b.dataset.target === key)),
  )
}

const setupMobileNav = () => {
  const nav = NAV()
  if (!nav || nav.dataset.bound) return
  nav.dataset.bound = "1"

  // A target with nothing behind it is worse than one fewer target: it opens an
  // empty sheet and reads as broken. Folder and tag pages carry no right
  // sidebar, and a page with no headings carries no table of contents.
  const sidebar = document.querySelector("#quartz-body > .sidebar.right")
  const has = {
    dock: true,
    page: !!sidebar?.querySelector(".toc"),
    related: !!sidebar?.querySelector(".backlinks, .graph"),
    sections: !!document.querySelector(".explorer button.mobile-explorer"),
    search: !!document.querySelector(".search > .search-button"),
  }
  nav.querySelectorAll("button[data-target]").forEach((b) => {
    b.hidden = !has[b.dataset.target]
  })

  let scrim = document.getElementById("mobile-nav-scrim")
  if (!scrim) {
    scrim = document.createElement("div")
    scrim.id = "mobile-nav-scrim"
    document.body.appendChild(scrim)
  }

  // ---- the drawer's state belongs on the bar ------------------------------
  // The drawer is Quartz's, and it is opened from here, so nothing was telling
  // the reader that this button is also the way back out: with the drawer open
  // Sections looked exactly like Sections closed, while This page lit up
  // whenever its sheet was showing. A full-width drawer has no outside to tap,
  // so an unlit button was the only exit and it did not look like one.
  //
  // Driven off the explorer's own class rather than off this button's clicks,
  // because the drawer closes on its own too — on navigation, on Escape, and
  // from upstream's collapse on load — and a state this button set for itself
  // would go stale every one of those times.
  const explorer = document.querySelector(".explorer")
  const drawer = explorer?.querySelector(".explorer-content")
  const sectionsBtn = nav.querySelector('button[data-target="sections"]')
  const dockBtn = nav.querySelector('button[data-target="dock"]')
  const iosDock = document.documentElement.hasAttribute("data-ios-browser")

  const setDockOpen = (open) => {
    if (!iosDock) return
    if (open) nav.dataset.dockOpen = "true"
    else delete nav.dataset.dockOpen
    dockBtn?.setAttribute("aria-expanded", String(open))
    dockBtn?.setAttribute("aria-label", open ? "Close navigation" : "Open navigation")
  }

  const drawerOpen = () => !!explorer && !explorer.classList.contains("collapsed")

  // overflow: hidden on the root is not a scroll lock in iOS Safari. The root
  // still follows a touch when its fixed child reaches a scroll boundary, which
  // moves the article behind the full-screen drawer and exposes it through the
  // browser's safe areas. Freeze the body at its exact reading position instead;
  // the explorer list remains its own scroll container.
  let pageLockY = null
  const lockPage = () => {
    if (!iosDock || pageLockY !== null) return
    pageLockY = Math.max(0, window.scrollY)
    document.documentElement.style.setProperty("--mobile-page-lock-top", -pageLockY + "px")
    document.documentElement.classList.add("mobile-page-locked")
  }
  const unlockPage = () => {
    if (pageLockY === null) return
    const restoreY = pageLockY
    pageLockY = null
    document.documentElement.classList.remove("mobile-page-locked")
    document.documentElement.style.removeProperty("--mobile-page-lock-top")
    // The site defaults to smooth scrolling. Restoring through that animation
    // briefly exposes the top of the article under the closing drawer and can
    // settle a pixel or two away on a scaled iPhone viewport. Restoration is
    // state, not navigation, so make this one scroll exact and synchronous.
    const priorScrollBehavior = document.documentElement.style.scrollBehavior
    document.documentElement.style.scrollBehavior = "auto"
    window.scrollTo(0, restoreY)
    document.documentElement.style.scrollBehavior = priorScrollBehavior
  }
  const syncPageLock = () => {
    if (drawerOpen() || document.body.dataset.sheet) lockPage()
    else unlockPage()
  }

  const revealNav = () => delete nav.dataset.scrollHidden
  const syncSections = () => {
    sectionsBtn?.setAttribute("aria-expanded", String(drawerOpen()))
    if (drawerOpen()) revealNav()
    syncPageLock()
  }
  syncSections()

  const explorerWatch = explorer ? new MutationObserver(syncSections) : null
  explorerWatch?.observe(explorer, { attributes: true, attributeFilter: ["class"] })

  // ---- leave the reading viewport to the article -------------------------
  // In iPhone Safari the browser's own expanded bottom toolbar and this bar
  // stack. Together they cover roughly a quarter of a small phone, which is
  // why the bar looks as though it has jumped too high during a scroll even
  // though its bottom edge is correctly pinned to the Visual Viewport.
  //
  // Direction, rather than a timeout, owns visibility. Down means the reader
  // is continuing through the article, so hide; up means they are reaching for
  // chrome, so return. The first screen and the end of the page always keep a
  // way out. A 14px hysteresis keeps finger tremor from flickering the bar.
  let scrollAnchor = Math.max(0, window.scrollY)
  let scrollFrame = 0

  const syncScrollNav = () => {
    scrollFrame = 0
    if (!onPhoneWidth()) return revealNav()

    const y = Math.max(0, window.scrollY)
    const viewport = window.visualViewport?.height ?? window.innerHeight
    const pageHeight = document.scrollingElement?.scrollHeight ?? document.body.scrollHeight
    const atEdge = y < 64 || y + viewport >= pageHeight - 24

    if (atEdge || document.body.dataset.sheet || drawerOpen()) {
      revealNav()
      scrollAnchor = y
      return
    }

    const delta = y - scrollAnchor
    if (Math.abs(delta) < 14) return
    if (iosDock) {
      // Safari expands its own toolbar on an upward gesture. Never answer that
      // same gesture by expanding ours; leave one round menu button instead.
      setDockOpen(false)
      revealNav()
    } else if (delta > 0) nav.dataset.scrollHidden = "true"
    else revealNav()
    scrollAnchor = y
  }

  const onPageScroll = () => {
    if (!scrollFrame) scrollFrame = requestAnimationFrame(syncScrollNav)
  }

  revealNav()
  window.addEventListener("scroll", onPageScroll, { passive: true })

  // Closing is done by hand rather than by clicking upstream's toggle, because
  // that toggle is a *toggle*: called when the drawer is already shut it opens
  // it. These three lines are exactly what its handler does, minus the flip, so
  // the state upstream reads — the class, aria-expanded, and the scroll lock —
  // stays whole either way.
  const shutDrawer = () => {
    if (!explorer) return
    explorer.classList.add("collapsed")
    explorer.setAttribute("aria-expanded", "false")
    document.documentElement.classList.remove("mobile-no-scroll")
    syncSections()
  }

  // ---- the drawer must not outlive the page it was opened from ------------
  // Upstream closes it on navigation, but only inside
  //   mobileExplorer.checkVisibility && mobileExplorer.checkVisibility()
  // and Safari did not ship checkVisibility until 17.4. On any iPhone below
  // that the method is undefined, the guard short-circuits, and *nothing* in
  // that file ever collapses the drawer: it stands open over every page on
  // load, and tapping a link loads the page underneath it and leaves it there.
  // Reproduced by deleting the method, which is what the tests do.
  //
  // So the bar closes it itself, on both counts, and depends on no capability
  // to do it. Both are phone-only: this script ships to desktop as well, where
  // the same explorer is a sidebar whose collapsed state belongs to the reader.
  if (onPhoneWidth()) {
    // A new page starts with the drawer shut, whoever opened it last.
    shutDrawer()
  }

  // A tap on a link is a decision to go somewhere, so the drawer's work is
  // over — close it on the way out rather than after the navigation lands, so
  // it is already gone when the new page paints. A folder's chevron is not an
  // anchor and does not match: expanding a branch has to leave the tree up.
  const onDrawerClick = (e) => {
    if (!onPhoneWidth()) return
    if (e.target.closest("a")) shutDrawer()
  }

  const onScrim = () => {
    closeSheet()
    setDockOpen(false)
    syncPageLock()
  }
  // iOS can keep scrolling the document from a touch that started on a fixed
  // overlay even with touch-action: none, so the gesture is refused at the
  // source too. passive: false is required for preventDefault to mean anything.
  const onScrimMove = (e) => e.preventDefault()
  const onKey = (e) => {
    if (e.key !== "Escape") return
    closeSheet()
    setDockOpen(false)
    // the drawer has no close control of its own once the header hamburger is
    // gone; Escape should mean "out" everywhere
    shutDrawer()
  }

  const onOutsideClick = (e) => {
    if (iosDock && nav.dataset.dockOpen && !e.target.closest("#mobile-nav")) {
      setDockOpen(false)
    }
  }

  const onClick = (e) => {
    const btn = e.target.closest("button[data-target]")
    if (!btn) return
    const key = btn.dataset.target
    if (key === "dock") {
      setDockOpen(!nav.dataset.dockOpen)
      return
    }

    // An action has been chosen. Return to the single round trigger before its
    // drawer, modal or sheet arrives, rather than stacking a five-button rail
    // over the thing it opened.
    setDockOpen(false)

    if (key === "sections") {
      // the drawer Quartz already ships; its own toggle owns the animation
      closeSheet()
      document.querySelector(".explorer button.mobile-explorer")?.click()
    } else if (key === "search") {
      closeSheet()
      document.querySelector(".search > .search-button")?.click()
    } else {
      // Until this tap the graph is not in the document at all — the gate in
      // beforeDOMLoaded holds it out. Release before opening, so the sheet
      // slides up over a graph that is already building rather than a gap.
      if (key === "related") window.__mobileGraphGate?.release()
      openSheet(key)
      syncPageLock()
    }
  }

  // ---- swipe-down dismiss -------------------------------------------------
  // The sheet draws a grab handle, and a handle that does not drag is a lie.
  // The gesture is claimed only while the sheet's own scroll sits at the top
  // and the finger moves down — anywhere else the touch stays an ordinary
  // scroll, so the two gestures never fight over one swipe.
  let dragY = 0
  let dragDelta = 0
  let dragging = false
  let dragIsScroll = false

  const onSheetTouchStart = (e) => {
    if (!document.body.dataset.sheet) return
    dragY = e.touches[0].clientY
    dragDelta = 0
    dragging = true
    dragIsScroll = sidebar.scrollTop > 0
  }

  const onSheetTouchMove = (e) => {
    if (!dragging || dragIsScroll) return
    const dy = e.touches[0].clientY - dragY
    if (dy <= 0 || sidebar.scrollTop > 0) {
      // moving up, or the sheet started scrolling: hand the gesture back
      dragIsScroll = true
      sidebar.style.transition = ""
      sidebar.style.transform = ""
      return
    }
    dragDelta = dy
    sidebar.style.transition = "none"
    sidebar.style.transform = "translateY(" + dy + "px)"
    e.preventDefault()
  }

  const onSheetTouchEnd = () => {
    if (!dragging) return
    dragging = false
    // Restore the stylesheet transition, then drop the inline transform in the
    // same frame as the close: the transition picks up from the dragged
    // position, so a past-threshold release continues down and a short one
    // springs back — no snap to the top first.
    sidebar.style.transition = ""
    sidebar.style.transform = ""
    if (dragDelta > 90) closeSheet()
    syncPageLock()
    dragDelta = 0
  }

  // ---- swipe-left dismiss, for the drawer ---------------------------------
  // The drawer covers the whole width, so unlike the sheet it has no outside to
  // tap and no scrim to catch a dismissing touch — the bar's Sections button
  // was the only way out of it. Pushing it back off the left edge is the
  // gesture every phone drawer has.
  //
  // Direction decides who owns the touch, and it is decided once: the tree
  // scrolls vertically, so a swipe is only a dismissal if it is going left more
  // than it is going anywhere else, and a touch that starts as a scroll stays a
  // scroll for its whole life.
  let drawerX = 0
  let drawerY = 0
  let drawerDx = 0
  let drawerDrag = null

  const onDrawerTouchStart = (e) => {
    if (!drawerOpen()) return
    drawerX = e.touches[0].clientX
    drawerY = e.touches[0].clientY
    drawerDx = 0
    drawerDrag = "undecided"
  }

  const onDrawerTouchMove = (e) => {
    if (!drawerDrag) return
    const dx = e.touches[0].clientX - drawerX
    const dy = e.touches[0].clientY - drawerY

    if (drawerDrag === "undecided") {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return // too small to read yet
      if (dx > 0 || Math.abs(dy) >= Math.abs(dx)) {
        drawerDrag = null // rightward, or mostly vertical: it is a scroll
        return
      }
      drawerDrag = "claimed"
    }

    drawerDx = Math.min(0, dx)
    drawer.style.transition = "none"
    drawer.style.transform = "translateX(" + drawerDx + "px)"
    e.preventDefault()
  }

  const onDrawerTouchEnd = () => {
    if (drawerDrag !== "claimed") {
      drawerDrag = null
      return
    }
    drawerDrag = null
    // Same handoff as the sheet: give the transition back before dropping the
    // inline transform, so the drawer carries on from where the finger left it.
    drawer.style.transition = ""
    drawer.style.transform = ""
    if (drawerDx < -60) shutDrawer()
    drawerDx = 0
  }

  nav.addEventListener("click", onClick)
  scrim.addEventListener("click", onScrim)
  scrim.addEventListener("touchmove", onScrimMove, { passive: false })
  document.addEventListener("click", onOutsideClick)
  document.addEventListener("keydown", onKey)
  if (sidebar) {
    sidebar.addEventListener("touchstart", onSheetTouchStart, { passive: true })
    sidebar.addEventListener("touchmove", onSheetTouchMove, { passive: false })
    sidebar.addEventListener("touchend", onSheetTouchEnd)
    sidebar.addEventListener("touchcancel", onSheetTouchEnd)
  }
  if (drawer) {
    drawer.addEventListener("click", onDrawerClick)
    drawer.addEventListener("touchstart", onDrawerTouchStart, { passive: true })
    drawer.addEventListener("touchmove", onDrawerTouchMove, { passive: false })
    drawer.addEventListener("touchend", onDrawerTouchEnd)
    drawer.addEventListener("touchcancel", onDrawerTouchEnd)
  }

  // A sheet or expanded browser dock must not survive the page under it changing.
  closeSheet()
  setDockOpen(false)

  window.addCleanup(() => {
    nav.removeEventListener("click", onClick)
    scrim.removeEventListener("click", onScrim)
    scrim.removeEventListener("touchmove", onScrimMove)
    document.removeEventListener("click", onOutsideClick)
    document.removeEventListener("keydown", onKey)
    window.removeEventListener("scroll", onPageScroll)
    if (scrollFrame) cancelAnimationFrame(scrollFrame)
    revealNav()
    setDockOpen(false)
    unlockPage()
    explorerWatch?.disconnect()
    if (sidebar) {
      sidebar.removeEventListener("touchstart", onSheetTouchStart)
      sidebar.removeEventListener("touchmove", onSheetTouchMove)
      sidebar.removeEventListener("touchend", onSheetTouchEnd)
      sidebar.removeEventListener("touchcancel", onSheetTouchEnd)
    }
    if (drawer) {
      drawer.removeEventListener("click", onDrawerClick)
      drawer.removeEventListener("touchstart", onDrawerTouchStart)
      drawer.removeEventListener("touchmove", onDrawerTouchMove)
      drawer.removeEventListener("touchend", onDrawerTouchEnd)
      drawer.removeEventListener("touchcancel", onDrawerTouchEnd)
    }
  })
}

document.addEventListener("nav", setupMobileNav)
document.addEventListener("render", setupMobileNav)

// Quartz emits its full-screen Mermaid viewer inside the diagram's overflow
// pre. The transformed article then becomes the containing block for fixed
// descendants, shifting and clipping the viewer on desktop. This component's
// script ships on desktop too, so move an open viewer to the document layer
// and restore it when it closes or the page changes.
const setupDiagramViewers = () => {
  document.querySelectorAll("pre:has(> code.mermaid) > #mermaid-container").forEach((modal) => {
    if (modal.dataset.documentLayerBound) return
    modal.dataset.documentLayerBound = "1"
    const pre = modal.parentElement

    const syncLayer = () => {
      if (modal.classList.contains("active")) {
        if (modal.parentElement !== document.body) document.body.appendChild(modal)
      } else if (pre.isConnected && modal.parentElement !== pre) {
        pre.appendChild(modal)
      }
    }

    const classObserver = new MutationObserver(syncLayer)
    classObserver.observe(modal, { attributes: true, attributeFilter: ["class"] })
    syncLayer()

    window.addCleanup(() => {
      classObserver.disconnect()
      modal.classList.remove("active")
      if (pre.isConnected && modal.parentElement !== pre) pre.appendChild(modal)
      delete modal.dataset.documentLayerBound
    })
  })
}

document.addEventListener("nav", setupDiagramViewers)
document.addEventListener("render", setupDiagramViewers)
