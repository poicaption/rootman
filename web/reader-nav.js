/* ════════════════════════════════════════════════════════════════════
   The One Root Reading HUD (shared across vol1/2/3).

   A small, auto-fading heads-up display pinned to the top-centre that adds
   two reading-quality features WITHOUT touching unlock / auth / permissions:
     • Progress readout      → "NN%" + estimated minutes remaining
     • Chapter navigation    → ‹ previous / next › jump between rendered
                               chapter sections

   This script is strictly read-only: it observes scroll position and the
   already-rendered .chapter-section elements. It never unlocks content,
   reads entitlements, or alters any access logic. The HUD only appears once
   the reader is already unlocked (body.unlocked) and has scrolled past the
   cover, so it never interferes with the paywall/unlock flow.

   Usage:  <script defer src="/reader-nav.js"></script>
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CHARS_PER_MIN = 400; // approximate Thai reading pace for time-left estimate
  var SHOW_AFTER = 500;    // px scrolled before the HUD appears

  function isUnlocked() {
    return document.body.classList.contains('unlocked') ||
      hasLS('oneroot-uk') || hasLS('oneroot-uc');
  }
  function hasLS(k) { try { return !!localStorage.getItem(k); } catch (e) { return false; } }

  function injectStyles() {
    if (document.getElementById('rn-styles')) return;
    var css = [
      '.rn-hud{position:fixed;top:14px;left:50%;z-index:900;display:none;align-items:center;gap:2px;',
        'padding:5px 6px;border-radius:999px;opacity:0;',
        'transform:translateX(-50%) translateY(-12px);',
        'transition:opacity .3s ease,transform .3s ease;',
        'background:linear-gradient(135deg,#15140F 0%,#1F1B12 100%);',
        'border:1px solid color-mix(in srgb,var(--accent,#C99A3B) 30%,transparent);',
        'box-shadow:0 8px 26px rgba(0,0,0,.42);',
        "font-family:'Sarabun','IBM Plex Sans Thai',sans-serif;color:#ECECEC;",
        '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}',
      '.rn-hud.show{display:flex;opacity:.5;transform:translateX(-50%) translateY(0)}',
      // Never overlap the mobile table-of-contents drawer when it is open.
      '#sidebar.open ~ .rn-hud{display:none !important}',
      '.rn-hud.show:hover,.rn-hud.show:focus-within{opacity:1}',
      '.rn-btn{width:30px;height:30px;border:none;background:transparent;cursor:pointer;border-radius:50%;',
        'display:flex;align-items:center;justify-content:center;font-size:17px;line-height:1;',
        'color:var(--accent-light,#E0BD6A);transition:background .2s,color .2s}',
      '.rn-btn:hover:not(:disabled){background:color-mix(in srgb,var(--accent,#C99A3B) 20%,transparent);color:#fff}',
      '.rn-btn:disabled{opacity:.28;cursor:default}',
      '.rn-meta{display:flex;flex-direction:column;align-items:center;line-height:1.12;padding:0 9px;min-width:58px}',
      '.rn-pct{font-family:"JetBrains Mono",monospace;font-size:12px;font-weight:700;color:#fff;letter-spacing:.02em}',
      '.rn-time{font-size:9px;color:var(--accent-light,#E0BD6A);opacity:.85;white-space:nowrap}',
      '@media (prefers-reduced-motion:reduce){.rn-hud{transition:opacity .15s}}',
      '@media (max-width:600px){.rn-hud{top:10px}.rn-time{display:none}.rn-meta{min-width:44px;padding:0 6px}}'
    ].join('');
    var s = document.createElement('style');
    s.id = 'rn-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function init() {
    var sections = Array.prototype.slice.call(document.querySelectorAll('.chapter-section'));
    if (!sections.length) return;

    injectStyles();

    var hud = document.createElement('div');
    hud.className = 'rn-hud';
    hud.setAttribute('role', 'navigation');
    hud.setAttribute('aria-label', 'ตัวช่วยอ่าน');
    hud.innerHTML =
      '<button class="rn-btn rn-prev" aria-label="บทก่อนหน้า" title="บทก่อนหน้า">‹</button>' +
      '<div class="rn-meta">' +
        '<span class="rn-pct">0%</span>' +
        '<span class="rn-time">&nbsp;</span>' +
      '</div>' +
      '<button class="rn-btn rn-next" aria-label="บทถัดไป" title="บทถัดไป">›</button>';
    document.body.appendChild(hud);

    var prevBtn = hud.querySelector('.rn-prev');
    var nextBtn = hud.querySelector('.rn-next');
    var pctEl = hud.querySelector('.rn-pct');
    var timeEl = hud.querySelector('.rn-time');

    var totalChars = 0;
    function ensureTotal() {
      if (totalChars > 0) return;
      var bodies = document.querySelectorAll('.chapter-body');
      var n = 0;
      bodies.forEach(function (b) { n += (b.textContent || '').replace(/\s+/g, '').length; });
      totalChars = n;
    }

    function currentIndex() {
      var idx = 0;
      for (var i = 0; i < sections.length; i++) {
        if (sections[i].getBoundingClientRect().top <= 140) idx = i; else break;
      }
      return idx;
    }

    function scrollToSection(el) {
      if (!el) return;
      var y = el.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }

    var ticking = false;
    function update() {
      ticking = false;
      var unlocked = isUnlocked();
      var scrollTop = window.scrollY;

      if (!unlocked || scrollTop < SHOW_AFTER) {
        hud.classList.remove('show');
        return;
      }
      hud.classList.add('show');

      var docHeight = document.documentElement.scrollHeight - window.innerHeight;
      var frac = docHeight > 0 ? Math.min(1, Math.max(0, scrollTop / docHeight)) : 0;
      pctEl.textContent = Math.round(frac * 100) + '%';

      ensureTotal();
      if (totalChars > 0) {
        var remainMin = Math.ceil((totalChars * (1 - frac)) / CHARS_PER_MIN);
        timeEl.textContent = remainMin > 0 ? '~' + remainMin + ' นาที' : 'จบแล้ว';
      }

      var idx = currentIndex();
      prevBtn.disabled = idx <= 0;
      nextBtn.disabled = idx >= sections.length - 1;
    }

    function onScroll() {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }

    prevBtn.addEventListener('click', function () {
      var idx = currentIndex();
      if (idx > 0) scrollToSection(sections[idx - 1]);
    });
    nextBtn.addEventListener('click', function () {
      var idx = currentIndex();
      if (idx < sections.length - 1) scrollToSection(sections[idx + 1]);
    });

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    update();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
