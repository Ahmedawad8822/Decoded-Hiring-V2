/* ==========================================================================
   Decoded Hiring V2 — Prototype App JS
   Small, dependency-free interaction demos: review chrome state switcher,
   framework steppers, wizard flow, hold countdown, toasts, dialogs, drawers.
   Prototype-only; the production app replaces this with typed islands.

   02D remediation notes (FINDING 01/02/03):
   - The state switcher is now one delegated document-level click handler: it
     catches strip buttons ([data-state]) no matter when they were created, and
     in-page demo buttons ([data-state-p]) — same activation path, one shared
     helper, so panels and strip stay in sync in all cases.
   - A single polite live region announces state/step/outcome changes
     (FINDING 03); drawers and dialogs manage aria-expanded / aria-modal,
     focus traps, and focus return (FINDING 02).
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- Shared polite live region (FINDING 03) ---------------------------
     One region per page. Announcements are debounced and self-clearing so
     repeated events (hold countdown ticks) don't queue into noise; only
     meaningful transitions are announced, per INTERACTION-STATES §11
     (polite for results, never assertive except destructive confirms). */
  var live = document.createElement('div');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  live.setAttribute('role', 'status');
  document.body.appendChild(live);
  var liveTimer = null;
  function announce(msg) {
    if (!msg) return;
    live.textContent = '';
    window.clearTimeout(liveTimer);
    liveTimer = window.setTimeout(function () { live.textContent = msg; }, 90);
  }
  window.dhAnnounce = announce;

  /* ---- Review chrome ---------------------------------------------------- */
  // Injected into pages by _review-chrome.js (shared header strip).

  /* ---- State switcher (demo states on a screen) — FINDING 01 fix ---------
     Buttons with [data-state] (review strip) or [data-state-p] (in-page demo
     buttons) toggle [data-state-panel] sections. Delegated at document level
     so it works for strip buttons created after app.js runs (the chrome
     script builds them before app.js executes, but delegation makes the
     wiring order-proof either way). */
  var HUMAN = {
    checkout: 'Checkout available', pending: 'Payment processing', success: 'Payment success',
    failure: 'Payment failed', manual: 'Manual / invoice requested', list: 'Content list',
    editor: 'Content editor', loading: 'Loading', error: 'Error', empty: 'Empty',
    populated: 'Populated'
  };
  function humanState(id) { return HUMAN[id] || ('State: ' + id); }

  function setState(id, opts) {
    opts = opts || {};
    var matched = false;
    $$('[data-state-panel]').forEach(function (p) {
      var on = p.getAttribute('data-state-panel') === id;
      if (on) matched = true;
      p.hidden = !on;
    });
    // Keep every state button (strip + in-page) reflecting the visible panel.
    $$('[data-state], [data-state-p]').forEach(function (b) {
      var bid = b.getAttribute('data-state') || b.getAttribute('data-state-p');
      if (bid === id) b.setAttribute('aria-pressed', 'true');
      else if (b.hasAttribute('data-state') || b.hasAttribute('data-state-p')) b.setAttribute('aria-pressed', 'false');
    });
    document.dispatchEvent(new CustomEvent('dh:state', { detail: { state: id } }));
    if (opts.announce !== false) announce(humanState(id) + '.');
    return matched;
  }
  window.dhSetState = setState;

  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-state], [data-state-p]') : null;
    if (!t) return;
    // Ignore the strip's viewport toggle — different feature, handled in chrome.
    if (t.hasAttribute('data-vp')) return;
    var id = t.getAttribute('data-state') || t.getAttribute('data-state-p');
    if (!id) return;
    if (!setState(id)) return;
    // In-page demo buttons recenter the viewport on the swapped section.
    if (t.hasAttribute('data-state-p')) {
      var panel = $('[data-state-panel="' + id + '"]');
      if (panel) panel.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    }
  });

  // ?state= deep link support (evidence URLs). The chrome sets initial
  // visibility; this normalizes strip aria-pressed for late/deferred loads.
  try {
    var p = new URLSearchParams(location.search).get('state');
    if (p) setState(p, { announce: false });
  } catch (e) {}

  /* ---- FrameworkVisualizer stepper (PUB-c06) ------------------------------ */
  $$('.framework[data-stages]').forEach(function (fw) {
    var steps = $$('.fw-step', fw);
    var stages = JSON.parse(fw.getAttribute('data-stages'));
    var idx = 0;
    var titleEl = $('.fw-detail h4', fw);
    var bodyEl = $('.fw-detail p', fw);
    var chipsEl = $('.fw-chips', fw);
    var posEl = $('.fw-pos', fw);

    function render(announceStep) {
      var s = stages[idx];
      steps.forEach(function (st, i) {
        st.setAttribute('aria-current', String(i === idx));
        st.tabIndex = i === idx ? 0 : -1;
      });
      if (titleEl) titleEl.textContent = s.name;
      if (bodyEl) bodyEl.textContent = s.summary;
      if (posEl) posEl.textContent = String(idx + 1).padStart(2, '0') + ' / ' + String(stages.length).padStart(2, '0') + ' · ' + (s.code || '');
      if (chipsEl) {
        chipsEl.innerHTML = (s.chips || []).map(function (c) { return '<span class="chip"><b>' + c[0] + '</b>' + c[1] + '</span>'; }).join('');
      }
      if (announceStep) announce('Stage ' + (idx + 1) + ' of ' + stages.length + ': ' + s.name + '.');
      var auto = $('.fw-step[aria-current="true"]', fw);
      if (auto && auto.scrollIntoView) auto.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reduced ? 'auto' : 'smooth' });
    }
    steps.forEach(function (st, i) {
      st.addEventListener('click', function () { idx = i; render(true); });
    });
    var replay = $('.fw-replay', fw);
    if (replay) replay.addEventListener('click', function () { idx = 0; render(true); });
    // keyboard arrows on the step group
    var group = $('.fw-steps', fw);
    if (group) {
      group.setAttribute('role', 'tablist');
      group.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight') { idx = Math.min(idx + 1, stages.length - 1); render(true); steps[idx].focus(); }
        if (e.key === 'ArrowLeft') { idx = Math.max(idx - 1, 0); render(true); steps[idx].focus(); }
      });
    }
    render();
  });

  /* ---- Scenario grid (Situation Map / symptom board) ---------------------- */
  $$('[data-scenarios]').forEach(function (host) {
    var grid = $('.scenario-grid', host);
    if (!grid) return;
    var chips = $$('.scenario-chip', grid);
    var scenarios = JSON.parse(host.getAttribute('data-scenarios'));
    var panel = $('.scenario-panel', host);
    if (!panel || !chips.length) return;
    var titleEl = $('h4', panel);
    var tagEl = $('.sp-tag', panel);
    var ddEls = $$('dd', panel);

    function render(announceIt) {
      var cur = grid.querySelector('.scenario-chip[aria-current="true"]');
      var idx = chips.indexOf(cur);
      if (idx < 0) idx = 0;
      if (idx >= scenarios.length) idx = 0;
      var s = scenarios[idx];
      if (titleEl) titleEl.textContent = s.name;
      if (tagEl) tagEl.textContent = s.tag;
      ddEls.forEach(function (dd, i) { if (s.fields[i] !== undefined) dd.textContent = s.fields[i]; });
      var impact = $('.sp-impact', panel);
      if (impact && s.impact) impact.textContent = s.impact;
      if (announceIt) announce('Situation: ' + s.name + '.');
    }
    chips.forEach(function (c) {
      c.addEventListener('click', function () {
        chips.forEach(function (x) { x.setAttribute('aria-current', 'false'); });
        c.setAttribute('aria-current', 'true');
        render(true);
      });
    });
    render();
  });

  /* ---- Testimonial carousel (PUB-c16) ---------------------------------------- */
  $$('.testimonial[data-items]').forEach(function (t) {
    var items = JSON.parse(t.getAttribute('data-items'));
    var q = $('blockquote', t);
    var whoB = $('.t-who b', t), whoS = $('.t-who span', t), av = $('.t-avatar', t);
    var chooser = $('.t-chooser', t);
    var idx = 0;
    items.forEach(function (it, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = String(i + 1).padStart(2, '0');
      b.setAttribute('aria-label', 'Recommendation ' + (i + 1) + ' of ' + items.length);
      b.addEventListener('click', function () { idx = i; render(true); });
      chooser.appendChild(b);
    });
    function render(announceIt) {
      var it = items[idx];
      q.textContent = '"' + it.quote + '"';
      whoB.textContent = it.name;
      whoS.textContent = it.role;
      if (av) av.textContent = it.initials;
      $$('button', chooser).forEach(function (b, i) { b.setAttribute('aria-current', String(i === idx)); });
      var counter = $('.t-count', t);
      if (counter) counter.textContent = String(idx + 1).padStart(2, '0') + ' / ' + String(items.length).padStart(2, '0');
      if (announceIt) announce('Recommendation ' + (idx + 1) + ' of ' + items.length + ': ' + it.name + ', ' + it.role + '.');
    }
    var prev = $('[data-t-prev]', t), next = $('[data-t-next]', t), play = $('[data-t-play]', t);
    if (prev) prev.addEventListener('click', function () { idx = (idx - 1 + items.length) % items.length; render(true); });
    if (next) next.addEventListener('click', function () { idx = (idx + 1) % items.length; render(true); });
    if (play) play.addEventListener('click', function () { play.textContent = play.textContent.trim() === 'Pause' ? 'Play' : 'Pause'; });
    render();
  });

  /* ---- Booking wizard (SCH-c01) ------------------------------------------------ */
  $$('.wizard[data-flow]').forEach(function (wz) {
    var steps = $$('.wizard-step', wz);
    var stepsBar = $$('.wizard-steps .ws', wz);
    var back = $('[data-wz-back]', wz), fwd = $('[data-wz-next]', wz);
    var idx = 0;
    var STEP_NAMES = ['Service', 'Questions', 'Slot', 'Confirm', 'Status'];
    function render(announceStep) {
      steps.forEach(function (s, i) { s.hidden = i !== idx; });
      stepsBar.forEach(function (b, i) {
        b.classList.toggle('current', i === idx);
        b.classList.toggle('done', i < idx);
        if (i === idx) b.setAttribute('aria-current', 'step');
        else b.removeAttribute('aria-current');
      });
      if (back) back.style.visibility = idx === 0 ? 'hidden' : 'visible';
      if (fwd) { fwd.textContent = idx === steps.length - 1 ? 'Done' : 'Continue'; }
      if (announceStep) {
        var name = $$('.t-eyebrow, h2', steps[idx])[0];
        var stepName = name ? name.textContent : (STEP_NAMES[idx] || ('Step ' + (idx + 1)));
        announce('Step ' + (idx + 1) + ' of ' + steps.length + ': ' + stepName + '.');
        steps[idx].setAttribute('tabindex', '-1');
        steps[idx].focus({ preventScroll: true });
      }
    }
    if (back) back.addEventListener('click', function () { if (idx > 0) { idx--; render(true); } });
    if (fwd) fwd.addEventListener('click', function () { if (idx < steps.length - 1) { idx++; render(true); wz.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' }); } });
    // deep links between wizard and external pages pass ?step=N
    try {
      var p = new URLSearchParams(location.search).get('step');
      if (p !== null && steps[+p]) { idx = +p; }
    } catch (e) {}
    render();
  });

  /* ---- Hold countdown (SCH-c03 / COM-07) ---------------------------------------- */
  $$('[data-hold-countdown]').forEach(function (el) {
    var secs = parseInt(el.getAttribute('data-hold-countdown'), 10) || 900;
    var out = el.querySelector('.timer') || el;
    var expired = el.getAttribute('data-hold-expired') === 'true';
    // The ticking time is visual; the meaningful transitions (expiry,
    // alternatives) are announced. Live-ticking the numbers would be noise.
    var iv = window.setInterval(tick, 1000);
    function fmt(s) { return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
    function tick() {
      if (secs <= 0) {
        window.clearInterval(iv);
        out.textContent = '00:00';
        el.dispatchEvent(new CustomEvent('hold:expired', { bubbles: true }));
        if (expired) {
          // reveal the graceful-alternatives state (S-2) and retire the banner
          var alts = document.getElementById('hold-alternatives') || el.parentElement.querySelector('[data-state-panel="hold-expired"]');
          if (alts) alts.hidden = false;
          var banner = el.closest('.hold-banner');
          if (banner) banner.hidden = true;
          announce('Your 15-minute hold lapsed. The slot returned to the pool; the closest alternatives are shown.');
        }
        return;
      }
      secs--; out.textContent = fmt(secs);
    }
    out.textContent = fmt(secs);
  });

  /* ---- Focus trap + management helpers (FINDING 02) ---------------------- */
  function trapIn(container, e) {
    var f = $$('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])', container)
      .filter(function (el) { return el.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.key === 'Tab' && e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (e.key === 'Tab' && !e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function openLayer(layer, trigger, modal) {
    layer.setAttribute('open', '');
    if (modal) layer.setAttribute('aria-modal', 'true');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    var first = $$('a[href], button:not([disabled]), input, select, textarea', layer)
      .filter(function (el) { return el.offsetParent !== null; })[0];
    if (first) first.focus();
  }
  function closeLayer(layer, trigger) {
    layer.removeAttribute('open');
    if (layer.hasAttribute('aria-modal')) layer.removeAttribute('aria-modal');
    if (trigger) { trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); }
  }

  /* ---- Drawers (public mobile sheet, studio drawer, curriculum drawer) ----------- */
  function bindDrawer(triggerSel, drawerSel, closeSel) {
    var trigger = $(triggerSel), drawer = $(drawerSel);
    if (!trigger || !drawer) return;
    // Drawers are large-screen surfaces on mobile screens; treat as modal.
    trigger.setAttribute('aria-expanded', 'false');
    drawer.setAttribute('aria-modal', 'true');
    trigger.addEventListener('click', function () { openLayer(drawer, trigger, true); });
    drawer.addEventListener('click', function (e) {
      if (e.target === drawer || (e.target.closest && e.target.closest(closeSel))) {
        closeLayer(drawer, trigger);
      }
    });
    drawer.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeLayer(drawer, trigger); }
      trapIn(drawer, e);
    });
  }
  bindDrawer('[data-sheet-open]', '#mobile-sheet', '[data-sheet-close]');
  bindDrawer('[data-studio-drawer-open]', '#studio-drawer', '[data-studio-drawer-close]');
  bindDrawer('[data-curriculum-open]', '#curriculum-drawer', '[data-curriculum-close]');

  /* ---- Dialogs (STU-c20) ------------------------------------------------------------ */
  $$('[data-dialog-open]').forEach(function (btn) {
    var dlg = $('#' + btn.getAttribute('data-dialog-open'));
    if (!dlg) return;
    btn.addEventListener('click', function () { openLayer(dlg, btn, true); });
  });
  $$('[data-dialog-close]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var dlg = btn.closest('.dialog');
      var trigger = document.querySelector('[aria-controls="' + (dlg && dlg.id) + '"]');
      if (dlg) closeLayer(dlg, trigger || document.activeElement);
    });
  });
  $$('.dialog').forEach(function (dlg) {
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.removeAttribute('open'); });
    dlg.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') dlg.removeAttribute('open');
      trapIn(dlg, e);
    });
  });

  /* ---- Toasts (STU-c19) ---------------------------------------------------------------- */
  window.dhToast = function (title, opts) {
    opts = opts || {};
    var stack = $('.toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'toast-stack';
      stack.setAttribute('aria-live', 'polite'); // innerHTML swapped per toast
      document.body.appendChild(stack);
    }
    var t = document.createElement('div');
    t.className = 'toast' + (opts.error ? ' error' : '');
    t.innerHTML = '<b>' + title + '</b>' + (opts.body ? '<span>' + opts.body + '</span>' : '') +
      (opts.undo ? '<div class="t-actions"><button type="button">' + (opts.undoLabel || 'Undo') + '</button></div>' : '');
    stack.appendChild(t);
    window.setTimeout(function () { t.remove(); }, 5000);
    t.addEventListener('click', function () { t.remove(); });
  };
  $$('[data-toast]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var parts = btn.getAttribute('data-toast').split('|');
      window.dhToast(parts[0], { body: parts[1], undo: parts[2] === 'undo' });
    });
  });

  /* ---- Form validation demo (SYS-07 / F-1) ---------------------------------------------- */
  $$('form[data-demo-validate]').forEach(function (form) {
    form.setAttribute('novalidate', '');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var invalid = [];
      $$('[data-required]', form).forEach(function (input) {
        var field = input.closest('.field');
        var empty = !input.value || !input.value.trim();
        if (input.type === 'checkbox') empty = !input.checked;
        if (input.type === 'email' && input.value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.value)) empty = true;
        if (field) { field.classList.toggle('error', empty); field.classList.toggle('valid', !empty); }
        if (empty) invalid.push({ input: input, label: field ? $('label', field) : null });
      });
      var summary = $('[data-error-summary]', form) || $('.error-summary', form);
      if (invalid.length) {
        if (summary) {
          summary.hidden = false;
          var list = $('ul', summary);
          if (list) list.innerHTML = invalid.map(function (f) {
            var name = f.label ? f.label.textContent.replace('*', '').trim() : 'A required field';
            return '<li><a href="#' + (f.input.id || '') + '">' + name + ' needs attention</a></li>';
          }).join('');
          summary.setAttribute('tabindex', '-1'); summary.focus();
        }
        announce('Form not sent: ' + invalid.length + ' field' + (invalid.length > 1 ? 's need' : ' needs') + ' attention.');
        return;
      }
      if (summary) summary.hidden = true;
      var success = $('[data-form-success]', form);
      if (success) {
        success.hidden = false;
        success.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
        announce('Sent.');
      } else if (form.hasAttribute('data-success-navigate')) {
        window.location.href = form.getAttribute('data-success-navigate');
      }
    });
    // inline on blur
    $$('[data-required]', form).forEach(function (input) {
      input.addEventListener('blur', function () {
        var field = input.closest('.field');
        if (!field) return;
        var bad = !input.value || !input.value.trim();
        if (input.type === 'email' && input.value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.value)) bad = true;
        field.classList.toggle('error', bad);
        field.classList.toggle('valid', !bad);
      });
    });
  });

  /* ---- Submitting state demo (INTERACTION-STATES §2) ------------------------------------ */
  $$('[data-submitting]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      var label = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = '<span class="spin" aria-hidden="true"></span> ' + label;
      window.setTimeout(function () {
        btn.disabled = false;
        btn.textContent = label;
        var done = btn.getAttribute('data-submitting-done');
        if (done) window.dhToast(done, {});
      }, 1600);
    });
  });

  /* ---- Mobile preview toggle (STU-c10) ----------------------------------------------------- */
  $$('[data-preview-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var frame = $('#' + btn.getAttribute('data-preview-toggle'));
      if (!frame) return;
      var mobile = btn.getAttribute('data-preview-mode') !== 'mobile';
      btn.setAttribute('data-preview-mode', mobile ? 'mobile' : 'desktop');
      btn.textContent = mobile ? 'Desktop' : 'Mobile';
      frame.classList.toggle('preview-mobile', mobile);
    });
  });

  /* ---- Access Mode switcher demo (STU-c12) -------------------------------------------------- */
  $$('[data-mode-switch]').forEach(function (group) {
    var buttons = $$('button', group);
    var note = $('[data-mode-note]', group.parentElement) || $('[data-mode-note]', group.closest('.mode-demo') || document);
    var ctaDemo = $('[data-mode-cta]');
    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        buttons.forEach(function (x) { x.setAttribute('aria-current', String(x === b)); });
        var mode = b.getAttribute('data-mode');
        if (note) {
          var notes = {
            FREE: 'FREE — visitors sign up and enter the classroom immediately. No checkout, no Order. Existing access is never affected.',
            PAID_ONE_TIME: 'PAID — checkout handoff when a gateway is active. Today no gateway is configured, so the page degrades to its fallback CTA (BR-3) — never a broken "Buy Now".',
            PAID_SESSION: 'PAID SESSION — payment attaches to a booking. Slot hold spans payment; confirmation happens after verified payment.',
            MANUAL_INVOICE: 'MANUAL / INVOICE — your request creates an Order in REQUESTED state. Nothing is automatic from here: Ahmed reviews the request personally and records completion; only then is enrollment granted. No instant access is promised.',
            PAYMENT_DISABLED: 'PAYMENT DISABLED — no payment UI renders. The page collects interest via the waitlist with an honest promise.'
          };
          note.textContent = notes[mode] || '';
          note.hidden = false;
        }
        if (ctaDemo) {
          var labels = {
            FREE: 'Start Free', PAID_ONE_TIME: 'Buy Now', PAID_SESSION: 'Book Coaching',
            MANUAL_INVOICE: 'Request Access', PAYMENT_DISABLED: 'Join Waitlist'
          };
          ctaDemo.textContent = labels[mode] || 'Start Free';
        }
        announce('Access mode: ' + (b.textContent || mode) + '.');
      });
    });
  });

  /* ---- Fake countdown for scheduled publish --------------------------------------------------- */
  $$('[data-countdown-until]').forEach(function (el) {
    var target = new Date(el.getAttribute('data-countdown-until')).getTime();
    function tick() {
      var d = target - Date.now();
      if (d <= 0) { el.textContent = 'Publishing…'; return; }
      var h = Math.floor(d / 3600000), m = Math.floor(d % 3600000 / 60000), s = Math.floor(d % 60000 / 1000);
      el.textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      window.setTimeout(tick, 1000);
    }
    tick();
  });

  /* ---- Command Center five-question scrollspy (FINDING 02) -----------------
     The five-question chip nav (Q1..Q5) links to in-page panels; the active
     chip gets aria-current as the reader scrolls, so keyboard/screen-reader
     users can tell where they are. */
  (function () {
    var nav = $('nav[aria-label="The five questions"]');
    if (!nav) return;
    var links = $$('a', nav);
    var panels = links.map(function (a) { return $(a.getAttribute('href')); });
    if (!panels.length || panels.some(function (p) { return !p; })) return;

    function setActive(i) {
      links.forEach(function (a, j) {
        if (j === i) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      });
    }
    function check() {
      var probe = window.innerHeight * 0.35;
      var best = 0;
      panels.forEach(function (p, i) {
        if (p.getBoundingClientRect().top <= probe) best = i;
      });
      setActive(best);
    }
    window.addEventListener('scroll', check, { passive: true });
    check();
  })();
})();
