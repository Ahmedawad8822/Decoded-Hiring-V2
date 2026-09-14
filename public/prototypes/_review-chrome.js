/* Review chrome — prototype pack only (not a product component).
   Renders the dark strip at the top of every prototype page:
   screen ID · title · state switcher (if present) · viewport toggle · index link.
   Usage: <body data-screen="PUB-01" data-screen-title="Homepage">

   02D remediation (FINDING 01 + FINDING 08):
   - State buttons are now built from [data-state-panel] sections — the panels are
     the source of truth for "which demo states exist on this screen". (Previously
     buttons were built from [data-state] elements, which never exist in page
     markup, so the switcher never rendered and app.js had nothing to bind.)
   - Viewport toggle (VISUAL-PROTOTYPE-PLAN §6): 360 / 768 / 1280 / Full. The
     page is re-mounted inside a width-locked <iframe src="this page"> so the
     page's own responsive CSS (real media queries, real JS) renders at the
     chosen width. Inside the frame the strip omits the viewport toggle (no
     recursion) but keeps its state switcher.
   - ?state= deep links (e.g. checkout.html?state=failure) open a page directly
     in a given demo state, so walkthrough evidence can be a URL. */
(function () {
  'use strict';
  var framed = window.self !== window.top;
  var body = document.body;
  var id = body.getAttribute('data-screen');
  if (!id) return;
  var title = body.getAttribute('data-screen-title') || '';

  function qs(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }

  var strip = document.createElement('div');
  strip.className = 'review-strip no-print';
  var states = qs('[data-state-panel]').map(function (p) { return p.getAttribute('data-state-panel'); })
    .filter(function (v, i, a) { return v && a.indexOf(v) === i; });

  var html = '<span class="rs-id">' + id + '</span><span class="rs-title">' + title + '</span>';
  if (states.length) {
    html += '<span class="rs-group" role="group" aria-label="Demo states">' +
      states.map(function (s) {
        return '<button type="button" data-state="' + s + '">' + s + '</button>';
      }).join('') + '</span>';
  }
  if (!framed) {
    html += '<span class="rs-vp" role="group" aria-label="Preview width">' +
      ['360', '768', '1280', 'Full'].map(function (w) {
        return '<button type="button" data-vp="' + w + '"' + ' aria-pressed="false">' + w + '</button>';
      }).join('') + '</span>';
  }
  html += '<a class="rs-index-link" href="/review">Review Hub ↗</a>';
  strip.innerHTML = html;
  body.insertBefore(strip, body.firstChild);

  /* Panels with [data-state-panel] start hidden except the first, unless a
     ?state= deep link names a specific panel. app.js owns panel switching; the
     chrome only sets initial visibility and keeps the strip's aria-pressed
     baseline in sync so it always reflects the visible panel. */
  var params = {};
  try { params = new URLSearchParams(location.search); } catch (e) {}
  var initial = params.get('state') || states[0] || null;
  qs('[data-state-panel]').forEach(function (p, i) {
    p.hidden = initial ? p.getAttribute('data-state-panel') !== initial : i !== 0;
  });
  var setPressed = function (stateId) {
    qs('.rs-group [data-state]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-state') === stateId));
    });
  };
  setPressed(initial);
  document.addEventListener('dh:state', function (e) { setPressed(e.detail && e.detail.state); });

  /* ---- Viewport toggle (top document only) ----------------------------------
     Mounts <iframe src="this very URL"> at the chosen width. The framed page
     is a complete, self-sufficient render: its own CSS, its own app.js, its
     own working state switcher. "Full" removes the frame and restores the
     page. The current ?state= is carried into the frame so the visible demo
     state survives the resize. */
  if (!framed) {
    var mounted = null;
    function unmount() {
      if (!mounted) return;
      mounted.frame.remove();
      mounted.hidden.forEach(function (el) { el.style.display = ''; });
      mounted = null;
    }
    function mount(width) {
      if (mounted) unmount();
      var url = location.href;
      try {
        var u = new URL(url);
        if (u.search.indexOf('state=') < 0 && initial) u.searchParams.set('state', initial);
        url = u.href;
      } catch (e) {}
      var host = document.createElement('div');
      host.className = 'rs-frame-host no-print';
      host.style.maxWidth = width + 'px';
      var label = document.createElement('div');
      label.className = 'rs-frame-label no-print';
      label.textContent = 'PREVIEW WIDTH ' + width + 'PX — THE PAGE INSIDE IS FULLY INTERACTIVE (MEDIA QUERIES ARE REAL)';
      var frame = document.createElement('iframe');
      frame.className = 'rs-frame';
      frame.setAttribute('title', 'Prototype preview at ' + width + 'px');
      frame.setAttribute('aria-label', 'Prototype preview at ' + width + 'px');
      frame.src = url;
      host.appendChild(label);
      host.appendChild(frame);
      document.body.appendChild(host);
      // Hide the page's own content while the framed copy shows (strip stays).
      var hidden = [];
      Array.prototype.forEach.call(document.body.children, function (el) {
        if (el === strip || el === host || el.classList.contains('toast-stack')) return;
        if (el.nodeType !== 1) return;
        el.style.display = 'none';
        hidden.push(el);
      });
      mounted = { frame: frame, host: host, hidden: hidden };
      window.scrollTo({ top: 0 });
    }
    qs('.rs-vp [data-vp]').forEach(function (b) {
      b.addEventListener('click', function () {
        qs('.rs-vp [data-vp]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        var w = b.getAttribute('data-vp');
        if (w === 'Full') { unmount(); return; }
        mount(+w);
      });
    });
  }
})();
