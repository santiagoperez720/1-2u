/* =========================================================
   1*2U — Nav Injector (basado en el motor 972)
   ========================================================= */
(function () {
  var html =
    '<div id="nav">' +
      '<div class="nav-l">' +
        '<a id="nav-name" href="index.html">1*2U&reg;' +
          '<span class="bracket br-tl"></span><span class="bracket br-tr"></span>' +
          '<span class="bracket br-bl"></span><span class="bracket br-br"></span>' +
        '</a>' +
        '<a id="nav-sub" href="index.html">CLEAR SIDE' +
          '<span class="bracket br-tl"></span><span class="bracket br-tr"></span>' +
          '<span class="bracket br-bl"></span><span class="bracket br-br"></span>' +
        '</a>' +
      '</div>' +
      '<div class="nav-r">' +
        '<a id="nav-works" href="index.html">SELECCIÓN' +
          '<span class="bracket br-tl"></span><span class="bracket br-tr"></span>' +
          '<span class="bracket br-bl"></span><span class="bracket br-br"></span>' +
        '</a>' +
        '<a id="nav-index" href="proyectos.html">PROYECTOS' +
          '<span class="bracket br-tl"></span><span class="bracket br-tr"></span>' +
          '<span class="bracket br-bl"></span><span class="bracket br-br"></span>' +
        '</a>' +
        '<a id="nav-bio" href="#">CONTACTO' +
          '<span class="bracket br-tl"></span><span class="bracket br-tr"></span>' +
          '<span class="bracket br-bl"></span><span class="bracket br-br"></span>' +
        '</a>' +
      '</div>' +
    '</div>';
  var mount = document.getElementById('nav-mount');
  if (mount) { mount.outerHTML = html; }
  else { document.body.insertAdjacentHTML('afterbegin', html); }
})();
