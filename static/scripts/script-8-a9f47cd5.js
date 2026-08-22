(function pageTopScript() {
  var native = Element.prototype.scrollIntoView

  Element.prototype.scrollIntoView = function (options) {
    var list = this.closest && this.closest(".explorer-ul")
    if (!list) return native.apply(this, arguments)

    // Centre the active entry in the explorer's own scrollport. Measured off
    // bounding rects rather than offsetTop, which is relative to the nearest
    // positioned ancestor and so would be wrong the moment the list stops
    // being one.
    var here = this.getBoundingClientRect()
    var frame = list.getBoundingClientRect()
    var top = list.scrollTop + (here.top - frame.top) - list.clientHeight / 2 + here.height / 2
    var behavior = (options && typeof options === "object" && options.behavior) || "auto"

    list.scrollTo({ top: Math.max(0, top), behavior: behavior })
  }
})();