# บทความอัพเดทความรู้ — The One Root Series

ชุดบทความ 5 เรื่อง เล่าสไตล์ **rootman** (เปิดด้วยเรื่องจริง/งานวิจัย, สร้างแรงตึงความอยากรู้, ถามผู้อ่านตรงๆ, ประโยคสั้นกระแทก, **ตัวหนา**เน้นแนวคิดหลัก, `>` blockquote สำหรับสูตร/แก่น, ปิดท้ายโยงกลับ "ราก") พร้อมจุดวางรูปภาพและ prompt สำหรับให้ AI สร้างรูปครบทุก section

> **สถานะรูปภาพ:** ตอนนี้ทุกบทความอ้างอิงรูปแบบ *mock* (ไฟล์ยังไม่มีจริง) ที่ path `images/articles/...` — ใช้ prompt ในแต่ละบท (และในตารางด้านล่าง) สร้างรูปด้วย AI แล้ววางไฟล์ตามชื่อที่กำหนด รูปจะแสดงทันที

---

## รายการบทความ

| # | ไฟล์ | หัวข้อ | หมวด | เวลาอ่าน |
|---|------|--------|------|----------|
| 1 | [01-ai-marketing-2026.md](01-ai-marketing-2026.md) | ลูกมือที่ไม่เคยหลับ — เมื่อทุกคนมี AI แล้วการตลาดที่ชนะคืออะไร | การตลาด · เทคโนโลยี | 12 นาที |
| 2 | [02-attention-economy.md](02-attention-economy.md) | สงคราม 3 วินาที — เศรษฐกิจที่แย่งกันด้วยสายตาของคุณ | การตลาด · จิตวิทยา | 13 นาที |
| 3 | [03-pricing-psychology.md](03-pricing-psychology.md) | ราคาคือเรื่องเล่า — จิตวิทยาที่ทำให้คนยอมจ่ายแพงกว่า | ธุรกิจ · จิตวิทยา | 14 นาที |
| 4 | [04-hook-shortform-content.md](04-hook-shortform-content.md) | ตะขอยุคสั้น — วิทยาศาสตร์ของคอนเทนต์ที่คนดูจนจบ | การตลาด · คอนเทนต์ | 13 นาที |
| 5 | [05-brand-loyalty-tribe.md](05-brand-loyalty-tribe.md) | เผ่าของแบรนด์ — ทำไมลูกค้าบางคนถึงภักดีจนยอมปกป้องคุณ | ธุรกิจ · แบรนด์ | 14 นาที |

แต่ละบทความมี **รูปปก 1 + รูป section 6 = 7 รูป** → รวมทั้งชุด **35 รูป**

---

## ทิศทางศิลป์รวม (Art Direction)

ใช้โทนเดียวกันทั้งชุดเพื่อให้รูปดูเป็นซีรีส์เดียวกันและตรงกับแบรนด์:

> **Global style:** Cinematic 3D editorial hero render. Warm parchment + deep **emerald** with brushed-**gold** accents. Recurring motif: organic tree-**roots** (often glowing, often merging with circuitry/people). Dramatic rim lighting, shallow depth of field, subtle film grain. Aspect **16:9**. **No lettering, no numbers, no real brand logos, no watermark.**

**ทุก prompt ในไฟล์บทความถูกเขียนแบบละเอียด (image brief)** เพื่อไม่ให้ AI ออกมาเป็นแค่พื้นหลังเปล่าๆ แต่ละ prompt ระบุครบ:

1. **Hero subject + action** ที่ชัดเจน (มีตัวละคร/วัตถุเด่นในเฟรม)
2. **Foreground / midground / background** แยกชั้นความลึก
3. **Camera + lens** (เช่น 35mm, macro, shallow depth of field)
4. **Lighting** (warm brushed-gold rim light over deep-emerald ambient, volumetric)
5. **Render style** (octane / 3D editorial, premium magazine aesthetic)
6. **Mood + texture** (intricate detail, subtle film grain)
7. **Negative space** เว้นที่ว่างไว้วางหัวข้อภาษาไทยทับ
8. **Negatives** — no lettering / no watermark (และ no numbers สำหรับบทความราคา) เพราะ AI มักสร้างตัวอักษรเพี้ยน

> เคล็ดลับ: ถ้าใช้ Midjourney เพิ่ม `--ar 16:9 --style raw` ท้าย prompt; ถ้าต้องการคนเอเชีย/ไทยให้ระบุ "Thai/Southeast Asian" ในส่วน subject

---

## โครงสร้างไฟล์รูปที่ต้องสร้าง

วางไฟล์ทั้งหมดไว้ที่ `images/articles/` (ถ้านำขึ้นเว็บ คือ `web/images/articles/`)

```
images/articles/
├── art1-cover.png   art1-s1.png … art1-s6.png   (AI & การตลาด)
├── art2-cover.png   art2-s1.png … art2-s6.png   (Attention Economy)
├── art3-cover.png   art3-s1.png … art3-s6.png   (Pricing)
├── art4-cover.png   art4-s1.png … art4-s6.png   (Hook / คลิปสั้น)
└── art5-cover.png   art5-s1.png … art5-s6.png   (Brand Tribe)
```

> Prompt เต็มของแต่ละรูปอยู่ใต้จุดวางรูปในไฟล์บทความแต่ละเล่ม (บล็อก 🎨 **AI Prompt**) — เปิดไฟล์ .md แล้วคัดลอกไปใช้ได้เลย

---

## หมายเหตุการนำขึ้นเว็บ (ขั้นต่อไป — ยังไม่ทำ)

- ไฟล์เป็น `.md` ตามที่ขอ ยังไม่ได้แปลงเป็น HTML/ขึ้นเว็บ
- ถ้าต้องการ สามารถสร้างหน้า `/articles` (ลิสต์บทความ) + เทมเพลตหน้าอ่านบทความ ให้เข้าธีมเดียวกับ Home ใหม่ (Emerald/Gold, mono CI, dark mode) แล้ว build เป็น HTML ลง `web/`
- โครงสร้าง frontmatter (title, slug, category, reading_time, excerpt, art_direction) เตรียมไว้พร้อมสำหรับ generator แล้ว
