/* ════════════════════════════════════════════════════════════════════
   The One Root — Reading comfort preferences (shared across vol1/2/3).

   Adds a small "ตั้งค่าการอ่าน" panel inside the sidebar footer letting
   readers tune the two things that matter most for long-form Thai text:
     • Font size  (ก− / ก+)        → 15–21px, default 17px
     • Line spacing (ปกติ / ห่าง)  → comfortable leading for dense pages

   Choices persist in localStorage and are shared across all three books,
   so a reader sets it once. Applied early; reading content is unlock-gated
   so there is no visible reflow for the reader.

   Usage:  <script defer src="/reader-prefs.js"></script>
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var FS_KEY = 'oneroot-fontsize';   // integer px, e.g. 18
  var LEAD_KEY = 'oneroot-leading';  // 'relaxed' | 'normal'
  var FS_MIN = 15, FS_MAX = 21, FS_BASE = 17, FS_STEP = 1;

  function getLS(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function setLS(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function delLS(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function savedSize() {
    var v = parseInt(getLS(FS_KEY), 10);
    return (v >= FS_MIN && v <= FS_MAX) ? v : null; // null → respect responsive CSS default
  }
  function savedLeading() { return getLS(LEAD_KEY) === 'relaxed' ? 'relaxed' : 'normal'; }

  // ── Apply ───────────────────────────────────────────────────────────
  function applySize(px) {
    if (px == null) {
      document.documentElement.style.fontSize = ''; // back to CSS (17px / 16px mobile)
    } else {
      document.documentElement.style.fontSize = px + 'px';
    }
  }
  function applyLeading(mode) {
    document.body.classList.toggle('rp-relaxed', mode === 'relaxed');
  }

  function injectStyles() {
    if (document.getElementById('rp-styles')) return;
    var css = [
      'body.rp-relaxed .chapter-body p,body.rp-relaxed .chapter-body li{line-height:2.15 !important}',
      '.rp-panel{margin:0 0 0.9rem;padding:0.9rem 0.9rem 1rem;border-radius:10px;',
        'background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08)}',
      '.rp-title{display:block;font-family:"JetBrains Mono",monospace;font-size:0.6rem;letter-spacing:0.18em;',
        'text-transform:uppercase;color:var(--accent-light,#C99A3B);opacity:0.8;margin-bottom:0.7rem}',
      '.rp-row{display:flex;align-items:center;justify-content:space-between;gap:0.5rem}',
      '.rp-row + .rp-row{margin-top:0.7rem}',
      '.rp-label{font-size:0.78rem;color:var(--sidebar-text,#cfc8bb);opacity:0.85;white-space:nowrap}',
      '.rp-btns{display:flex;align-items:center;gap:4px}',
      '.rp-btn{display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:30px;padding:0 8px;',
        'border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.03);color:var(--sidebar-text,#cfc8bb);',
        'font-family:inherit;font-size:0.82rem;line-height:1;border-radius:7px;cursor:pointer;',
        'transition:background .18s,border-color .18s,color .18s}',
      '.rp-btn:hover{border-color:var(--accent,#C99A3B);color:var(--accent-light,#E0BD6A)}',
      '.rp-btn:active{transform:translateY(1px)}',
      '.rp-btn.rp-on{background:color-mix(in srgb,var(--accent,#C99A3B) 22%,transparent);',
        'border-color:var(--accent,#C99A3B);color:#fff}',
      '.rp-val{min-width:34px;text-align:center;font-family:"JetBrains Mono",monospace;font-size:0.72rem;',
        'color:var(--accent-light,#E0BD6A)}',
      '.rp-size-a{font-family:"Prompt",sans-serif;font-weight:700}',
      '.rp-size-a.sm{font-size:0.7rem}.rp-size-a.lg{font-size:1rem}'
    ].join('');
    var s = document.createElement('style');
    s.id = 'rp-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── UI ──────────────────────────────────────────────────────────────
  function buildPanel() {
    var footer = document.querySelector('.sidebar-footer');
    if (!footer || document.querySelector('.rp-panel')) return;

    var panel = document.createElement('div');
    panel.className = 'rp-panel';
    panel.innerHTML =
      '<span class="rp-title">// ตั้งค่าการอ่าน</span>' +
      '<div class="rp-row">' +
        '<span class="rp-label">ขนาดตัวอักษร</span>' +
        '<div class="rp-btns">' +
          '<button class="rp-btn" data-fs="dec" aria-label="ลดขนาดตัวอักษร"><span class="rp-size-a sm">ก</span></button>' +
          '<button class="rp-btn rp-reset" data-fs="reset" aria-label="รีเซ็ตขนาด"><span class="rp-val">17</span></button>' +
          '<button class="rp-btn" data-fs="inc" aria-label="เพิ่มขนาดตัวอักษร"><span class="rp-size-a lg">ก</span></button>' +
        '</div>' +
      '</div>' +
      '<div class="rp-row">' +
        '<span class="rp-label">ระยะบรรทัด</span>' +
        '<div class="rp-btns">' +
          '<button class="rp-btn rp-lead" data-lead="normal">ปกติ</button>' +
          '<button class="rp-btn rp-lead" data-lead="relaxed">ห่าง</button>' +
        '</div>' +
      '</div>';

    // Insert above the existing Dark Mode toggle.
    footer.insertBefore(panel, footer.firstChild);

    var valEl = panel.querySelector('.rp-val');
    function currentPx() { var s = savedSize(); return s == null ? FS_BASE : s; }
    function refresh() {
      valEl.textContent = currentPx();
      var lead = savedLeading();
      panel.querySelectorAll('.rp-lead').forEach(function (b) {
        b.classList.toggle('rp-on', b.getAttribute('data-lead') === lead);
      });
    }

    function changeSize(delta) {
      var next = Math.min(FS_MAX, Math.max(FS_MIN, currentPx() + delta));
      if (next === FS_BASE) { delLS(FS_KEY); applySize(null); }
      else { setLS(FS_KEY, next); applySize(next); }
      refresh();
    }

    panel.addEventListener('click', function (e) {
      var btn = e.target.closest('.rp-btn');
      if (!btn) return;
      var fs = btn.getAttribute('data-fs');
      if (fs === 'inc') changeSize(FS_STEP);
      else if (fs === 'dec') changeSize(-FS_STEP);
      else if (fs === 'reset') { delLS(FS_KEY); applySize(null); refresh(); }
      var lead = btn.getAttribute('data-lead');
      if (lead) {
        if (lead === 'relaxed') setLS(LEAD_KEY, 'relaxed'); else delLS(LEAD_KEY);
        applyLeading(lead);
        refresh();
      }
    });

    refresh();
  }

  // ── Boot ────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    applySize(savedSize());
    applyLeading(savedLeading());
    buildPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
