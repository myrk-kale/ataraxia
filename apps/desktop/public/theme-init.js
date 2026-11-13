// Applies the chosen theme and fonts before the first paint, so nobody sees the wrong theme flash.
// app/appearance/store.tsx writes what this reads (the "applied" snapshot) every time anything changes.
(function () {
  var root = document.documentElement;
  var kind = "dark";
  var vars = {};
  try {
    var applied = JSON.parse(window.localStorage.getItem("ataraxia.appearance.applied") || "null");
    if (applied && (applied.kind === "light" || applied.kind === "dark")) {
      kind = applied.kind;
      vars = applied.vars && typeof applied.vars === "object" ? applied.vars : {};
    } else {
      // First launch, or from before themes: the old light/dark choice, else the system's.
      var stored = window.localStorage.getItem("ataraxia.theme");
      if (stored === "light" || stored === "dark") {
        kind = stored;
      } else if (window.matchMedia("(prefers-color-scheme: light)").matches) {
        kind = "light";
      }
    }
  } catch (error) {
    // Blocked storage or matchMedia: the dark default stands.
  }
  root.classList.add(kind);
  root.setAttribute("data-theme", kind);
  for (var key in vars) {
    if (Object.prototype.hasOwnProperty.call(vars, key) && key.indexOf("--") === 0) {
      root.style.setProperty(key, String(vars[key]));
    }
  }
})();
