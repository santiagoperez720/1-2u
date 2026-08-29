/* =========================================================
   1*2U — Bottom Bar Injector (basado en el motor 972)
   ========================================================= */
(function () {
  var html =
    '<div id="bottom-bar">' +
      '<div class="bb-l">Desliza para navegar</div>' +
      '<div class="bb-c">' +
        '<span class="bb-c-desktop">' +
          '<a href="#">Información legal</a> — ' +
          '<span>1*2U — Fotografía &amp; Dirección de Imagen</span>' +
        '</span>' +
        '<span class="bb-c-mobile">1*2U Studio</span>' +
      '</div>' +
      '<div class="bb-r">' +
        '<span class="bb-r-desktop">&copy; 2026</span>' +
        '<a class="bb-r-mobile" href="#">Legal</a>' +
      '</div>' +
    '</div>';
  var mount = document.getElementById('bottom-bar-mount');
  if (mount) { mount.outerHTML = html; }
  else { document.body.insertAdjacentHTML('beforeend', html); }
})();
