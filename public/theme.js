(function () {
  var KEY = "captyn_wifi_theme";
  function preferred() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function stored() {
    try { return localStorage.getItem(KEY); } catch (_error) { return null; }
  }
  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
  }
  apply(stored() || preferred());

  window.captynTheme = {
    current: function () {
      return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    },
    toggle: function () {
      var next = window.captynTheme.current() === "dark" ? "light" : "dark";
      apply(next);
      try { localStorage.setItem(KEY, next); } catch (_error) {}
      return next;
    }
  };
})();
