
const setupCursorGlow = () => {
  let el = document.getElementById("cursor-glow");
  if (!el) {
    el = document.createElement("div");
    el.id = "cursor-glow";
    document.body.appendChild(el);
  }
  const move = (e) => {
    el.style.left = e.clientX + "px";
    el.style.top = e.clientY + "px";
    if (el.style.opacity !== "1") el.style.opacity = "1";
  };
  const leave = () => { el.style.opacity = "0"; };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseleave", leave);
  window.addCleanup(() => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseleave", leave);
  });
};
document.addEventListener("nav", setupCursorGlow);
document.addEventListener("render", setupCursorGlow);
