(function topBarScript() {
  var STORE = "symposium:progress:v1"
  var first = true

  function slugOf(a) {
    try {
      var url = new URL(a.getAttribute("href"), location.href)
      if (url.origin !== location.origin) return ""
      var base = (document.body && document.body.dataset.basepath) || ""
      var path = decodeURIComponent(url.pathname)
      if (base && path.indexOf(base) === 0) path = path.slice(base.length)
      return path
        .replace(/^\/+/, "")
        .replace(/\/+$/, "")
        .replace(/\.html$/, "")
        .toLowerCase()
    } catch (e) {
      return ""
    }
  }

  function mark() {
    var pages = {}
    try {
      var state = JSON.parse(localStorage.getItem(STORE) || "null")
      if (state && state.pages) pages = state.pages
    } catch (e) {}
    var tiers = {}
    for (var key in pages) {
      var tier = pages[key] && pages[key].tier
      if (tier === "read" || tier === "known") tiers[key.toLowerCase()] = "read"
      else if (tier === "seen") tiers[key.toLowerCase()] = "seen"
    }
    var links = document.querySelectorAll(
      ".field-outline a.internal, .where-next-list a.internal, .outline-nav a.internal",
    )
    for (var i = 0; i < links.length; i++) {
      var slug = slugOf(links[i])
      var t = tiers[slug] || tiers[slug + "/index"]
      if (t) links[i].setAttribute("data-tier", t)
      else links[i].removeAttribute("data-tier")
    }
  }

  function arrive() {
    var root = document.documentElement
    root.classList.remove("tb-arrived")
    // a reflow between remove and add, or the animation does not restart
    void root.offsetWidth
    root.classList.add("tb-arrived")
    setTimeout(function () {
      root.classList.remove("tb-arrived")
    }, 700)
  }

  function onNav() {
    mark()
    if (first) {
      first = false
      return
    }
    arrive()
  }

  document.addEventListener("nav", onNav)
  // the recorder writes on arrival, a frame or two after `nav`; mark again
  // once it has, so the page you just opened is not drawn as unvisited
  document.addEventListener("nav", function () {
    setTimeout(mark, 400)
  })
})();