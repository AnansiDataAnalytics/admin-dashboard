/* theme.js — cross-page light/dark persistence for Anansi Admin.
   Applies the saved theme to <html data-theme> as early as possible (include in <head>),
   and wires any .theme-toggle button on the page. Default: dark. */
(function () {
  var KEY = "anansi-admin-theme";
  function cur() {
    var v = null;
    try { v = localStorage.getItem(KEY); } catch (e) {}
    return v === "light" || v === "dark" ? v : "dark";
  }
  function apply(t) {
    document.documentElement.setAttribute("data-theme", t);
  }
  // Apply immediately to avoid a flash of the wrong theme.
  apply(cur());

  function wire() {
    var btns = document.querySelectorAll(".theme-toggle");
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        if (btn.__themeWired) return;
        btn.__themeWired = true;
        btn.setAttribute("aria-label", "Toggle light / dark theme");
        btn.addEventListener("click", function () {
          var next = cur() === "dark" ? "light" : "dark";
          try { localStorage.setItem(KEY, next); } catch (e) {}
          apply(next);
          // let listeners (e.g. React apps) react if they want
          document.dispatchEvent(new CustomEvent("anansi-theme", { detail: next }));
        });
      })(btns[i]);
    }
  }
  if (document.readyState !== "loading") wire();
  else document.addEventListener("DOMContentLoaded", wire);

  // expose for any script that wants the current value
  window.AnansiTheme = { get: cur, set: function (t) { try { localStorage.setItem(KEY, t); } catch (e) {} apply(t); } };
})();
