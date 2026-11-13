// Sets the theme before the first paint, so a light-theme user never sees a dark flash.
// It must stay in sync with app/theme.ts: same storage key, same fallback to the system theme.
(function () {
  var theme = "dark";
  try {
    var stored = window.localStorage.getItem("ataraxia.theme");
    if (stored === "light" || stored === "dark") {
      theme = stored;
    } else if (window.matchMedia("(prefers-color-scheme: light)").matches) {
      theme = "light";
    }
  } catch (error) {
    // Blocked storage or matchMedia: the dark default stands.
  }
  var root = document.documentElement;
  root.classList.add(theme);
  root.setAttribute("data-theme", theme);
})();
