/* ════════════════════════════════════════════════════════════════════
   The One Root — Smart cross-sell for the in-book reader.

   Goal: gently recommend the NEXT book in the series that the reader does
   NOT own yet — without disturbing reading or feeling pushy.

   Design principles
   ─────────────────
   • Ownership-aware: pulls the user's entitlements from /api/auth and only
     ever promotes a volume they don't already have. Owns all 3 → shows nothing.
   • Earned attention: only appears to readers who have UNLOCKED the current
     book (proven buyers), and only after they've been reading a while.
   • One book, one quiet chip + a natural end-of-book card. Never a popup.
   • Dismissible and remembered (per target) so it never nags.

   Usage:  <script defer src="/cross-sell.js" data-current="vol1"></script>
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var script = document.currentScript;
  var CURRENT = (script && script.getAttribute('data-current')) || '';
  if (!/^vol[123]$/.test(CURRENT)) return;

  // ── Book catalogue ──────────────────────────────────────────────────
  var BOOKS = {
    vol1: {
      num: 'I', accent: '#C99A3B', accent2: '#E0BD6A',
      tag: 'ภาคจิตวิทยา', title: 'รากแก้วการตลาด',
      chipCta: 'ทำไมคนถึงตัดสินใจซื้อ',
      url: '/sale-sales', preview: '/vol1',
      kicker: 'รากของทุกการตัดสินใจ',
      endTitle: 'ก่อนจะรบ ต้องเข้าใจ <em>“ทำไมคนถึงซื้อ”</em>',
      endBody: 'รากแก้วการตลาด — 12 กลไกจิตวิทยาเบื้องหลังการตัดสินใจของมนุษย์ ที่อยู่เบื้องหลังทุกแคมเปญที่ได้ผล',
      endCta: 'ดูรากแก้วการตลาด →',
      meta: '12 บท + 5 บทพิเศษ'
    },
    vol2: {
      num: 'II', accent: '#00f0ff', accent2: '#ff2b7a',
      tag: 'สนามรบดิจิทัล', title: 'The Invisible War',
      chipCta: 'สงครามที่มองไม่เห็น',
      url: '/sale-vol2', preview: '/vol2',
      kicker: 'ภาคต่อของสนามรบ',
      endTitle: 'รู้แล้วว่าคนซื้อเพราะอะไร — <em>ทีนี้ทำให้เขาเห็นคุณ</em>',
      endBody: 'The Invisible War — เมื่อทุกแบรนด์มีเครื่องมือเหมือนกัน สงครามที่แท้จริงคือการแย่ง “ความสนใจ” ก่อนนิ้วจะเลื่อนผ่าน',
      endCta: 'ดู The Invisible War →',
      meta: '12 บท + 5 field reports'
    },
    vol3: {
      num: 'III', accent: '#4FCB8E', accent2: '#3f9d7d',
      tag: 'ภาคธุรกิจ', title: 'รากแก้วธุรกิจ',
      chipCta: 'มองธุรกิจทั้งระบบ',
      url: '/sale-vol3', preview: '/vol3',
      kicker: 'ภาพที่ใหญ่กว่าการตลาด',
      endTitle: 'การตลาดคือกิ่ง — <em>ธุรกิจคือราก</em>',
      endBody: 'รากแก้วธุรกิจ — มองธุรกิจทั้งระบบจากรากเดียว ตั้งแต่หน้าร้านสู่ระบบที่ขยายได้ พร้อมภาคผนวกเครื่องมือเหมือนเรียน MBA ย่อ',
      endCta: 'ดูรากแก้วธุรกิจ →',
      meta: '13 บท + 5 บทพิเศษ'
    }
  };

  // Complete-the-series order: next volume first, then the other.
  var ORDER = {
    vol1: ['vol2', 'vol3'],
    vol2: ['vol3', 'vol1'],
    vol3: ['vol1', 'vol2']
  };

  var SHOW_DELAY_MS = 25000; // appear ~25s after the reader is unlocked

  // ── Helpers ─────────────────────────────────────────────────────────
  function dismissKey(target) { return 'xsell-dismissed-' + target; }
  function isDismissed(target) {
    try { return localStorage.getItem(dismissKey(target)) === '1'; } catch (e) { return false; }
  }
  function setDismissed(target) {
    try { localStorage.setItem(dismissKey(target), '1'); } catch (e) {}
  }
  function isUnlocked() {
    return document.body.classList.contains('unlocked') ||
      hasLS('oneroot-uk') || hasLS('oneroot-uc');
  }
  function hasLS(k) { try { return !!localStorage.getItem(k); } catch (e) { return false; } }

  // Fetch the set of volumes this account owns (best-effort).
  function getOwned() {
    return fetch('/api/auth', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var owned = {};
        if (d && d.authenticated && Array.isArray(d.entitlements)) {
          d.entitlements.forEach(function (e) { if (e && e.product) owned[e.product] = true; });
        }
        return owned;
      })
      .catch(function () { return {}; });
  }

  // Choose the first series volume that is neither owned nor dismissed.
  function pickTarget(owned) {
    var list = ORDER[CURRENT] || [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (!owned[v] && !isDismissed(v)) return v;
    }
    return null;
  }

  function track(label, target) {
    try {
      if (window.fbq) fbq('trackCustom', 'CrossSellClick', { from: CURRENT, to: target, placement: label });
    } catch (e) {}
  }

  // ── Styles (injected once) ──────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('xsell-styles')) return;
    var css = [
      '.xs-chip{position:fixed;right:20px;bottom:84px;z-index:900;display:none;align-items:center;gap:10px;',
        'max-width:330px;padding:12px 30px 12px 14px;border-radius:12px;color:#ECECEC;',
        "font-family:'Sarabun','IBM Plex Sans Thai',sans-serif;font-size:13px;line-height:1.5;",
        'background:linear-gradient(135deg,#15140F 0%,#1F1B12 100%);',
        'border:1px solid color-mix(in srgb,var(--xs) 32%,transparent);',
        'box-shadow:0 12px 34px rgba(0,0,0,.42),0 0 26px color-mix(in srgb,var(--xs) 14%,transparent);',
        'opacity:0;transform:translateY(16px);transition:opacity .5s cubic-bezier(.16,1,.3,1),transform .5s cubic-bezier(.16,1,.3,1);',
        '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}',
      '.xs-chip.visible{display:flex}',
      // Never overlap the mobile table-of-contents drawer when it is open.
      '#sidebar.open ~ .xs-chip{display:none !important}',
      '.xs-chip.in{opacity:1;transform:translateY(0)}',
      '.xs-chip::before{content:"";position:absolute;top:0;left:16px;right:16px;height:1px;',
        'background:linear-gradient(90deg,transparent,var(--xs),var(--xs2),transparent);opacity:.65}',
      '.xs-glyph{flex-shrink:0;width:38px;height:38px;border-radius:8px;display:flex;align-items:center;justify-content:center;',
        "font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.04em;color:var(--xs);",
        'background:linear-gradient(135deg,#1d1a12,#13110C);border:1px solid color-mix(in srgb,var(--xs) 34%,transparent);',
        'text-shadow:0 0 8px color-mix(in srgb,var(--xs) 55%,transparent)}',
      '.xs-body{flex:1;min-width:0}',
      '.xs-tag{display:block;font-family:"JetBrains Mono",monospace;font-size:9px;color:var(--xs2);',
        'letter-spacing:.16em;text-transform:uppercase;margin-bottom:2px}',
      '.xs-name{display:block;color:#fff;font-weight:600;font-size:13px}',
      '.xs-link{display:inline-block;margin-top:3px;color:var(--xs);text-decoration:none;font-size:11px;',
        "font-family:'JetBrains Mono',monospace;border-bottom:1px dotted color-mix(in srgb,var(--xs) 50%,transparent)}",
      '.xs-link:hover{color:var(--xs2);border-color:var(--xs2)}',
      '.xs-close{position:absolute;top:5px;right:7px;width:18px;height:18px;border:none;background:transparent;',
        'color:#6b6457;font-size:14px;line-height:1;cursor:pointer;padding:0;border-radius:4px;transition:color .2s,background .2s}',
      '.xs-close:hover{color:var(--xs2);background:color-mix(in srgb,var(--xs2) 12%,transparent)}',
      // End-of-book card
      '.xs-endcard{display:none;max-width:720px;margin:3.5rem auto 2rem;padding:2rem 1.8rem;position:relative;overflow:hidden;',
        'border-radius:14px;color:#D8D2C6;font-family:"Sarabun","IBM Plex Sans Thai",sans-serif;',
        'background:linear-gradient(135deg,#13120D 0%,#1E1A12 100%);',
        'border:1px solid color-mix(in srgb,var(--xs) 24%,transparent)}',
      'body.unlocked .xs-endcard{display:block}',
      '.xs-endcard::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;',
        'background:linear-gradient(90deg,transparent,var(--xs),var(--xs2),transparent)}',
      '.xs-endcard .xs-kicker{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--xs2);',
        'letter-spacing:.2em;text-transform:uppercase;margin-bottom:12px;display:inline-block}',
      '.xs-endcard h3{font-family:"Prompt",sans-serif;font-size:1.5rem;font-weight:700;color:#fff;margin:0 0 12px;line-height:1.4}',
      '.xs-endcard h3 em{font-style:normal;color:var(--xs)}',
      '.xs-endcard p{font-size:.95rem;line-height:1.85;margin:0 0 18px;color:#CFC8BB}',
      '.xs-cta{display:inline-flex;align-items:center;gap:8px;padding:12px 26px;border-radius:8px;text-decoration:none;',
        "font-family:'Prompt',sans-serif;font-size:.95rem;font-weight:700;color:#15120B;",
        'background:linear-gradient(135deg,var(--xs),var(--xs2));',
        'box-shadow:0 8px 24px color-mix(in srgb,var(--xs) 28%,transparent);transition:transform .2s,box-shadow .2s}',
      '.xs-cta:hover{transform:translateY(-1px);box-shadow:0 10px 30px color-mix(in srgb,var(--xs) 42%,transparent)}',
      '.xs-endmeta{display:block;margin-top:12px;font-family:"JetBrains Mono",monospace;font-size:.75rem;color:#8a8270}',
      '.xs-endmeta a{color:var(--xs);text-decoration:none;border-bottom:1px dotted color-mix(in srgb,var(--xs) 45%,transparent)}',
      '@media (max-width:600px){.xs-chip{right:12px;bottom:78px;max-width:calc(100vw - 24px)}',
        '.xs-endcard{padding:1.5rem 1.3rem;margin:2.5rem 1rem 1.5rem}.xs-endcard h3{font-size:1.2rem}}',
      '@media (prefers-reduced-motion:reduce){.xs-chip{transition:opacity .2s}}'
    ].join('');
    var style = document.createElement('style');
    style.id = 'xsell-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── Render ──────────────────────────────────────────────────────────
  function render(target) {
    var b = BOOKS[target];
    if (!b) return;
    injectStyles();

    var themeVars = '--xs:' + b.accent + ';--xs2:' + b.accent2 + ';';

    // Floating chip
    var chip = document.createElement('div');
    chip.className = 'xs-chip';
    chip.setAttribute('role', 'complementary');
    chip.setAttribute('aria-label', 'แนะนำ ' + b.title);
    chip.setAttribute('style', themeVars);
    chip.innerHTML =
      '<button class="xs-close" aria-label="ปิด">×</button>' +
      '<div class="xs-glyph">V.' + b.num + '</div>' +
      '<div class="xs-body">' +
        '<span class="xs-tag">// ' + b.tag + '</span>' +
        '<span class="xs-name">' + b.title + '</span>' +
        '<a class="xs-link" href="' + b.url + '">' + b.chipCta + ' →</a>' +
      '</div>';
    document.body.appendChild(chip);

    // End-of-book card → appended after the reading content
    var endcard = document.createElement('div');
    endcard.className = 'xs-endcard';
    endcard.setAttribute('style', themeVars);
    endcard.innerHTML =
      '<span class="xs-kicker">// ' + b.kicker + '</span>' +
      '<h3>' + b.endTitle + '</h3>' +
      '<p>' + b.endBody + '</p>' +
      '<a class="xs-cta" href="' + b.url + '">' + b.endCta + '</a>' +
      '<span class="xs-endmeta">// ' + b.meta + ' &bull; <a href="' + b.preview + '">อ่านบทนำฟรี</a></span>';
    var content = document.getElementById('content') || document.querySelector('main');
    if (content) content.appendChild(endcard);

    // Wire interactions
    chip.querySelector('.xs-close').addEventListener('click', function () {
      setDismissed(target);
      chip.classList.remove('in');
      setTimeout(function () { chip.classList.remove('visible'); }, 500);
    });
    chip.querySelector('.xs-link').addEventListener('click', function () { track('chip', target); });
    endcard.querySelector('.xs-cta').addEventListener('click', function () { track('endcard', target); });

    function showChip() {
      if (isDismissed(target)) return;
      chip.classList.add('visible');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { chip.classList.add('in'); });
      });
    }

    // Only surface the chip to engaged, unlocked readers, after a delay.
    if (isUnlocked()) {
      setTimeout(showChip, SHOW_DELAY_MS);
    } else {
      var mo = new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          if (m.attributeName === 'class' && isUnlocked()) {
            mo.disconnect();
            setTimeout(showChip, SHOW_DELAY_MS);
          }
        });
      });
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
  }

  // ── Boot ────────────────────────────────────────────────────────────
  function init() {
    getOwned().then(function (owned) {
      if (owned[CURRENT] === undefined) { /* unknown ownership is fine */ }
      var target = pickTarget(owned);
      if (target) render(target);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
