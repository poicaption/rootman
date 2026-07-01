/*!
 * guard.js — Rootman copy / inspect deterrent (client-side only).
 *
 * IMPORTANT: This script does NOT hide, cloak, or remove any content
 * from the page. Search engines (Googlebot, Bing) and AI answer engines
 * (GPTBot, ClaudeBot, PerplexityBot, ...) read the raw server HTML and
 * never fire these browser events, so SEO / AEO is completely unaffected.
 *
 * It only raises the effort for casual snooping / copy-paste. A determined
 * person can always bypass client-side code (disable JS, view-source:, curl,
 * the Network tab). Treat this as a polite "keep out" sign, not a lock.
 */
(function () {
  'use strict';

  /* ── 1) Console trap — self-XSS style warning ─────────────────── */
  try {
    console.log('%cหยุดก่อน! ✋', 'font-size:44px;font-weight:800;color:#c99a3b;');
    console.log('%c⚠️ ตรงนี้ไม่ใช่ที่สำหรับคุณ', 'font-size:17px;font-weight:700;color:#e0584b;');
    console.log(
      '%cถ้ามีใครส่งโค้ดมาให้คุณ "ก๊อปวาง" ตรงนี้เพื่อ ปลดล็อก / แฮ็ก / ดูข้อมูลใครบางคน — ' +
      'นั่นคือการหลอกลวง (scam) ที่จะทำให้บัญชีของคุณถูกขโมย อย่าทำเด็ดขาด\n\n' +
      'โค้ด ดีไซน์ เนื้อหา และระบบทั้งหมดของเว็บนี้เป็นทรัพย์สินทางปัญญาของ Rootman © ' +
      'สงวนลิขสิทธิ์ — ห้ามคัดลอก ทำซ้ำ หรือดัดแปลงเพื่อการค้า',
      'font-size:14px;color:#8a94a6;line-height:1.7;'
    );
    console.log('%c— Rootman', 'font-size:13px;font-weight:700;color:#c99a3b;');
  } catch (e) {}

  /* ── Helper: is the event target an editable form field? ───────── */
  function inField(t) {
    return !!(t && t.closest && t.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
    ));
  }

  /* ── 2) Deter right-click (still works inside form fields) ─────── */
  document.addEventListener('contextmenu', function (e) {
    if (inField(e.target)) return; // allow paste / spellcheck in inputs
    e.preventDefault();
  }, true);

  /* ── 3) Deter view-source / devtools keyboard shortcuts ───────── */
  /*    NOTE: Ctrl/Cmd+C is intentionally NOT blocked so that normal
   *    text selection and the on-page "copy code" buttons keep working. */
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    var block =
      k === 'f12' ||
      ((e.ctrlKey || e.metaKey) && !e.shiftKey && (k === 'u' || k === 's')) ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey && (k === 'i' || k === 'j' || k === 'c'));
    if (block) { e.preventDefault(); e.stopPropagation(); }
  }, true);
})();
