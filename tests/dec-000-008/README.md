# اختبارات التحقق من القرارات DEC-000 إلى DEC-007

بيانات اصطناعية فقط. لا تتصل بقاعدة الإنتاج ولا بأي خدمة حقيقية.

| الملف | ما يختبره |
|---|---|
| `server.test.mjs` | الخادم على PostgreSQL في الذاكرة (`@electric-sql/pglite`) ورموز Firebase موقّعة محلياً: DEC-000، DEC-002 (خادم)، DEC-003، DEC-007 |
| `client.test.js` | الواجهة في Chromium (Playwright) مع خادم API وهمي: DEC-002، DEC-004، DEC-005، DEC-006 |
| `fake-neon.mjs` | بديل `@neondatabase/serverless` يوجّه الاستعلامات إلى PGlite |

النتيجة عند الإضافة (2026-11-27): الخادم 16/16، الواجهة 14/14. على نسخة `main` السابقة: الخادم فشل في اختبارات DEC-000 وDEC-002، والواجهة 3/14.

التشغيل اليدوي (خارج المستودع، في مجلد مؤقت):
1. انسخ `lib/` و`worker.js` إلى `app/`، وضع `fake-neon.mjs` مكان `node_modules/@neondatabase/serverless/index.js` (مع `package.json` نوعه `module`)، وثبّت `@electric-sql/pglite`، ثم `node server.test.mjs`.
2. `node client.test.js /path/to/public` (يتطلب `playwright`).
