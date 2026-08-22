(function diagramsScript() {
  // The smallest a diagram may be scaled before panning takes over, as a
  // fraction of the size mermaid drew it at. 0.7 puts a 16px label at ~11px,
  // which is where the full-screen viewer lands a wide diagram anyway — so the
  // page and the viewer now agree, rather than the page being the unreadable
  // one.
  var MIN_SCALE = 0.7

  // Fit one rendered diagram. Idempotent: the size it computes comes from
  // mermaid's own viewBox and the container width, never from anything this has
  // previously written, so a re-run after a resize or a re-render cannot drift.
  function fit(svg) {
    var pre = svg.closest("pre")
    // In the full-screen viewer the SVG is moved out to #mermaid-container,
    // where it is sized by the viewer and must be left alone.
    if (!pre) return

    var box = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/)
    var drawn = parseFloat(box[2])
    if (!drawn || !isFinite(drawn)) return

    var cs = getComputedStyle(pre)
    var avail = pre.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    if (!(avail > 0)) return

    // mermaid writes its own inline `max-width: <drawn>px`, and that cap is
    // load-bearing in the other direction: with `width: 100%` and no cap, a
    // diagram *narrower* than the measure stretches to fill it. Stash the
    // original the first time this element is touched, so the fits branch can
    // put it back rather than guess. Dropping it outright blew a 586px diagram
    // up to 720px — a fix for wide diagrams quietly breaking the narrow ones.
    if (svg.dataset.diagramMaxWidth === undefined) {
      svg.dataset.diagramMaxWidth = svg.style.maxWidth || ""
    }

    if (drawn <= avail) {
      // It fits at the size it was drawn. Hand it back to mermaid untouched.
      svg.style.removeProperty("width")
      if (svg.dataset.diagramMaxWidth) svg.style.maxWidth = svg.dataset.diagramMaxWidth
      else svg.style.removeProperty("max-width")
      pre.classList.remove("diagram-pannable")
      return
    }

    var width = Math.max(avail, Math.round(drawn * MIN_SCALE))
    svg.style.width = width + "px"
    svg.style.maxWidth = "none"
    // A 1px slack: a diagram fitted exactly to the container is not pannable,
    // and should not be dressed as though it were.
    pre.classList.toggle("diagram-pannable", width > avail + 1)
  }

  function fitAll() {
    document.querySelectorAll("code.mermaid > svg").forEach(fit)
  }

  function setup() {
    var blocks = document.querySelectorAll("code.mermaid")
    if (!blocks.length) return

    // mermaid renders asynchronously and this component cannot know when it is
    // done, so watch each block until its SVG lands. childList only: the fit
    // writes a style attribute, and observing attributes would see its own work.
    var seen = new MutationObserver(fitAll)
    blocks.forEach(function (b) {
      seen.observe(b, { childList: true, subtree: true })
    })

    // Re-fit when the container width changes — a window resize, the sidebar
    // collapsing, or the text-size dial in theme/ moving the root font size.
    // Observing the `pre` rather than the page is what keeps this from feeding
    // itself: the fit changes the SVG's width and therefore the page's height,
    // but never the width of the box being measured.
    var resized = new ResizeObserver(function (entries) {
      entries.forEach(function (e) {
        var svg = e.target.querySelector("code.mermaid > svg")
        if (svg) fit(svg)
      })
    })
    blocks.forEach(function (b) {
      var pre = b.closest("pre")
      if (pre) resized.observe(pre)
    })

    fitAll()

    if (window.addCleanup) {
      window.addCleanup(function () {
        seen.disconnect()
        resized.disconnect()
      })
    }
  }

  document.addEventListener("nav", setup)
  document.addEventListener("render", setup)
})();