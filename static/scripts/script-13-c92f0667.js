(function branchesScript() {
  var KEY = "symposium:progress:v1"
  var SHOWN = 3
  var CAME_WINDOW = 6 * 3600 * 1000

  function base() {
    return ((document.body && document.body.dataset.basepath) || "").replace(/\/$/, "")
  }

  function load() {
    try {
      var s = JSON.parse(window.localStorage.getItem(KEY) || "null")
      return s && typeof s === "object" ? s : { pages: {}, trail: [] }
    } catch (e) {
      return { pages: {}, trail: [] }
    }
  }

  function isRead(state, slug) {
    var p = state.pages && state.pages[slug]
    return !!p && p.tier === "read"
  }

  var graphPromise = null
  function graph() {
    if (!graphPromise) {
      graphPromise = fetch(base() + "/static/graph.json")
        .then(function (r) {
          return r.ok ? r.json() : null
        })
        .catch(function () {
          return null
        })
    }
    return graphPromise
  }

  /** slug -> { title, field, degree, readNear } over the whole graph. */
  function measure(g, state) {
    var bySlug = new Map()
    g.nodes.forEach(function (n, i) {
      bySlug.set(n.s, { i: i, title: n.t, field: n.f, degree: n.d, readNear: 0 })
    })
    g.edges.forEach(function (e) {
      var a = g.nodes[e[0]]
      var b = g.nodes[e[1]]
      if (!a || !b) return
      if (isRead(state, a.s)) bySlug.get(b.s).readNear++
      if (isRead(state, b.s)) bySlug.get(a.s).readNear++
    })
    return bySlug
  }

  /** Unread first, the ones most of what you have read points at leading. */
  function rank(slugs, m, state) {
    return slugs
      .map(function (s) {
        var x = m.get(s)
        return {
          slug: s,
          read: isRead(state, s),
          near: x ? x.readNear : 0,
          degree: x ? x.degree : 0,
        }
      })
      .sort(function (a, b) {
        return (
          a.read - b.read || b.near - a.near || b.degree - a.degree || (a.slug < b.slug ? -1 : 1)
        )
      })
  }

  function link(slug, title) {
    var a = document.createElement("a")
    a.href = base() + "/" + slug
    a.className = "internal"
    a.textContent = title
    return a
  }

  function cameFrom(state, here) {
    var trail = state.trail || []
    for (var i = trail.length - 1; i >= 0; i--) {
      var t = trail[i]
      if (!t || t.slug === here) continue
      if (Date.now() - (t.at || 0) > CAME_WINDOW) return null
      return t.slug
    }
    return null
  }

  function panel(state, m) {
    var host = document.querySelector("[data-branches]")
    if (!host) return
    var here = host.getAttribute("data-branches")
    var list = host.querySelector("[data-branches-list]")
    var rows = new Map()
    Array.prototype.forEach.call(list.children, function (li) {
      rows.set(li.getAttribute("data-slug"), li)
    })
    // a panel restored from an earlier pass holds its read rows in the fold
    var fold = host.querySelector("[data-branches-read]")
    var foldList = fold.querySelector("ol")
    Array.prototype.forEach.call(foldList.children, function (li) {
      rows.set(li.getAttribute("data-slug"), li)
    })

    var ranked = rank(Array.from(rows.keys()), m, state)
    var readCount = 0
    ranked.forEach(function (r) {
      var li = rows.get(r.slug)
      li.toggleAttribute("data-read", r.read)
      li.toggleAttribute("data-near", !r.read && r.near > 0)
      if (r.read) {
        readCount++
        foldList.appendChild(li)
      } else {
        list.appendChild(li)
      }
    })
    fold.hidden = readCount === 0
    fold.querySelector("summary").textContent = "Already read (" + readCount + ")"

    var total = ranked.length
    var meta = host.querySelector("[data-branches-meta]")
    meta.textContent = readCount
      ? readCount + " of " + total + " read"
      : total === 1
        ? "1 linked page"
        : total + " linked pages"

    var came = host.querySelector("[data-branches-came]")
    var from = cameFrom(state, here)
    var fromNode = from && m.get(from)
    came.textContent = ""
    if (fromNode) {
      came.appendChild(document.createTextNode("You came from "))
      came.appendChild(link(from, fromNode.title))
      came.hidden = false
    } else {
      came.hidden = true
    }
  }

  function cards(state, m) {
    var host = document.querySelector("[data-where-next]")
    if (!host) return
    var items = Array.prototype.slice.call(host.querySelectorAll("li[data-slug]"))
    var bySlug = new Map()
    items.forEach(function (li) {
      bySlug.set(li.getAttribute("data-slug"), li)
    })
    var ranked = rank(Array.from(bySlug.keys()), m, state)
    var unread = ranked.filter(function (r) {
      return !r.read
    })
    // every branch read: still offer the strongest three rather than nothing
    var pick = (unread.length ? unread : ranked).slice(0, SHOWN)
    var keep = new Set(
      pick.map(function (r) {
        return r.slug
      }),
    )
    var ol = host.querySelector("ol")
    pick.forEach(function (r) {
      ol.appendChild(bySlug.get(r.slug))
    })
    items.forEach(function (li) {
      var s = li.getAttribute("data-slug")
      li.hidden = !keep.has(s)
      li.toggleAttribute(
        "data-near",
        keep.has(s) &&
          ranked.some(function (r) {
            return r.slug === s && !r.read && r.near > 0
          }),
      )
    })
  }

  /**
   * A field's name as the page already prints it: the home page's sections
   * table links every hub by its title. graph.json only carries the slug.
   */
  function fieldName(field) {
    var hub = document.querySelector(
      'article a[href$="sections/' + field + '/index"], article a[href$="sections/' + field + '/"]',
    )
    var text = hub && hub.textContent.trim()
    return text || String(field).replace(/-/g, " ")
  }

  function start(state, g, m) {
    var host = document.querySelector("[data-branches-start]")
    if (!host) return
    host.textContent = ""
    var read = g.nodes.filter(function (n) {
      return isRead(state, n.s)
    })

    var title = document.createElement("h2")
    title.id = "start-title"
    host.setAttribute("aria-labelledby", "start-title")
    host.appendChild(title)

    if (read.length) {
      title.textContent = "Pick up where you left off"
      var last = null
      var trail = state.trail || []
      for (var i = trail.length - 1; i >= 0 && !last; i--) {
        if (trail[i] && m.has(trail[i].slug)) last = trail[i].slug
      }
      if (last) {
        var p = document.createElement("p")
        p.className = "start-continue"
        p.appendChild(document.createTextNode("Continue with "))
        p.appendChild(link(last, m.get(last).title))
        host.appendChild(p)
      }
      var frontier = g.nodes
        .filter(function (n) {
          return !isRead(state, n.s) && m.get(n.s).readNear > 0
        })
        .sort(function (a, b) {
          return m.get(b.s).readNear - m.get(a.s).readNear || b.d - a.d
        })
      var note = document.createElement("p")
      note.className = "start-note"
      note.textContent =
        read.length +
        (read.length === 1 ? " page read. " : " pages read. ") +
        frontier.length +
        (frontier.length === 1 ? " page is" : " pages are") +
        " one link from what you know."
      host.appendChild(note)
      host.appendChild(group("Closest to what you have read", frontier.slice(0, 6)))
    } else {
      title.textContent = "Where to begin"
      var note2 = document.createElement("p")
      note2.className = "start-note"
      note2.textContent =
        "The most connected pages in each field. Every page lists where it branches to next."
      host.appendChild(note2)
      var grid = document.createElement("div")
      grid.className = "start-fields"
      Object.keys(g.fields || {}).forEach(function (field) {
        var top = g.nodes
          .filter(function (n) {
            return n.f === field
          })
          .sort(function (a, b) {
            return b.d - a.d || (a.s < b.s ? -1 : 1)
          })
          .slice(0, 4)
        grid.appendChild(group(fieldName(field), top))
      })
      host.appendChild(grid)
    }
    var map = document.createElement("p")
    map.className = "start-map"
    map.appendChild(link("map", "Open the reading map"))
    host.appendChild(map)
    host.hidden = false
  }

  function group(label, nodes) {
    var wrap = document.createElement("div")
    wrap.className = "start-group"
    var h = document.createElement("h3")
    h.textContent = label
    wrap.appendChild(h)
    var ol = document.createElement("ol")
    nodes.forEach(function (n) {
      var li = document.createElement("li")
      li.appendChild(link(n.s, n.t))
      ol.appendChild(li)
    })
    wrap.appendChild(ol)
    return wrap
  }

  function run() {
    var wants =
      document.querySelector("[data-branches]") ||
      document.querySelector("[data-where-next]") ||
      document.querySelector("[data-branches-start]")
    if (!wants) return
    graph().then(function (g) {
      if (!g || !g.nodes) return
      var state = load()
      var m = measure(g, state)
      panel(state, m)
      cards(state, m)
      start(state, g, m)
    })
  }

  document.addEventListener("nav", run)
  // progress commits a page as read while the reader is still on it
  window.addEventListener("symposium:state-changed", function () {
    if (document.querySelector("[data-branches-start]")) return
    run()
  })
})();