(function () {
  var theme = 'moonaan';
  try {
    var stored = window.localStorage.getItem('reflow-theme');
    if (stored === 'daylight' || stored === 'moonaan') theme = stored;
  } catch (error) {
    theme = 'moonaan';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
