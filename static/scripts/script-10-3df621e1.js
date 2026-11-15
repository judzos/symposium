(function demoScript() {
  var SLUG = "demo"
  var SEG = 14 // segments per drawn edge
  var FOV = (38 * Math.PI) / 180
  var KINDS = { a: "author", s: "work", c: "concept", e: "entity", t: "topic", y: "synthesis" }
  var FIELD_MARKS = { "machine-learning": "#6ca2d6", biology: "#7fb069" }
  var live = null // the mounted instance, if any
  var chip = null // the "Back to the graph" control left on the page a dive lands on
  var FOCUS_KEY = "sd-focus" // the page "See in 3D" was pressed on

  // ------------------------------------------------------------------ maths

  function rng(seed) {
    var a = seed >>> 0
    return function () {
      a = (a + 0x6d2b79f5) >>> 0
      var t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  var clamp = function (x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x
  }
  var lerp = function (a, b, t) {
    return a + (b - a) * t
  }
  var nearAngle = function (x, ref) {
    return x - Math.PI * 2 * Math.round((x - ref) / (Math.PI * 2))
  }
  var ease = function (t) {
    t = clamp(t, 0, 1)
    return t * t * (3 - 2 * t)
  }
  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2)
    var nf = 1 / (near - far)
    return [
      f / aspect,
      0,
      0,
      0,
      0,
      f,
      0,
      0,
      0,
      0,
      (far + near) * nf,
      -1,
      0,
      0,
      2 * far * near * nf,
      0,
    ]
  }
  function lookAt(e, c) {
    var zx = e[0] - c[0],
      zy = e[1] - c[1],
      zz = e[2] - c[2]
    var l = Math.hypot(zx, zy, zz) || 1
    zx /= l
    zy /= l
    zz /= l
    // up is +y
    var xx = zz,
      xy = 0,
      xz = -zx
    l = Math.hypot(xx, xy, xz) || 1
    xx /= l
    xz /= l
    var yx = zy * xz - zz * xy,
      yy = zz * xx - zx * xz,
      yz = zx * xy - zy * xx
    return [
      xx,
      yx,
      zx,
      0,
      xy,
      yy,
      zy,
      0,
      xz,
      yz,
      zz,
      0,
      -(xx * e[0] + xy * e[1] + xz * e[2]),
      -(yx * e[0] + yy * e[1] + yz * e[2]),
      -(zx * e[0] + zy * e[1] + zz * e[2]),
      1,
    ]
  }
  function mul(a, b) {
    var o = new Array(16)
    for (var c = 0; c < 4; c++)
      for (var r = 0; r < 4; r++)
        o[c * 4 + r] =
          a[r] * b[c * 4] +
          a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] +
          a[12 + r] * b[c * 4 + 3]
    return o
  }

  // ---------------------------------------------------------------- colours

  function cssColour(value, fallback) {
    try {
      var c = document.createElement("canvas")
      c.width = c.height = 1
      var x = c.getContext("2d")
      x.fillStyle = fallback
      x.fillStyle = value
      x.fillRect(0, 0, 1, 1)
      var d = x.getImageData(0, 0, 1, 1).data
      return [d[0] / 255, d[1] / 255, d[2] / 255]
    } catch (e) {
      return [0.85, 0.54, 0.19]
    }
  }
  function hsl(h, s, l) {
    var a = s * Math.min(l, 1 - l)
    var f = function (n) {
      var k = (n + h / 30) % 12
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    }
    return [f(0), f(8), f(4)]
  }
  var hex = function (c) {
    return (
      "#" +
      c
        .map(function (v) {
          return Math.round(clamp(v, 0, 1) * 255)
            .toString(16)
            .padStart(2, "0")
        })
        .join("")
    )
  }
  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
    })
  }
  var plural = function (n, one, many) {
    return n + " " + (n === 1 ? one : many || one + "s")
  }
  function names(list, max) {
    max = max || 3
    if (list.length <= max) {
      if (list.length < 2) return list.join("")
      return list.slice(0, -1).join(", ") + " and " + list[list.length - 1]
    }
    return list.slice(0, max).join(", ") + " and " + (list.length - max) + " more"
  }

  // ----------------------------------------------------------------- layout

  /**
   * Positions are computed at build time by ../layout.js and ship in
   * demo.json, so the page never lays anything out. This only unpacks them.
   */
  function placed(g) {
    var n = g.nodes.length
    var works = new Array(n).fill(0)
    g.by.forEach(function (e) {
      works[e[1]]++
    })
    var lay = g.lay || {}
    return {
      pos: new Float32Array(g.pos || n * 3),
      lobes: lay.lobes || {},
      fields: lay.fields || [],
      works: works,
      top: lay.top || 0,
      stemTop: lay.stemTop || 0,
      stemLen: lay.stemLen || 1,
      maxR: lay.maxR || 1,
    }
  }

  // ------------------------------------------------------------------ WebGL

  var NODE_VS = [
    "#version 300 es",
    "precision highp float;",
    "layout(location=0) in vec3 aPos;",
    "layout(location=1) in vec3 aOrigin;",
    "layout(location=2) in vec3 aBlob;",
    "layout(location=3) in vec3 aColor;",
    "layout(location=4) in vec2 aMeta;", // size, delay
    "layout(location=5) in float aLum;",
    "uniform mat4 uVP; uniform float uBuild, uMorph, uPx, uTime, uShift, uDist, uMinPx;",
    "out vec3 vColor; out float vA;",
    "void main(){",
    "  float g = smoothstep(aMeta.y, aMeta.y + 0.16, uBuild);",
    "  g = 1.0 - pow(1.0 - g, 3.0);",
    "  vec3 p = mix(aOrigin, aPos, g);",
    "  p += 0.012 * vec3(sin(uTime*0.5 + aMeta.y*61.0), cos(uTime*0.43 + aMeta.y*37.0), sin(uTime*0.37 + aMeta.y*83.0));",
    "  vec3 b = aBlob + 0.03 * vec3(sin(uTime*0.9 + aBlob.y*9.0), cos(uTime*0.8 + aBlob.x*9.0), sin(uTime*0.7 + aBlob.z*9.0));",
    "  p = mix(p, b, uMorph);",
    "  gl_Position = uVP * vec4(p, 1.0);",
    "  float w = gl_Position.w;",
    "  gl_Position.x += uShift * w;",
    "  float lum = mix(aLum, 0.42, uMorph);",
    "  float size = mix(aMeta.x, 0.075, uMorph) * (0.62 + lum * 0.75);",
    "  gl_PointSize = max(uMinPx, size * uPx / w) * g;",
    "  float fog = mix(1.0, 0.4, smoothstep(uDist - 1.3, uDist + 1.5, w));",
    "  vec3 grey = vec3(0.56, 0.55, 0.53);",
    "  vColor = mix(aColor, grey, uMorph);",
    "  vA = lum * fog * g;",
    "}",
  ].join("\n")

  var NODE_FS = [
    "#version 300 es",
    "precision highp float;",
    "in vec3 vColor; in float vA; out vec4 o;",
    "void main(){",
    "  float d = length(gl_PointCoord - 0.5) * 2.0;",
    "  if (d > 1.0) discard;",
    "  float core = smoothstep(0.36, 0.24, d);",
    "  float halo = pow(1.0 - d, 2.4);",
    "  float hot = smoothstep(0.2, 0.0, d);",
    "  vec3 c = vColor * (core * 1.05 + halo * 0.42) + vec3(1.0, 0.96, 0.88) * hot * 0.5;",
    "  o = vec4(c * vA, 1.0);",
    "}",
  ].join("\n")

  // One instance per edge; the strip's vertices only carry t along the curve.
  var EDGE_VS = [
    "#version 300 es",
    "precision highp float;",
    "layout(location=0) in float aT;",
    "layout(location=1) in vec3 aA;",
    "layout(location=2) in vec3 aB;",
    "layout(location=3) in vec3 aC;",
    "layout(location=4) in vec4 aMeta;", // delay, kind, seed, unused
    "layout(location=5) in vec3 aColor;",
    "layout(location=6) in float aLum;",
    "uniform mat4 uVP; uniform float uBuild, uMorph, uTime, uShift, uDist, uPx, uPulse, uMode;",
    "uniform float uShow[5];",
    "out vec3 vColor; out float vA;",
    "vec3 bez(float t){ float u = 1.0 - t; return u*u*aA + 2.0*u*t*aC + t*t*aB; }",
    "void main(){",
    "  float grow = smoothstep(aMeta.x, aMeta.x + 0.14, uBuild);",
    "  float fade = (1.0 - uMorph) * (1.0 - uMorph);",
    "  if (uMode < 0.5) {",
    "    float t = aT * grow;",
    "    gl_Position = uVP * vec4(bez(t), 1.0);",
    "    float w = gl_Position.w;",
    "    gl_Position.x += uShift * w;",
    "    float fog = mix(1.0, 0.3, smoothstep(uDist - 1.3, uDist + 1.5, w));",
    "    int kind = int(aMeta.y + 0.5);",
    // credit, authorship, prose links, reading order, missing links
    "    float base = kind == 0 ? 0.30 : kind == 1 ? 0.42 : kind == 2 ? 0.10 + 0.5 * smoothstep(0.95, 1.2, aLum) : kind == 3 ? 0.36 : 0.95;",
    "    vColor = aColor;",
    "    vA = base * aLum * fog * fade * step(0.001, grow) * uShow[kind];",
    "  } else {",
    // a pulse: one point riding the curve from the page end to the author end
    "    float speed = 0.10 + 0.09 * fract(aMeta.z * 7.31);",
    "    float t = fract(uTime * speed + aMeta.z);",
    "    gl_Position = uVP * vec4(bez(t), 1.0);",
    "    float w = gl_Position.w;",
    "    gl_Position.x += uShift * w;",
    "    float ends = smoothstep(0.0, 0.08, t) * smoothstep(1.0, 0.9, t);",
    "    gl_PointSize = max(2.0, 0.05 * uPx / w);",
    "    vColor = mix(aColor, vec3(1.0, 0.95, 0.85), 0.55);",
    "    vA = ends * uPulse * fade * smoothstep(0.25, 0.9, aLum) * step(0.99, grow) * step(aMeta.y, 1.5) * uShow[int(aMeta.y + 0.5)];",
    "  }",
    "}",
  ].join("\n")

  var EDGE_FS = [
    "#version 300 es",
    "precision highp float;",
    "in vec3 vColor; in float vA; uniform float uMode; out vec4 o;",
    "void main(){",
    "  float a = vA;",
    "  if (uMode > 0.5) { float d = length(gl_PointCoord - 0.5) * 2.0; a *= pow(max(0.0, 1.0 - d), 2.0) * 1.6; }",
    "  o = vec4(vColor * a, 1.0);",
    "}",
  ].join("\n")

  function program(gl, vs, fs) {
    var p = gl.createProgram()
    ;[
      [gl.VERTEX_SHADER, vs],
      [gl.FRAGMENT_SHADER, fs],
    ].forEach(function (s) {
      var sh = gl.createShader(s[0])
      gl.shaderSource(sh, s[1])
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh))
      gl.attachShader(p, sh)
    })
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
    var u = {}
    var count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
    for (var i = 0; i < count; i++) {
      var info = gl.getActiveUniform(p, i)
      u[info.name] = gl.getUniformLocation(p, info.name)
    }
    return { p: p, u: u }
  }

  // ------------------------------------------------------------------- page

  function root() {
    return location.pathname.replace(/\/+$/, "").replace(/\/demo$/, "") + "/"
  }

  var CHAPTERS = [
    ["sd-1", "Intake"],
    ["sd-2", "The graph"],
    ["sd-3", "Provenance"],
    ["sd-4", "Between fields"],
    ["sd-5", "Growth"],
    ["sd-6", "Upkeep"],
    ["sd-7", "Architecture"],
  ]

  var num = function (n) {
    return Number(n || 0).toLocaleString("en")
  }

  function row(label, value, note) {
    return (
      "<li><span>" +
      label +
      (note ? "<small>" + note + "</small>" : "") +
      "</span><b>" +
      value +
      "</b></li>"
    )
  }

  function kicker(n, label) {
    return '<p class="sd-kicker"><b>0' + n + "</b>" + label + "</p>"
  }

  function planned(text) {
    return '<p class="sd-planned"><b>planned</b>' + text + "</p>"
  }

  function buildDom(g, story, base) {
    var el = document.createElement("div")
    el.className = "sd-root"
    el.setAttribute("data-chapter", "0")
    var counts = story.counts
    var facts = g.facts || {}
    var fieldRows = story.fields
      .map(function (f) {
        return (
          '<a class="sd-toc-row" href="' +
          base +
          "sections/" +
          esc(f.slug) +
          '/"><span class="sd-toc-name"><i style="background:' +
          f.colour +
          '"></i>' +
          esc(f.title) +
          '</span><span class="sd-toc-note">' +
          plural(f.pages, "page") +
          " from " +
          plural(f.works, "work") +
          '</span><span class="sd-arrow">→</span></a>'
        )
      })
      .join("")

    var star = story.work
    var page = story.page
    var net = story.net
    var cross = story.cross
    var walk = story.walk
    var stale = story.stale
    var link = function (x) {
      return (
        '<a data-sd-node="' + x.i + '" href="' + base + esc(x.slug) + '">' + esc(x.title) + "</a>"
      )
    }

    // 1 — intake: one real work, measured
    var intake = ""
    if (star) {
      intake =
        "<p>The one lit here is " +
        link(star) +
        ", by " +
        esc(names(star.authors)) +
        ".</p>" +
        '<ul class="sd-credit sd-ledger">' +
        (star.w ? row("Read in full", num(star.w) + " words", "kept private") : "") +
        (star.pw
          ? row(
              "Distilled to",
              num(star.pw) + " words",
              "depth " + (star.dp == null ? 20 : star.dp) + " of 100",
            )
          : "") +
        row("Pages it feeds", num(star.pages)) +
        row(
          "Other works on those pages",
          num(star.others),
          star.otherAuthors ? "by " + plural(star.otherAuthors, "other author") : "",
        ) +
        "</ul>" +
        "<p>Watch the last line. Several works feed each page, so you read this author’s ideas next to what other people wrote about the same thing.</p>"
    }

    // 2 — the graph: five layers, only one of which a notes vault has
    var layers =
      '<ul class="sd-layers">' +
      '<li data-sd-layer="2"><i class="sd-l-2"></i><span>Links written in prose<small>the only layer a notes vault has</small></span><b>' +
      num(net.links) +
      "</b></li>" +
      '<li data-sd-layer="0"><i class="sd-l-0"></i><span>Page to the works it came from<small>read from each page’s <code>sources:</code></small></span><b>' +
      num(net.cites) +
      "</b></li>" +
      '<li data-sd-layer="1"><i class="sd-l-1"></i><span>Work to the person who wrote it<small>read from each work’s <code>author:</code></small></span><b>' +
      num(net.by) +
      "</b></li>" +
      '<li data-sd-layer="3"><i class="sd-l-3"></i><span>Reading order<small>computed from each field’s topic pages</small></span><b>' +
      num(net.seq) +
      "</b></li>" +
      '<li data-sd-layer="4"><i class="sd-l-4"></i><span>Links the prose forgot<small>a page names another and never links it</small></span><b>' +
      num(net.hints) +
      "</b></li>" +
      "</ul>"

    // 3 — provenance
    var ledger = ""
    if (page) {
      ledger =
        "<p>" +
        link(page) +
        " is built from " +
        plural(page.works.length, "work") +
        ':</p><ul class="sd-credit">' +
        page.shares
          .map(function (s) {
            return (
              "<li><span>" +
              esc(s.name) +
              "</span><b>" +
              Math.round((s.n / page.works.length) * 100) +
              "% · " +
              plural(s.n, "work") +
              "</b></li>"
            )
          })
          .join("") +
        "</ul>"
    }

    // 4 — between fields
    var between =
      '<ul class="sd-credit sd-ledger">' +
      row("Fields", num(story.fields.length)) +
      row("Links that cross between them", num(cross.links)) +
      row(
        "Authors writing in more than one",
        num(cross.authors.length),
        cross.authors.length ? esc(names(cross.authors, 2)) : "",
      ) +
      "</ul>" +
      (cross.links === 0
        ? "<p>No page links across a field boundary yet. Bridges, below, will add those links.</p>"
        : "") +
      planned(
        "Bridges: a kind of page that puts what one author says beside what an author in another field says, each claim sourced, and labels the link as one neither of them drew. If a real work already draws it, the bridge cites that work and drops the label.",
      )

    // 5 — growth
    var growth =
      (walk.mine
        ? "<p>This is your own trail: " +
          plural(walk.len, "page") +
          ", recorded in this browser as you read. The dim lights around it are the " +
          num(walk.frontier) +
          " pages one link away.</p>"
        : "<p>This is an example walk through " +
          plural(walk.len, "page") +
          ". As you read, the wiki records your own trail in this browser, and the dim lights one link from it, " +
          num(walk.frontier) +
          " here, are where you are likely to go next.</p>") +
      "<p>A reader’s agent reads that trail and ranks what lies just past its edge: topics named but not yet written, links that led nowhere, connections back to places you already visited. It writes those first, a little in every field and the most wherever readers keep returning.</p>" +
      "<p>Built now: frontier pages, unexplored places drawn dim that hold a name and the real works found for it and nothing else, and the loop that ranks an exported trail into jobs. Each job passes the same checks as any ingest, and before a person accepts a new paragraph, the tools show it beside the passage in its sources that supports it.</p>" +
      planned("Linking your own agent, so the loop runs on your trail instead of the maintainer’s.")

    // 6 — upkeep
    var upkeep =
      (stale
        ? "<p>" +
          link(stale) +
          " feeds " +
          plural(stale.pages, "page") +
          ". Rewrite it and the wiki flags all of them stale until someone rereads each against the new version. A page records what its sources said on the day someone wrote it.</p>"
        : "") +
      '<ol class="sd-pipe"><li><b>intake</b>fetch, scaffold, set a depth budget</li><li><b>credit</b>shares computed from <code>sources:</code></li><li><b>regenerate</b>outlines, counts, catalogues</li><li><b>verify</b>every page traces to an author</li><li><b>linkcheck</b>every link resolves</li></ol>' +
      "<p>The whole pass takes about a second. The deploy runs both checks first and publishes nothing if either fails.</p>"

    var arch =
      '<div class="sd-three sd-arch">' +
      "<div><b>private</b><h3>The pipeline</h3><p>Full texts, a summary of each work, and the tools that read, distil, link, credit and check. The texts belong to their authors, so this half stays private.</p></div>" +
      "<div><b>public</b><h3>The wiki</h3><p>Concept pages only, " +
      num(counts.pages) +
      " of them. Each cites the works it rests on and links out to the originals. This page is drawn from it.</p></div>" +
      '<div><b class="sd-soon">planned</b><h3>Your agent</h3><p>Linked to your trail, it grows the map in the direction you are going, through the same checks. The model carries what the works say to you and adds no claims of its own.</p></div>' +
      "</div>"

    el.innerHTML =
      '<canvas class="sd-canvas" aria-hidden="true"></canvas>' +
      '<div class="sd-veil" aria-hidden="true"></div>' +
      '<header class="sd-nav">' +
      '<a class="sd-word" href="' +
      base +
      '">symposium</a>' +
      '<nav class="sd-links" aria-label="Chapters">' +
      CHAPTERS.map(function (c) {
        return '<a href="#' + c[0] + '">' + c[1] + "</a>"
      }).join("") +
      "</nav>" +
      '<button class="sd-btn sd-ghost" type="button" data-sd-free>Explore the graph</button>' +
      '<a class="sd-btn sd-solid" href="' +
      base +
      '">Open the wiki</a>' +
      "</header>" +
      '<div class="sd-scroll" tabindex="-1">' +
      // 0 — hero
      '<section class="sd-ch sd-hero" id="sd-0">' +
      '<div class="sd-hero-inner">' +
      '<h1 class="sd-display">A map of human knowledge that grows where you walk.</h1>' +
      '<p class="sd-lede">Symposium reads what named people have written and distils each work into pages. A pipeline computes the links between those pages, the order to read them in, and who gets credit. As you read, it records where you went and grows the map in that direction.</p>' +
      '<p class="sd-stats"><span><b>' +
      num(counts.pages) +
      "</b>pages</span><span><b>" +
      num(counts.works) +
      "</b>works</span><span><b>" +
      num(counts.authors) +
      "</b>authors</span><span><b>" +
      num(story.fields.length) +
      "</b>" +
      (story.fields.length === 1 ? "field" : "fields") +
      "</span></p>" +
      "</div>" +
      '<div class="sd-hint" aria-hidden="true"><span></span>scroll</div>' +
      "</section>" +
      // 1 — intake
      '<section class="sd-ch" id="sd-1"><div class="sd-copy">' +
      kicker(1, "intake") +
      "<h2>A work goes in. Its ideas come out as pages.</h2>" +
      "<p>Every page starts from something a named person wrote. The pipeline fetches the work into a private store, sets a depth budget for how much of it a page should carry, and writes its ideas into pages that other works feed too.</p>" +
      intake +
      "</div></section>" +
      // 2 — the graph
      '<section class="sd-ch sd-wide sd-graph" id="sd-2"><div class="sd-copy">' +
      kicker(2, "the graph") +
      "<h2>A notes vault keeps the links you typed. Symposium computes the rest.</h2>" +
      '<div class="sd-switch" role="group" aria-label="Which links to draw">' +
      '<button type="button" data-sd-mode="vault" aria-pressed="false">Hand-linked</button>' +
      '<button type="button" data-sd-mode="full" aria-pressed="true">Computed</button>' +
      "</div>" +
      layers +
      "<p>" +
      (net.islands
        ? "Switch to hand-linked and " +
          plural(net.islands, "page") +
          " float free, tied to nothing. "
        : "Switch to hand-linked and every page is still there, but nothing says where it came from, who wrote it, or what to read next. ") +
      "The computed layers tie each page to its works and their authors. The pipeline rebuilds all of them from frontmatter on every change, so they stay true to the pages.</p>" +
      "</div></section>" +
      // 3 — provenance
      '<section class="sd-ch" id="sd-3"><div class="sd-copy">' +
      kicker(3, "provenance") +
      "<h2>Credit follows the works a page cites.</h2>" +
      "<p>Each page lists the works it was built from, and the pipeline computes credit from that list alone. The moving lights trace it: page to work, work to author.</p>" +
      ledger +
      "<p>Point at any light to send its credit down the stem. If a page traces to no author, the build fails.</p>" +
      "</div></section>" +
      // 4 — between fields
      '<section class="sd-ch" id="sd-4"><div class="sd-copy">' +
      kicker(4, "between fields") +
      "<h2>Symposium exists for the links between fields.</h2>" +
      "<p>Each field grows as its own lobe. The good questions sit between lobes, where an idea in one field already has a name in another.</p>" +
      between +
      "</div></section>" +
      // 5 — growth
      '<section class="sd-ch" id="sd-5"><div class="sd-copy">' +
      kicker(5, "growth") +
      "<h2>It grows where you walk.</h2>" +
      growth +
      "</div></section>" +
      // 6 — upkeep
      '<section class="sd-ch" id="sd-6"><div class="sd-copy">' +
      kicker(6, "upkeep") +
      "<h2>Change one work and the wiki knows what it touched.</h2>" +
      upkeep +
      "</div></section>" +
      // 7 — architecture
      '<section class="sd-ch sd-wide" id="sd-7"><div class="sd-copy">' +
      kicker(7, "architecture") +
      "<h2>Two halves built, a third on the way.</h2>" +
      arch +
      "</div></section>" +
      // 8 — explore
      '<section class="sd-ch sd-end" id="sd-8"><div class="sd-copy">' +
      '<p class="sd-kicker"><b>08</b>yours</p>' +
      '<h2 class="sd-display sd-display-2">Pick a light.</h2>' +
      "<p>Every point is a real page. Click one and you are reading it.</p>" +
      '<p class="sd-actions"><button class="sd-btn sd-solid" type="button" data-sd-free>Explore the graph</button><a class="sd-btn sd-ghost" href="' +
      base +
      '">Open the wiki</a></p>' +
      '<div class="sd-toc"><p class="sd-kicker">contents</p>' +
      fieldRows +
      '<a class="sd-toc-row" href="' +
      base +
      'authors/"><span class="sd-toc-name">Authors</span><span class="sd-toc-note">every writer and what was built from them</span><span class="sd-arrow">→</span></a>' +
      '<a class="sd-toc-row" href="' +
      base +
      'learn"><span class="sd-toc-name">Learn</span><span class="sd-toc-note">guided paths with a finish line</span><span class="sd-arrow">→</span></a>' +
      '<a class="sd-toc-row" href="' +
      base +
      'map"><span class="sd-toc-name">Reading map</span><span class="sd-toc-note">what you have read, and what is next</span><span class="sd-arrow">→</span></a>' +
      '<a class="sd-toc-row" href="' +
      base +
      'submit"><span class="sd-toc-name">Submit a source</span><span class="sd-toc-note">propose a work for review</span><span class="sd-arrow">→</span></a>' +
      "</div></div></section>" +
      "</div>" +
      '<div class="sd-tags" aria-hidden="true"></div>' +
      '<div class="sd-card" hidden></div>' +
      '<ol class="sd-dots" aria-hidden="true">' +
      [0, 1, 2, 3, 4, 5, 6, 7, 8]
        .map(function (i) {
          return '<li data-sd-dot="' + i + '">' + (i === 0 ? "·" : i) + "</li>"
        })
        .join("") +
      "</ol>" +
      '<div class="sd-legend" aria-hidden="true">' +
      '<span><i class="sd-k-a"></i>author</span><span><i class="sd-k-s"></i>work</span><span><i class="sd-k-p"></i>page</span>' +
      story.fields
        .map(function (f) {
          return (
            '<span><i style="background:' +
            f.colour +
            '"></i>' +
            esc(f.title.toLowerCase()) +
            "</span>"
          )
        })
        .join("") +
      "</div>" +
      '<div class="sd-freebar"><span>Drag to turn · scroll to zoom · click a light to read it</span><button class="sd-btn sd-ghost" type="button" data-sd-unfree>Back to the tour</button></div>' +
      '<div class="sd-flood" aria-hidden="true"></div>'
    return el
  }

  function mount(g) {
    var docEl = document.documentElement
    var base = root()
    var nodes = g.nodes
    var n = nodes.length
    var L = placed(g)
    var pos = L.pos
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches

    // ------------------------------------------------------- derived facts
    var citesOf = nodes.map(function () {
      return []
    }) // page -> sources
    var citedBy = nodes.map(function () {
      return []
    }) // source -> pages
    var authorsOf = nodes.map(function () {
      return []
    }) // source -> authors
    var worksOf = nodes.map(function () {
      return []
    }) // author -> sources
    var linked = nodes.map(function () {
      return []
    })
    g.cites.forEach(function (e) {
      citesOf[e[0]].push(e[1])
      citedBy[e[1]].push(e[0])
    })
    g.by.forEach(function (e) {
      authorsOf[e[0]].push(e[1])
      worksOf[e[1]].push(e[0])
    })
    g.links.forEach(function (e) {
      linked[e[0]].push(e[1])
      linked[e[1]].push(e[0])
    })

    var isPage = function (i) {
      var k = nodes[i].k
      return k !== "a" && k !== "s"
    }
    var pageAuthors = function (i) {
      var tally = new Map()
      citesOf[i].forEach(function (s) {
        authorsOf[s].forEach(function (a) {
          tally.set(a, (tally.get(a) || 0) + 1)
        })
      })
      return tally
    }

    // ------------------------------------------------------------ colours
    var cs = getComputedStyle(docEl)
    var accent = cssColour(cs.getPropertyValue("--secondary"), "#d98930")
    var bright = cssColour(cs.getPropertyValue("--tertiary"), "#f5c040")
    var paper = cs.getPropertyValue("--light").trim() || "#070503"
    var fieldColour = {}
    L.fields.forEach(function (f, i) {
      if (i === 0) fieldColour[f] = accent
      else if (FIELD_MARKS[f]) fieldColour[f] = cssColour(FIELD_MARKS[f], "#6ca2d6")
      else fieldColour[f] = hsl((205 + i * 97) % 360, 0.5, 0.63)
    })
    var inkAuthor = [1.0, 0.93, 0.78]

    // -------------------------------------------------------------- story
    var counts = { pages: 0, works: 0, authors: 0 }
    nodes.forEach(function (nd, i) {
      if (nd.k === "a") counts.authors++
      else if (nd.k === "s") counts.works++
      else counts.pages++
    })
    var bestWork = -1
    nodes.forEach(function (nd, i) {
      if (nd.k !== "s" || !authorsOf[i].length) return
      if (bestWork < 0 || citedBy[i].length > citedBy[bestWork].length) bestWork = i
    })
    var bestPage = -1,
      bestScore = -1
    nodes.forEach(function (nd, i) {
      if (nd.k !== "c" && nd.k !== "e") return
      // the clearest case of computed credit: a few works, a few authors, and
      // unequal shares, so the ledger in chapter 3 has something to show
      var tallyOf = pageAuthors(i)
      var a = tallyOf.size
      var w = citesOf[i].length
      if (a < 2 || a > 4 || w < 3 || w > 6) return
      var top = Math.max.apply(null, Array.from(tallyOf.values()))
      var score = top * 10 + a * 3 + w + (top < w ? 5 : 0)
      if (score > bestScore) {
        bestScore = score
        bestPage = i
      }
    })
    if (bestPage < 0)
      nodes.forEach(function (nd, i) {
        if (isPage(i) && citesOf[i].length > (bestPage < 0 ? 0 : citesOf[bestPage].length))
          bestPage = i
      })
    var story = {
      counts: counts,
      fields: L.fields.map(function (f) {
        var pages = 0,
          works = 0
        nodes.forEach(function (nd) {
          if (nd.f !== f || nd.k === "a") return
          if (nd.k === "s") works++
          else pages++
        })
        return {
          slug: f,
          title: g.fields[f] || f,
          pages: pages,
          works: works,
          colour: hex(fieldColour[f]),
        }
      }),
      work:
        bestWork < 0
          ? null
          : {
              i: bestWork,
              slug: nodes[bestWork].s,
              title: nodes[bestWork].t,
              pages: citedBy[bestWork].length,
              authors: authorsOf[bestWork].map(function (a) {
                return nodes[a].t
              }),
            },
      page: null,
    }
    if (bestPage >= 0) {
      var tally = pageAuthors(bestPage)
      story.page = {
        i: bestPage,
        slug: nodes[bestPage].s,
        title: nodes[bestPage].t,
        works: citesOf[bestPage],
        shares: Array.from(tally.entries())
          .sort(function (a, b) {
            return b[1] - a[1] || nodes[a[0]].t.localeCompare(nodes[b[0]].t)
          })
          .slice(0, 5)
          .map(function (e) {
            return { name: nodes[e[0]].t, n: e[1] }
          }),
      }
    }

    // a reading trail through the largest field, for the learning chapter
    var trail = []
    ;(function () {
      var start = -1
      nodes.forEach(function (nd, i) {
        if (nd.f !== L.fields[0] || nd.k !== "t") return
        if (start < 0 || linked[i].length > linked[start].length) start = i
      })
      if (start < 0) return
      var seen = new Set([start])
      var at = start
      trail.push(at)
      while (trail.length < 11) {
        var next = -1
        linked[at].forEach(function (j) {
          if (seen.has(j) || nodes[j].f !== L.fields[0]) return
          if (next < 0 || linked[j].length > linked[next].length) next = j
        })
        if (next < 0) break
        seen.add(next)
        trail.push(next)
        at = next
      }
    })()

    // the reader's own trail, if the progress recorder has one: the growth
    // chapter walks it instead of the example walk above
    var mine = false
    ;(function () {
      var bySlug = new Map()
      nodes.forEach(function (nd, i) {
        if (isPage(i)) bySlug.set(nd.s.toLowerCase(), i)
      })
      var saved
      try {
        saved = JSON.parse(localStorage.getItem("symposium:progress:v1") || "null")
      } catch (e) {
        saved = null
      }
      var steps = []
      ;((saved && saved.trail) || []).forEach(function (t) {
        var i = bySlug.get(
          String(t.slug || "")
            .replace(/\/+$/, "")
            .toLowerCase(),
        )
        if (i === undefined || steps[steps.length - 1] === i) return
        steps.push(i)
      })
      var seenStep = new Set()
      steps = steps
        .reverse()
        .filter(function (i) {
          if (seenStep.has(i)) return false
          seenStep.add(i)
          return true
        })
        .slice(0, 16)
        .reverse()
      if (steps.length >= 3) {
        trail = steps
        mine = true
      }
    })()

    // intake: what else meets the work on the pages it feeds
    if (story.work) {
      var wk = story.work.i
      var others = new Set(),
        otherAuthors = new Set()
      citedBy[wk].forEach(function (p) {
        citesOf[p].forEach(function (s) {
          if (s === wk) return
          others.add(s)
          authorsOf[s].forEach(function (a) {
            if (authorsOf[wk].indexOf(a) < 0) otherAuthors.add(a)
          })
        })
      })
      story.work.others = others.size
      story.work.otherAuthors = otherAuthors.size
      story.work.otherSet = others
      story.work.w = nodes[wk].w
      story.work.pw = nodes[wk].pw
      story.work.dp = nodes[wk].dp
    }

    // the graph's layers, and what a hand-linked vault would leave stranded
    var islands = 0
    nodes.forEach(function (nd, i) {
      if (isPage(i) && !linked[i].length) islands++
    })
    story.net = {
      links: g.links.length,
      cites: g.cites.length,
      by: g.by.length,
      seq: (g.seq || []).length,
      hints: (g.hints || []).length,
      islands: islands,
    }

    // between fields: links that cross, and the authors who already do
    var crossNodes = new Map()
    var crossLinks = 0
    g.links.forEach(function (e) {
      if (nodes[e[0]].f !== nodes[e[1]].f) {
        crossLinks++
        crossNodes.set(e[0], 1)
        crossNodes.set(e[1], 1)
      }
    })
    var crossAuthors = []
    nodes.forEach(function (nd, i) {
      if (nd.k !== "a") return
      var fs = new Set()
      worksOf[i].forEach(function (s) {
        fs.add(nodes[s].f)
      })
      if (fs.size < 2) return
      crossAuthors.push(i)
      crossNodes.set(i, 1)
      worksOf[i].forEach(function (s) {
        crossNodes.set(s, 0.8)
      })
    })
    crossAuthors.sort(function (a, b) {
      return worksOf[b].length - worksOf[a].length
    })
    story.cross = {
      links: crossLinks,
      authors: crossAuthors.map(function (a) {
        return nodes[a].t
      }),
      ids: crossAuthors,
      focus: crossNodes,
    }

    // growth: the walk, and how much lies one link past it
    var walkSet = new Set(trail)
    var rim = new Set()
    trail.forEach(function (id) {
      linked[id].forEach(function (j) {
        if (!walkSet.has(j)) rim.add(j)
      })
    })
    story.walk = { mine: mine, len: trail.length, frontier: rim.size }

    // upkeep: a second well-used work, from another field where there is one,
    // so the chapter neither repeats intake nor shows the same field twice
    var pickStale = function (otherField) {
      var best = -1
      nodes.forEach(function (nd, i) {
        if (nd.k !== "s" || i === bestWork || citedBy[i].length < 2) return
        if (otherField && bestWork >= 0 && nd.f === nodes[bestWork].f) return
        if (best < 0 || citedBy[i].length > citedBy[best].length) best = i
      })
      return best
    }
    var staleWork = pickStale(true)
    if (staleWork < 0) staleWork = pickStale(false)
    if (staleWork < 0) staleWork = bestWork
    story.stale =
      staleWork < 0
        ? null
        : {
            i: staleWork,
            slug: nodes[staleWork].s,
            title: nodes[staleWork].t,
            pages: citedBy[staleWork].length,
          }

    // ---------------------------------------------------------------- DOM
    var el = buildDom(g, story, base)
    el.style.setProperty("--sd-paper", paper)
    el.style.setProperty("--sd-accent", hex(accent))
    el.style.setProperty("--sd-bright", hex(bright))
    docEl.appendChild(el)
    docEl.classList.add("sd-on")
    docEl.classList.remove("sd-pending")

    var canvas = el.querySelector(".sd-canvas")
    var scroller = el.querySelector(".sd-scroll")
    var card = el.querySelector(".sd-card")
    var tagsEl = el.querySelector(".sd-tags")
    var flood = el.querySelector(".sd-flood")
    var sections = Array.prototype.slice.call(el.querySelectorAll(".sd-ch"))
    var dots = Array.prototype.slice.call(el.querySelectorAll("[data-sd-dot]"))

    var gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: true,
      powerPreference: "high-performance",
    })
    if (!gl) {
      el.remove()
      docEl.classList.remove("sd-on")
      return null
    }

    // ------------------------------------------------------------ buffers
    var rand = rng(0xb10b)
    var delay = new Float32Array(n)
    var origin = new Float32Array(n * 3)
    var blob = new Float32Array(n * 3)
    var colour = new Float32Array(n * 3)
    var meta = new Float32Array(n * 2)
    var size = new Float32Array(n)
    var stemBase = [0.02, L.stemTop - L.stemLen, -0.32]
    var ys = []
    nodes.forEach(function (nd, i) {
      if (nd.k === "a") ys.push(pos[i * 3 + 1])
    })
    var yLo = Math.min.apply(null, ys.concat([L.stemTop - 0.01])),
      yHi = Math.max.apply(null, ys.concat([L.stemTop]))
    nodes.forEach(function (nd, i) {
      var c, o
      if (nd.k === "a") {
        delay[i] = 0.02 + 0.2 * ((pos[i * 3 + 1] - yLo) / (yHi - yLo || 1))
        o = stemBase
        c = inkAuthor
        size[i] = Math.min(0.42, 0.085 + 0.022 * Math.sqrt(L.works[i]))
      } else if (nd.k === "s") {
        delay[i] = 0.24 + rand() * 0.2
        var a = authorsOf[i][0]
        o = a === undefined ? stemBase : [pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]]
        c = fieldColour[nd.f].map(function (v, k) {
          return v * 0.78 + inkAuthor[k] * 0.04
        })
        size[i] = 0.062
      } else {
        delay[i] = 0.48 + rand() * 0.3
        var s = citesOf[i][0]
        var lobe = L.lobes[nd.f]
        o = s === undefined ? lobe.c : [pos[s * 3], pos[s * 3 + 1], pos[s * 3 + 2]]
        var f = fieldColour[nd.f]
        var lift = nd.k === "t" || nd.k === "y" ? 0.45 : 0.16
        c = f.map(function (v, k) {
          return lerp(v, k === 0 ? 1 : k === 1 ? 0.92 : 0.74, lift)
        })
        size[i] =
          (nd.k === "t" || nd.k === "y" ? 0.12 : 0.07) +
          0.011 * Math.sqrt(citesOf[i].length + linked[i].length * 0.4)
      }
      origin.set(o, i * 3)
      colour.set(c, i * 3)
      meta[i * 2] = size[i]
      meta[i * 2 + 1] = delay[i]
      // the anonymous version: one shapeless ball
      var z = rand() * 2 - 1,
        t = rand() * Math.PI * 2,
        r = Math.sqrt(1 - z * z),
        rr = 0.78 * Math.cbrt(rand())
      blob[i * 3] = r * Math.cos(t) * rr
      blob[i * 3 + 1] = z * rr - 0.2
      blob[i * 3 + 2] = r * Math.sin(t) * rr
    })

    // edges: cites and by first, because only those carry pulses
    var edges = []
    var stemHead = [0.02, L.stemTop + 0.18, 0]
    g.cites.forEach(function (e) {
      edges.push({ a: e[0], b: e[1], kind: 0 })
    })
    g.by.forEach(function (e) {
      edges.push({ a: e[0], b: e[1], kind: 1 })
    })
    var pulseCount = edges.length
    g.links.forEach(function (e) {
      edges.push({ a: e[0], b: e[1], kind: 2 })
    })
    ;(g.seq || []).forEach(function (e) {
      edges.push({ a: e[0], b: e[1], kind: 3 })
    })
    ;(g.hints || []).forEach(function (e) {
      edges.push({ a: e[0], b: e[1], kind: 4 })
    })
    var E = edges.length
    var eA = new Float32Array(E * 3),
      eB = new Float32Array(E * 3),
      eC = new Float32Array(E * 3),
      eMeta = new Float32Array(E * 4),
      eColour = new Float32Array(E * 3),
      eLum = new Float32Array(E)
    edges.forEach(function (e, i) {
      var a = e.a * 3,
        b = e.b * 3
      var fa = nodes[e.a].f
      var lobe = L.lobes[fa] || { c: [0, 0, 0] }
      var mx = (pos[a] + pos[b]) / 2,
        my = (pos[a + 1] + pos[b + 1]) / 2,
        mz = (pos[a + 2] + pos[b + 2]) / 2
      var pull, tx, ty, tz
      if (e.kind === 1) {
        // work -> author: gather into the top of the stem before running down it
        tx = lerp(lobe.c[0], stemHead[0], 0.72)
        ty = stemHead[1]
        tz = stemHead[2]
        pull = 0.8
      } else {
        tx = lobe.c[0]
        ty = lobe.c[1]
        tz = lobe.c[2]
        pull = e.kind === 0 ? 0.3 : 0.42
      }
      eA.set([pos[a], pos[a + 1], pos[a + 2]], i * 3)
      eB.set([pos[b], pos[b + 1], pos[b + 2]], i * 3)
      eC.set([lerp(mx, tx, pull), lerp(my, ty, pull), lerp(mz, tz, pull)], i * 3)
      eMeta[i * 4] = Math.min(0.84, Math.max(delay[e.a], delay[e.b]) + 0.06)
      eMeta[i * 4 + 1] = e.kind
      eMeta[i * 4 + 2] = rand()
      var c = fieldColour[fa] || accent
      if (e.kind === 1)
        c = c.map(function (v, k) {
          return lerp(v, inkAuthor[k], 0.45)
        })
      else if (e.kind === 3)
        c = c.map(function (v, k) {
          return lerp(v, inkAuthor[k], 0.5)
        })
      else if (e.kind === 4) c = bright
      eColour.set(c, i * 3)
    })

    function buf(data, usage) {
      var b = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, b)
      gl.bufferData(gl.ARRAY_BUFFER, data, usage || gl.STATIC_DRAW)
      return b
    }
    function attr(loc, buffer, sizeOf, divisor) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, sizeOf, gl.FLOAT, false, 0, 0)
      if (divisor) gl.vertexAttribDivisor(loc, divisor)
    }

    var nodeProg, edgeProg
    try {
      nodeProg = program(gl, NODE_VS, NODE_FS)
      edgeProg = program(gl, EDGE_VS, EDGE_FS)
    } catch (err) {
      console.error("symposium demo: shader failed", err)
      el.remove()
      docEl.classList.remove("sd-on")
      return null
    }

    var lum = new Float32Array(n)
    var lumTarget = new Float32Array(n)
    var nodeVao = gl.createVertexArray()
    gl.bindVertexArray(nodeVao)
    attr(0, buf(pos), 3)
    attr(1, buf(origin), 3)
    attr(2, buf(blob), 3)
    attr(3, buf(colour), 3)
    attr(4, buf(meta), 2)
    var lumBuf = buf(lum, gl.DYNAMIC_DRAW)
    attr(5, lumBuf, 1)

    var ts = new Float32Array(SEG + 1)
    for (var s = 0; s <= SEG; s++) ts[s] = s / SEG
    var edgeVao = gl.createVertexArray()
    gl.bindVertexArray(edgeVao)
    attr(0, buf(ts), 1)
    attr(1, buf(eA), 3, 1)
    attr(2, buf(eB), 3, 1)
    attr(3, buf(eC), 3, 1)
    attr(4, buf(eMeta), 4, 1)
    attr(5, buf(eColour), 3, 1)
    var eLumBuf = buf(eLum, gl.DYNAMIC_DRAW)
    attr(6, eLumBuf, 1, 1)
    gl.bindVertexArray(null)

    // ------------------------------------------------------------ chapters
    var BASE = { a: 0.95, s: 0.5, c: 0.66, e: 0.66, t: 0.9, y: 0.9 }
    var centre = [0, (L.top + L.stemTop - L.stemLen) / 2 + 0.12, 0]
    var span = L.top - (L.stemTop - L.stemLen)
    var farDist = span / (2 * Math.tan(FOV / 2)) + 1.5
    var focusDist = Math.max(0.9, farDist * 0.32) // close enough to read a neighbourhood

    function setOf(list) {
      var m = new Map()
      list.forEach(function (x) {
        if (Array.isArray(x)) m.set(x[0], x[1])
        else m.set(x, 1)
      })
      return m
    }
    function centroid(ids) {
      var c = [0, 0, 0]
      ids.forEach(function (i) {
        c[0] += pos[i * 3]
        c[1] += pos[i * 3 + 1]
        c[2] += pos[i * 3 + 2]
      })
      return c.map(function (v) {
        return v / (ids.length || 1)
      })
    }
    function face(c) {
      return Math.atan2(c[0] - centre[0], c[2] - centre[2])
    }
    function frame(ids, pad) {
      // the middle of the box, not the mean: one page and thirty authors would
      // otherwise be framed on the authors and leave the page off screen
      var lo = [Infinity, Infinity, Infinity],
        hi = [-Infinity, -Infinity, -Infinity]
      ids.forEach(function (i) {
        for (var d = 0; d < 3; d++) {
          lo[d] = Math.min(lo[d], pos[i * 3 + d])
          hi[d] = Math.max(hi[d], pos[i * 3 + d])
        }
      })
      var c = ids.length
        ? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
        : centre.slice()
      var r = 0.25
      ids.forEach(function (i) {
        r = Math.max(r, Math.hypot(pos[i * 3] - c[0], pos[i * 3 + 1] - c[1], pos[i * 3 + 2] - c[2]))
      })
      return {
        target: c,
        yaw: face(centroid(ids)),
        dist: Math.min(farDist, (r * (pad || 1.5)) / Math.tan(FOV / 2) + 0.4),
      }
    }

    var SHOW_BASE = [1, 1, 1, 0, 0]
    var SHOW_VAULT = [0, 0, 1, 0, 0]
    var SHOW_ALL = [1, 1, 1, 1, 1]

    // 1: the work, the people who wrote it, the pages it feeds, and dimmer, the
    // other works those pages also stand on
    var focusIntake = null
    if (story.work) {
      focusIntake = new Map()
      story.work.otherSet.forEach(function (s) {
        focusIntake.set(s, 0.42)
      })
      citedBy[story.work.i].forEach(function (p) {
        focusIntake.set(p, 1)
      })
      focusIntake.set(story.work.i, 1.4)
      authorsOf[story.work.i].forEach(function (a) {
        focusIntake.set(a, 1)
      })
    }
    var focusRule = null
    if (story.page) {
      focusRule = new Map([[story.page.i, 1]])
      story.page.works.forEach(function (s) {
        focusRule.set(s, 1)
        authorsOf[s].forEach(function (a) {
          focusRule.set(a, 1)
        })
      })
    }
    var focusCross = story.cross.focus.size ? story.cross.focus : null
    var focusStale = null
    if (story.stale) {
      focusStale = new Map([[story.stale.i, 1.4]])
      authorsOf[story.stale.i].forEach(function (a) {
        focusStale.set(a, 1)
      })
    }
    var wide = function (o) {
      return Object.assign(
        { shift: 0.3, dist: farDist, target: centre, yaw: 0.2, pitch: 0.1 },
        o || {},
      )
    }

    var chapters = [
      { shift: 0.16, dist: farDist, target: centre, yaw: 0.5, pitch: 0.08, spin: 1, pulse: 0.35 },
      focusIntake
        ? Object.assign(frame(Array.from(focusIntake.keys()), 1.2), {
            shift: 0.3,
            pitch: 0.12,
            focus: focusIntake,
            pulse: 0.9,
            tags: [story.work.i].concat(authorsOf[story.work.i].slice(0, 2)),
          })
        : wide(),
      // 2: the whole graph, layer by layer
      {
        shift: 0,
        dist: farDist * 0.98,
        target: centre,
        yaw: 0.35,
        pitch: 0.1,
        spin: 1,
        lift: 0.3,
        layers: true,
        pulse: 0.6,
      },
      focusRule
        ? Object.assign(frame(Array.from(focusRule.keys()), 1.25), {
            shift: 0.3,
            pitch: 0.05,
            focus: focusRule,
            pulse: 1.6,
            tags: [story.page.i].concat(Array.from(pageAuthors(story.page.i).keys()).slice(0, 3)),
          })
        : wide({ pulse: 1.4 }),
      // 4: face both hemispheres, so the space between the lobes is the subject
      Object.assign(wide({ yaw: 0, pitch: 0.16, dist: farDist * 0.92, pulse: 0.4 }), {
        focus: focusCross,
        dimOthers: 0.32,
        tags: story.cross.ids.slice(0, 3),
      }),
      trail.length
        ? Object.assign(frame(trail, 1.5), { shift: 0.3, pitch: 0.22, trail: true })
        : wide({ yaw: -0.6, pitch: 0.22 }),
      focusStale
        ? Object.assign(frame(Array.from(focusStale.keys()).concat(citedBy[story.stale.i]), 1.25), {
            shift: 0.3,
            pitch: 0.12,
            focus: focusStale,
            stale: story.stale.i,
            pulse: 0.3,
            tags: [story.stale.i],
          })
        : wide(),
      {
        shift: 0,
        dist: farDist * 1.02,
        target: centre,
        yaw: 0.2,
        pitch: 0.06,
        spin: 1,
        pulse: 1.5,
        lift: 0.3,
        boost: 1.1,
      },
      {
        shift: 0.22,
        dist: farDist * 0.94,
        target: centre,
        yaw: 0.9,
        pitch: 0.1,
        spin: 1,
        pulse: 0.5,
      },
    ]

    // ---------------------------------------------------------------- state
    var st = {
      t0: performance.now(),
      build: reduce ? 1 : 0,
      chapter: 0,
      chapterF: 0,
      free: false,
      yaw: 0.5,
      pitch: 0.08,
      dist: farDist,
      target: centre.slice(),
      shift: 0.16,
      lift: 0,
      morph: 0,
      pulse: 0.35,
      spin: 0,
      userYaw: 0,
      userPitch: 0,
      freeDist: farDist * 0.82,
      hover: -1,
      picked: -1,
      focus: -1, // the node the camera holds at the centre, from "See in 3D"
      diving: null,
      dragging: false,
      lumDirty: true,
      vp: null,
      w: 1,
      h: 1,
      dpr: 1,
      raf: 0,
      dead: false,
      trailAt: 0,
      mode: "full",
      modeTouched: false,
      show: SHOW_BASE.slice(),
    }

    try {
      var saved = JSON.parse(sessionStorage.getItem("sd-return") || "null")
      sessionStorage.removeItem("sd-return")
      if (saved && Date.now() - saved.at < 30 * 60 * 1000) {
        st.build = 1
        st.restore = saved
      }
    } catch (e) {}

    // "See in 3D" on a reading page: open on that page's own light. A slug,
    // not an index, so a rebuilt graph between the click and the load cannot
    // land the reader on someone else's page.
    var arriveAt = -1
    try {
      var wanted = JSON.parse(sessionStorage.getItem(FOCUS_KEY) || "null")
      sessionStorage.removeItem(FOCUS_KEY)
      var want = wanted && Date.now() - wanted.at < 60 * 1000 ? wanted.slug : ""
      if (!want && st.restore) want = st.restore.focusSlug || ""
      if (want) arriveAt = nodeOf(want)
      if (arriveAt >= 0 && wanted && wanted.slug === want) st.restore = null
      if (arriveAt >= 0) st.build = 1
    } catch (e) {}
    function nodeOf(slug) {
      slug = String(slug).toLowerCase()
      for (var k = 0; k < nodes.length; k++) if (nodes[k].s.toLowerCase() === slug) return k
      return -1
    }

    function resize() {
      st.dpr = Math.min(window.devicePixelRatio || 1, 2)
      st.w = el.clientWidth
      st.h = el.clientHeight
      canvas.width = Math.round(st.w * st.dpr)
      canvas.height = Math.round(st.h * st.dpr)
      st.narrow = st.w < 820
    }

    function measure() {
      var mid = scroller.scrollTop + st.h * 0.5
      var best = 0,
        f = 0
      for (var i = 0; i < sections.length; i++) {
        var top = sections[i].offsetTop,
          c = top + sections[i].offsetHeight / 2
        if (mid >= c) {
          best = i
          var next = sections[i + 1]
          if (next) {
            var nc = next.offsetTop + next.offsetHeight / 2
            f = i + clamp((mid - c) / (nc - c), 0, 1)
          } else f = i
        }
      }
      if (mid < sections[0].offsetTop + sections[0].offsetHeight / 2) f = 0
      st.chapterF = f
      var ch = Math.round(f)
      if (ch !== st.chapter) {
        st.chapter = ch
        el.setAttribute("data-chapter", String(ch))
        dots.forEach(function (d, i) {
          d.classList.toggle("sd-dot-on", i === ch)
        })
        st.lumDirty = true
        st.trailAt = performance.now()
        renderTags()
        clearTimeout(st.modeTimer)
        if (ch === 2 && !st.modeTouched) {
          setMode("vault")
          st.modeTimer = setTimeout(
            function () {
              if (!st.modeTouched && st.chapter === 2) setMode("full")
            },
            reduce ? 0 : 2400,
          )
        }
      }
    }

    var modeButtons = Array.prototype.slice.call(el.querySelectorAll("[data-sd-mode]"))
    function setMode(m) {
      st.mode = m
      st.lumDirty = true
      el.setAttribute("data-mode", m)
      modeButtons.forEach(function (b) {
        b.setAttribute("aria-pressed", String(b.getAttribute("data-sd-mode") === m))
      })
    }

    // --------------------------------------------------------- luminance
    function targets(now) {
      var ch = chapters[st.chapter]
      var focus = st.free ? null : ch.focus
      var hov = st.hover >= 0 ? st.hover : st.picked
      var near = null
      if (hov >= 0) {
        near = new Set([hov])
        citesOf[hov].forEach(function (x) {
          near.add(x)
          authorsOf[x].forEach(function (a) {
            near.add(a)
          })
        })
        citedBy[hov].forEach(function (x) {
          near.add(x)
        })
        authorsOf[hov].forEach(function (x) {
          near.add(x)
        })
        worksOf[hov].forEach(function (x) {
          near.add(x)
        })
        linked[hov].forEach(function (x) {
          near.add(x)
        })
      }
      var trailLit = null
      if (!st.free && ch.trail && trail.length) {
        trailLit = new Map()
        var step = reduce ? trail.length : Math.floor((now - st.trailAt) / 420) % (trail.length + 7)
        trail.forEach(function (id, k) {
          if (k <= step) trailLit.set(id, 1)
        })
        trail.forEach(function (id, k) {
          if (k > step) return
          linked[id].forEach(function (j) {
            if (!trailLit.has(j)) trailLit.set(j, 0.3)
          })
        })
      }
      var boost = (!st.free && ch.boost) || 1
      var vault = !st.free && ch.layers && st.mode === "vault"
      var staleSet = !st.free && ch.stale !== undefined ? citedBy[ch.stale] : null
      var blink = reduce ? 1 : 0.5 + 0.5 * Math.sin(now / 260)
      var dim = ch.dimOthers || 0.05
      for (var i = 0; i < n; i++) {
        var v = BASE[nodes[i].k] * boost
        if (focus) v = focus.has(i) ? focus.get(i) : dim
        else if (trailLit) v = trailLit.has(i) ? trailLit.get(i) : 0.05
        if (vault && !isPage(i)) v = 0.02
        if (staleSet && staleSet.indexOf(i) >= 0) v = 0.45 + 0.85 * blink
        if (near)
          v = near.has(i) ? (i === hov ? 1.5 : Math.max(v, 1)) : v * (focus || trailLit ? 1 : 0.32)
        lumTarget[i] = v
      }
    }

    function stepLum(dt) {
      var k = 1 - Math.exp(-dt * 7)
      var moving = false
      for (var i = 0; i < n; i++) {
        var d = lumTarget[i] - lum[i]
        if (Math.abs(d) > 0.002) {
          lum[i] += d * k
          moving = true
        } else lum[i] = lumTarget[i]
      }
      for (var e = 0; e < E; e++) {
        var a = lum[edges[e].a],
          b = lum[edges[e].b]
        var m = Math.min(a, b)
        // a lit edge needs both ends lit; a dimmed scene leaves a trace of it
        eLum[e] = m > 0.4 ? Math.min(1.6, m * 1.25) : m * 0.5
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, lumBuf)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, lum)
      gl.bindBuffer(gl.ARRAY_BUFFER, eLumBuf)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, eLum)
      return moving
    }

    // ------------------------------------------------------------- camera
    function project(i) {
      var m = st.vp
      if (!m) return null
      var x = pos[i * 3],
        y = pos[i * 3 + 1],
        z = pos[i * 3 + 2]
      var cx = m[0] * x + m[4] * y + m[8] * z + m[12]
      var cy = m[1] * x + m[5] * y + m[9] * z + m[13]
      var cw = m[3] * x + m[7] * y + m[11] * z + m[15]
      if (cw <= 0.05) return null
      return {
        x: ((cx / cw + st.shift) * 0.5 + 0.5) * st.w,
        y: (1 - ((cy / cw) * 0.5 + 0.5)) * st.h,
        w: cw,
      }
    }

    function pick(px, py) {
      if (st.morph > 0.35 || st.build < 0.95) return -1
      var best = -1,
        bestD = Infinity
      var unit = (st.h * 0.5) / Math.tan(FOV / 2)
      for (var i = 0; i < n; i++) {
        if (lum[i] < 0.12) continue
        var p = project(i)
        if (!p) continue
        var r = Math.max(11, (size[i] * unit * 0.45) / p.w)
        var d = Math.hypot(p.x - px, p.y - py)
        if (d < r && d - r * 0.3 + p.w * 2 < bestD) {
          bestD = d - r * 0.3 + p.w * 2
          best = i
        }
      }
      return best
    }

    // --------------------------------------------------------------- card
    function describe(i) {
      var nd = nodes[i]
      var field = nd.f ? (g.fields[nd.f] || nd.f).toLowerCase() : ""
      var line = ""
      if (nd.k === "a") {
        line = plural(worksOf[i].length, "work") + " in the wiki"
      } else if (nd.k === "s") {
        var who = authorsOf[i].map(function (a) {
          return nodes[a].t
        })
        line =
          (who.length ? "by " + names(who) + " · " : "") +
          "feeds " +
          plural(citedBy[i].length, "page")
      } else {
        var tally = pageAuthors(i)
        var top = Array.from(tally.entries())
          .sort(function (a, b) {
            return b[1] - a[1]
          })
          .map(function (e) {
            return nodes[e[0]].t
          })
        line =
          "built from " +
          plural(citesOf[i].length, "work") +
          (top.length ? " by " + names(top) : "")
      }
      return { kind: KINDS[nd.k] + (field && nd.k !== "a" ? " · " + field : ""), line: line }
    }

    function showCard(i, x, y, sticky) {
      if (i < 0) {
        card.hidden = true
        return
      }
      var nd = nodes[i]
      var d = describe(i)
      card.innerHTML =
        '<p class="sd-card-kind">' +
        esc(d.kind) +
        "</p><h4>" +
        esc(nd.t) +
        "</h4>" +
        (nd.d ? '<p class="sd-card-desc">' + esc(nd.d) + "</p>" : "") +
        '<p class="sd-card-line">' +
        esc(d.line) +
        "</p>" +
        (sticky
          ? '<button class="sd-btn sd-solid" type="button" data-sd-open="' +
            i +
            '">' +
            (nd.u ? "Open the original ↗" : "Read this page →") +
            "</button>"
          : '<p class="sd-card-go">' +
            (nd.u ? "Click to open the original ↗" : "Click to read →") +
            "</p>")
      card.hidden = false
      card.classList.toggle("sd-card-sticky", !!sticky)
      var cw = card.offsetWidth,
        ch = card.offsetHeight
      var left = clamp(x + 18, 12, st.w - cw - 12)
      var top = clamp(y + 18, 12, st.h - ch - 12)
      if (sticky && st.narrow) {
        left = 12
        top = st.h - ch - 16
      }
      card.style.transform = "translate(" + Math.round(left) + "px," + Math.round(top) + "px)"
    }

    // --------------------------------------------------------------- tags
    var tagEls = []
    function renderTags() {
      tagsEl.innerHTML = ""
      tagEls = []
      var ch = chapters[st.chapter]
      if (st.free || !ch.tags) return
      ch.tags.forEach(function (i) {
        var t = document.createElement("span")
        t.className = "sd-tag sd-tag-" + nodes[i].k
        t.textContent = nodes[i].t
        tagsEl.appendChild(t)
        tagEls.push({ i: i, el: t })
      })
    }
    function placeTags() {
      var show = st.build >= 1 && Math.abs(st.chapterF - st.chapter) < 0.32 && !st.diving
      tagEls.forEach(function (t) {
        var p = project(t.i)
        if (!p || !show) {
          t.el.style.opacity = "0"
          return
        }
        t.el.style.opacity = "1"
        t.el.style.transform =
          "translate(" + Math.round(p.x + 14) + "px," + Math.round(p.y - 9) + "px)"
      })
    }

    // -------------------------------------------------------------- frame
    var last = performance.now()
    function tick(now) {
      if (st.dead) return
      st.raf = requestAnimationFrame(tick)
      // every use of dt below is an exponential ease or a linear step, so a
      // long frame stays stable; the cap only stops a jump after a stall. At
      // 0.05 a machine drawing under 20fps (software WebGL, a weak phone)
      // also ran every animation slower, and the 4.2s build took 9s or more
      var dt = Math.min(0.25, (now - last) / 1000)
      last = now
      var time = (now - st.t0) / 1000

      if (st.build < 1) st.build = Math.min(1, st.build + dt / 4.2)

      // where the chapter wants the camera
      var f = st.chapterF
      var i0 = Math.floor(f),
        i1 = Math.min(chapters.length - 1, i0 + 1),
        k = ease(f - i0)
      var a = chapters[i0],
        b = chapters[i1]
      var ya = a.yaw + (a.spin ? st.spin : 0)
      var yb = nearAngle(b.yaw + (b.spin ? st.spin : 0), ya)
      var want = {
        yaw: lerp(ya, yb, k),
        pitch: lerp(a.pitch, b.pitch, k),
        dist: lerp(a.dist, b.dist, k),
        shift: lerp(a.shift, b.shift, k),
        lift: lerp(a.lift || 0, b.lift || 0, k),
        morph: lerp(a.morph || 0, b.morph || 0, k),
        pulse: lerp(a.pulse || 0, b.pulse || 0, k),
        spin: lerp(a.spin || 0, b.spin || 0, k),
        target: [0, 1, 2].map(function (d) {
          return lerp(a.target[d], b.target[d], k)
        }),
      }
      if (st.narrow) {
        // on a phone the copy sits under the graph, not beside it
        want.shift = 0
        want.lift = st.free ? 0 : 0.34
        want.dist *= 1.5
      }
      if (st.free) {
        want.shift = 0
        want.lift = 0
        want.morph = 0
        want.pulse = 0.9
        want.spin = st.dragging || st.hover >= 0 ? 0 : 0.5
        want.dist = st.freeDist * (st.narrow ? 1.35 : 1)
        want.target = centre
        want.yaw = st.spin
        want.pitch = 0.1
        if (st.focus >= 0) {
          want.target = [pos[st.focus * 3], pos[st.focus * 3 + 1], pos[st.focus * 3 + 2]]
          want.spin = 0
        }
      }
      if (st.diving) {
        var dv = st.diving
        var u = ease((now - dv.at) / 1150)
        want.target = [0, 1, 2].map(function (d) {
          return lerp(dv.from.target[d], pos[dv.i * 3 + d], u)
        })
        want.dist = lerp(dv.from.dist, 0.34, u * u)
        want.shift = lerp(dv.from.shift, 0, u)
        want.lift = lerp(dv.from.lift, 0, u)
        want.spin = 0
        st.target = want.target
        st.dist = want.dist
        st.shift = want.shift
        st.lift = want.lift
      }

      if (!reduce && st.hover < 0 && !st.dragging) st.spin += dt * 0.075 * want.spin
      var sway = reduce ? 0 : Math.sin(time * 0.23) * 0.07
      var q = st.diving || reduce ? 1 : 1 - Math.exp(-dt * 3.2)
      var yawWant = nearAngle(want.yaw + sway + st.userYaw, st.yaw)
      st.yaw += (yawWant - st.yaw) * q
      st.pitch += (clamp(want.pitch + st.userPitch, -1.2, 1.2) - st.pitch) * q
      st.dist += (want.dist - st.dist) * q
      st.shift += (want.shift - st.shift) * q
      st.lift += (want.lift - st.lift) * q
      st.morph += (want.morph - st.morph) * q
      st.pulse += (want.pulse - st.pulse) * q
      for (var d = 0; d < 3; d++) st.target[d] += (want.target[d] - st.target[d]) * q
      if (!st.free && !st.diving) {
        st.userYaw *= Math.exp(-dt * 0.6)
        st.userPitch *= Math.exp(-dt * 0.6)
      }

      var eye = [
        st.target[0] + st.dist * Math.cos(st.pitch) * Math.sin(st.yaw),
        st.target[1] + st.dist * Math.sin(st.pitch),
        st.target[2] + st.dist * Math.cos(st.pitch) * Math.cos(st.yaw),
      ]
      var proj = perspective(FOV, st.w / st.h, 0.05, 60)
      // lift moves the picture up the screen without re-aiming the camera
      proj[9] = -st.lift
      st.vp = mul(proj, lookAt(eye, st.target))

      // luminance
      var ch = chapters[st.chapter]
      if (st.lumDirty || ((ch.trail || ch.stale !== undefined) && !st.free)) {
        targets(now)
        st.lumDirty = false
        st.lumMoving = true
      }
      if (st.lumMoving) st.lumMoving = stepLum(dt)

      // which layers of edges are drawn
      var showWant = st.free
        ? SHOW_BASE
        : ch.layers
          ? st.mode === "vault"
            ? SHOW_VAULT
            : SHOW_ALL
          : SHOW_BASE
      var qs = reduce ? 1 : 1 - Math.exp(-dt * 4)
      for (var sk = 0; sk < 5; sk++) st.show[sk] += (showWant[sk] - st.show[sk]) * qs

      // draw
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0.02, 0.0155, 0.011, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.disable(gl.DEPTH_TEST)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE)
      var px = (canvas.height * 0.5) / Math.tan(FOV / 2)

      gl.useProgram(edgeProg.p)
      gl.bindVertexArray(edgeVao)
      gl.uniformMatrix4fv(edgeProg.u.uVP, false, st.vp)
      gl.uniform1f(edgeProg.u.uBuild, st.build)
      gl.uniform1f(edgeProg.u.uMorph, st.morph)
      gl.uniform1f(edgeProg.u.uTime, reduce ? 0 : time)
      gl.uniform1f(edgeProg.u.uShift, st.shift)
      gl.uniform1f(edgeProg.u.uDist, st.dist)
      gl.uniform1f(edgeProg.u.uPx, px)
      gl.uniform1f(edgeProg.u.uPulse, reduce ? 0 : st.pulse)
      gl.uniform1fv(edgeProg.u["uShow[0]"], st.show)
      gl.uniform1f(edgeProg.u.uMode, 0)
      gl.drawArraysInstanced(gl.LINE_STRIP, 0, SEG + 1, E)
      if (!reduce && st.pulse > 0.01) {
        gl.uniform1f(edgeProg.u.uMode, 1)
        gl.drawArraysInstanced(gl.POINTS, 0, 1, pulseCount)
      }

      gl.useProgram(nodeProg.p)
      gl.bindVertexArray(nodeVao)
      gl.uniformMatrix4fv(nodeProg.u.uVP, false, st.vp)
      gl.uniform1f(nodeProg.u.uBuild, st.build)
      gl.uniform1f(nodeProg.u.uMorph, st.morph)
      gl.uniform1f(nodeProg.u.uPx, px)
      gl.uniform1f(nodeProg.u.uTime, reduce ? 0 : time)
      gl.uniform1f(nodeProg.u.uShift, st.shift)
      gl.uniform1f(nodeProg.u.uDist, st.dist)
      gl.uniform1f(nodeProg.u.uMinPx, 2.5 * st.dpr)
      gl.drawArrays(gl.POINTS, 0, n)
      gl.bindVertexArray(null)

      placeTags()
    }

    // ------------------------------------------------------------- input
    function setFree(on) {
      st.free = on
      el.classList.toggle("sd-free", on)
      st.userYaw = 0
      st.userPitch = 0
      st.spin = st.yaw
      st.hover = -1
      st.picked = -1
      st.focus = -1
      showCard(-1)
      st.lumDirty = true
      renderTags()
    }

    function focusOn(i) {
      st.focus = i
      st.picked = i
      st.hover = -1
      st.freeDist = focusDist
      st.lumDirty = true
      // the light is held at the centre, so the card can sit beside it
      setTimeout(
        function () {
          if (st.focus === i && !st.dead) showCard(i, st.w / 2, st.h / 2, true)
        },
        reduce ? 0 : 900,
      )
    }
    // back out to the whole graph, still free to turn it
    function unfocus() {
      st.focus = -1
      st.picked = -1
      st.freeDist = farDist * 0.82
      st.lumDirty = true
      showCard(-1)
    }

    function dive(i) {
      if (st.diving) return
      // A work with no page of its own (the public edition) is a way out, not
      // a way in: open the original beside the graph. Synchronously, inside
      // the click, or the browser treats it as a popup.
      if (nodes[i] && nodes[i].u) {
        window.open(nodes[i].u, "_blank", "noopener")
        return
      }
      var p = project(i)
      st.diving = {
        i: i,
        at: performance.now(),
        from: { target: st.target.slice(), dist: st.dist, shift: st.shift, lift: st.lift },
      }
      st.hover = i
      st.lumDirty = true
      showCard(-1)
      el.classList.add("sd-diving")
      try {
        sessionStorage.setItem(
          "sd-return",
          JSON.stringify({
            at: Date.now(),
            free: st.free,
            scroll: scroller.scrollTop,
            userYaw: st.userYaw,
            userPitch: st.userPitch,
            freeDist: st.freeDist,
            spin: st.spin,
            focusSlug: st.focus >= 0 ? nodes[st.focus].s : "",
            title: nodes[i].t,
          }),
        )
      } catch (e) {}
      var href = base + nodes[i].s
      var go = function () {
        flood.style.setProperty("--sd-x", "50%")
        flood.style.setProperty("--sd-y", "50%")
        flood.classList.add("sd-flood-on")
        setTimeout(function () {
          var url = new URL(href, location.href)
          if (typeof window.spaNavigate === "function") {
            st.left = true
            window.spaNavigate(url)
            // if the router never fires `nav`, do not strand the reader
            setTimeout(function () {
              if (live && live.st === st) location.assign(url.href)
            }, 2500)
          } else location.assign(url.href)
        }, 620)
      }
      setTimeout(go, reduce ? 0 : 640)
    }

    function onMove(ev) {
      if (st.diving) return
      if (st.dragging) {
        var dx = ev.clientX - st.dragX,
          dy = ev.clientY - st.dragY
        st.dragX = ev.clientX
        st.dragY = ev.clientY
        st.moved += Math.abs(dx) + Math.abs(dy)
        st.userYaw -= dx * 0.006
        st.userPitch = clamp(st.userPitch + dy * 0.005, -1, 1)
        return
      }
      if (ev.pointerType === "touch") return
      var over = ev.target.closest && ev.target.closest("a,button,.sd-card-sticky")
      var i = over ? -1 : pick(ev.clientX, ev.clientY)
      if (i !== st.hover) {
        st.hover = i
        st.lumDirty = true
        scroller.style.cursor = i >= 0 ? "pointer" : ""
        canvasCursor(i >= 0)
      }
      if (st.picked < 0) showCard(i, ev.clientX, ev.clientY, false)
    }
    function canvasCursor(on) {
      el.classList.toggle("sd-hovering", on)
    }
    function onDown(ev) {
      if (st.diving) return
      if (ev.target.closest && ev.target.closest("a,button,.sd-card")) return
      st.moved = 0
      st.downX = ev.clientX
      st.downY = ev.clientY
      if (ev.pointerType === "touch" && !st.free) return // a touch drag is a scroll
      st.dragging = true
      st.dragX = ev.clientX
      st.dragY = ev.clientY
      el.classList.add("sd-dragging")
    }
    function onUp(ev) {
      var wasDrag = st.dragging && st.moved > 6
      st.dragging = false
      el.classList.remove("sd-dragging")
      if (st.diving || wasDrag) return
      if (ev.target.closest && ev.target.closest("a,button,.sd-card")) return
      if (Math.hypot(ev.clientX - (st.downX || 0), ev.clientY - (st.downY || 0)) > 8) return
      var i = pick(ev.clientX, ev.clientY)
      if (i < 0 && st.focus >= 0) return unfocus()
      if (ev.pointerType === "touch") {
        st.picked = i
        st.hover = -1
        st.lumDirty = true
        showCard(i, ev.clientX, ev.clientY, true)
        return
      }
      if (i >= 0) dive(i)
    }
    function onClick(ev) {
      var t = ev.target
      var free = t.closest && t.closest("[data-sd-free]")
      var unfree = t.closest && t.closest("[data-sd-unfree]")
      var open = t.closest && t.closest("[data-sd-open]")
      var nodeLink = t.closest && t.closest("[data-sd-node]")
      var hash = t.closest && t.closest('a[href^="#sd-"]')
      var mode = t.closest && t.closest("[data-sd-mode]")
      if (mode) {
        st.modeTouched = true
        clearTimeout(st.modeTimer)
        return setMode(mode.getAttribute("data-sd-mode"))
      }
      if (free) return setFree(true)
      if (unfree) return setFree(false)
      if (open) return dive(Number(open.getAttribute("data-sd-open")))
      if (nodeLink) {
        ev.preventDefault()
        ev.stopPropagation()
        return dive(Number(nodeLink.getAttribute("data-sd-node")))
      }
      if (hash) {
        ev.preventDefault()
        ev.stopPropagation()
        var sec = el.querySelector(hash.getAttribute("href"))
        if (st.free) setFree(false)
        if (sec) scroller.scrollTo({ top: sec.offsetTop, behavior: reduce ? "auto" : "smooth" })
      }
    }
    function onWheel(ev) {
      if (!st.free) return
      ev.preventDefault()
      st.freeDist = clamp(st.freeDist * Math.exp(ev.deltaY * 0.0012), 0.9, farDist * 1.5)
    }
    function onKey(ev) {
      if (ev.key !== "Escape" || !st.free) return
      if (st.focus >= 0) unfocus()
      else setFree(false)
    }
    function onLeave() {
      if (st.hover >= 0) {
        st.hover = -1
        st.lumDirty = true
        if (st.picked < 0) showCard(-1)
      }
    }

    el.addEventListener("pointermove", onMove)
    el.addEventListener("pointerdown", onDown)
    el.addEventListener("pointerup", onUp)
    el.addEventListener("pointerleave", onLeave)
    el.addEventListener("click", onClick)
    el.addEventListener("wheel", onWheel, { passive: false })
    scroller.addEventListener("scroll", measure, { passive: true })
    window.addEventListener("resize", onResize)
    window.addEventListener("keydown", onKey)
    function onResize() {
      resize()
      measure()
    }

    resize()
    if (st.restore) {
      scroller.scrollTop = st.restore.scroll || 0
      st.freeDist = st.restore.freeDist || st.freeDist
      if (st.restore.free) setFree(true)
      st.userYaw = st.restore.userYaw || 0
      st.userPitch = st.restore.userPitch || 0
      st.spin = st.restore.spin || 0
      // arrive from inside the node the reader left through, and pull back out
      st.dist = 0.6
      el.classList.add("sd-arriving")
      setTimeout(function () {
        el.classList.remove("sd-arriving")
      }, 60)
    }
    if (arriveAt >= 0) {
      if (!st.free) setFree(true)
      focusOn(arriveAt)
      if (!st.restore) {
        // come out of the page the reader was on, as a dive goes into one
        st.dist = 0.6
        st.target = [pos[arriveAt * 3], pos[arriveAt * 3 + 1], pos[arriveAt * 3 + 2]]
        st.yaw = st.spin
      }
    }
    st.chapter = -1
    measure()
    targets(performance.now())
    for (var i = 0; i < n; i++) lum[i] = lumTarget[i]
    st.lumMoving = true
    st.raf = requestAnimationFrame(tick)

    // for demo/test only: where a node is on screen, so a test can point at one
    el.sdProbe = {
      st: st,
      nodes: nodes,
      project: project,
      chapters: chapters.length,
    }

    return {
      st: st,
      el: el,
      destroy: function () {
        st.dead = true
        cancelAnimationFrame(st.raf)
        window.removeEventListener("resize", onResize)
        window.removeEventListener("keydown", onKey)
        docEl.classList.remove("sd-on")
        var lose = gl.getExtension("WEBGL_lose_context")
        if (lose) lose.loseContext()
        el.remove()
      },
      // the page under the overlay has been swapped: lift the overlay off it
      reveal: function (title) {
        docEl.classList.remove("sd-on")
        el.classList.add("sd-leaving")
        var self = this
        setTimeout(function () {
          self.destroy()
        }, 700)
      },
    }
  }

  // ------------------------------------------------------------ lifecycle

  var graphPromise = null
  function load() {
    if (!graphPromise)
      graphPromise = fetch(root() + "static/demo.json").then(function (r) {
        if (!r.ok) throw new Error("demo.json " + r.status)
        return r.json()
      })
    return graphPromise
  }

  function dropChip() {
    if (chip) {
      chip.remove()
      chip = null
    }
  }

  // The chip travels with the reader. It stays on every page after a dive for
  // as long as the graph's saved place does (sessionStorage `sd-return`, 30
  // minutes), and takes them back to that place however many links they have
  // followed since: the demo's mount reads and clears it. `history.back()` only
  // ever went one page.
  function returnable() {
    try {
      var saved = JSON.parse(sessionStorage.getItem("sd-return") || "null")
      return !!saved && Date.now() - saved.at < 30 * 60 * 1000
    } catch (e) {
      return false
    }
  }

  function leaveChip() {
    if (chip && chip.isConnected) return
    dropChip()
    chip = document.createElement("button")
    chip.type = "button"
    chip.className = "sd-return"
    chip.textContent = "Back to the graph"
    chip.addEventListener("click", function () {
      // the site's mount path, not root(): root() is only right on the demo
      var base = (document.body && document.body.dataset.basepath) || ""
      var url = new URL(base + "/" + SLUG, location.href)
      if (typeof window.spaNavigate === "function") window.spaNavigate(url)
      else location.assign(url.href)
    })
    document.documentElement.appendChild(chip)
  }

  // "See in 3D": on a page that is a light in the graph, a link on the line
  // above the title that opens the graph on that light. Added here rather than
  // by outline-nav/ because it needs WebGL2 and knows the demo's storage key;
  // without either the reader never sees a control that cannot work. A page no
  // topic places has no such line, and gets no link.
  var GRAPH_PAGE =
    /^(sections\/[^/]+\/(concepts|entities|topics|synthesis|sources)\/[^/]+|authors\/[^/]+)$/
  function addSeeIn3d() {
    var slug = (document.body && document.body.dataset.slug) || ""
    if (!window.WebGL2RenderingContext || !GRAPH_PAGE.test(slug) || /\/index$/.test(slug)) return
    var line = document.querySelector("article .outline-place, .center .outline-place")
    if (!line || line.querySelector(".sd-see3d")) return
    var base = (document.body && document.body.dataset.basepath) || ""
    var a = document.createElement("a")
    a.className = "sd-see3d"
    a.href = base + "/" + SLUG
    a.setAttribute("data-router-ignore", "")
    a.setAttribute("data-no-popover", "true")
    a.textContent = "See in 3D"
    a.addEventListener("click", function (ev) {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button) return
      ev.preventDefault()
      try {
        sessionStorage.setItem(FOCUS_KEY, JSON.stringify({ slug: slug, at: Date.now() }))
      } catch (e) {}
      var url = new URL(a.href, location.href)
      if (typeof window.spaNavigate === "function") window.spaNavigate(url)
      else location.assign(url.href)
    })
    line.insertBefore(a, line.querySelector(".outline-place-all"))
  }

  function onNav() {
    var here = document.body && document.body.dataset.slug === SLUG
    if (!here) addSeeIn3d()
    var docEl = document.documentElement
    if (live && live.st.left) {
      // a dive just landed on its page
      var old = live
      live = null
      old.reveal()
      if (!here) leaveChip()
      return
    }
    if (!here && returnable()) leaveChip()
    else dropChip()
    if (!here) {
      docEl.classList.remove("sd-pending")
      if (live) {
        live.destroy()
        live = null
      }
      return
    }
    if (live) return
    if (!window.WebGL2RenderingContext) {
      docEl.classList.remove("sd-pending")
      return
    }
    var slugAtStart = SLUG
    load()
      .then(function (g) {
        if (live || !document.body || document.body.dataset.slug !== slugAtStart) return
        live = mount(g)
        docEl.classList.remove("sd-pending")
      })
      .catch(function (err) {
        console.error("symposium demo:", err)
        graphPromise = null
        docEl.classList.remove("sd-pending")
      })
  }

  document.addEventListener("nav", onNav)
})();