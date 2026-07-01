/*!
 * guard.js — Rootman console notice (client-side only).
 *
 * Right-click and browser devtools (Inspect) are intentionally LEFT ENABLED
 * so the site behaves normally. This file only prints a copyright / anti-scam
 * notice to the console. It does NOT block any browser feature and does NOT
 * hide content, so SEO / AEO is completely unaffected.
 *
 * NOTE: A static website cannot hide its source code while still allowing
 * Inspect — the browser must receive the HTML/CSS/JS to render the page, and
 * that is exactly what devtools shows. The only realistic deterrent is
 * minifying / obfuscating the code (harder to read, not impossible).
 */
(function () {
  'use strict';

  try {
    console.log('%cRootman ✋', 'font-size:40px;font-weight:800;color:#c99a3b;');
    console.log('%c⚠️ ระวังการหลอกลวง', 'font-size:16px;font-weight:700;color:#e0584b;');
    console.log(
      '%cถ้ามีใครส่งโค้ดมาให้คุณ "ก๊อปวาง" ตรงนี้เพื่อ ปลดล็อก / แฮ็ก / ดูข้อมูลใครบางคน — ' +
      'นั่นคือการหลอกลวง (scam) ที่จะทำให้บัญชีของคุณถูกขโมย อย่าทำเด็ดขาด\n\n' +
      'โค้ด ดีไซน์ เนื้อหา และระบบทั้งหมดของเว็บนี้เป็นทรัพย์สินทางปัญญาของ Rootman © ' +
      'สงวนลิขสิทธิ์ — ห้ามคัดลอก ทำซ้ำ หรือดัดแปลงเพื่อการค้า',
      'font-size:14px;color:#8a94a6;line-height:1.7;'
    );
    console.log('%c— Rootman', 'font-size:13px;font-weight:700;color:#c99a3b;');
  } catch (e) {}
})();
