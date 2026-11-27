# دليل استعادة البيانات
**مرتبط بالقرارين DEC-001 وDEC-003**

## 1. قبل أي نشر يمسّ البيانات (DEC-001)
| الخطوة | الإجراء |
|---|---|
| 1 | على كل جهاز تستخدم عليه التطبيق: «الإعدادات» ← «تصدير نسخة احتياطية (JSON)»، واحفظ الملف خارج الجهاز (بريد، iCloud، Google Drive) باسم يتضمن التاريخ واسم الجهاز. |
| 2 | في لوحة Neon: افتح المشروع ← Settings أو Backup & Restore، وسجّل مدة الاستعادة لنقطة زمنية (History retention / PITR). |
| 3 | (اختياري موصى به) أنشئ فرعاً (Branch) من قاعدة الإنتاج باسم `before-dec-000-008` كنقطة رجوع. |

## 2. استعادة نسخة سابقة من سجل النسخ (DEC-003)
بعد النشر، كل حفظ يحفظ النسخة السابقة في جدول `app_state_history` (آخر 50 نسخة لكل محفظة).

من محرر SQL في Neon:

1) اعرض النسخ المتاحة لمحفظتك (مفتاح المحفظة يبدأ بـ `fb:` ثم معرّف حسابك):
```sql
SELECT id, updated_at, archived_at, jsonb_array_length(state->'units') AS units
FROM app_state_history
WHERE user_key = 'fb:<معرّف_حسابك>'
ORDER BY id DESC
LIMIT 20;
```

2) بعد اختيار رقم النسخة (`id`) المطلوبة، احفظ النسخة الحالية أولاً ثم استعد:
```sql
INSERT INTO app_state_history (user_key, state, updated_at)
SELECT user_key, state, updated_at FROM app_state WHERE user_key = 'fb:<معرّف_حسابك>';

UPDATE app_state
SET state = (SELECT state FROM app_state_history WHERE id = <رقم_النسخة>),
    updated_at = now()
WHERE user_key = 'fb:<معرّف_حسابك>';
```

3) على كل جهاز: أغلق التطبيق وافتحه. سيظهر حوار تعارض إن كان على الجهاز تعديل غير مرفوع؛ اختر «نسخة السحابة».

> جُرّبت هذه الاستعادة على قاعدة اختبار في الذاكرة (`tests/dec-000-008/server.test.mjs`)، لا على الإنتاج.

## 3. الاستعادة من ملف JSON مُصدَّر
«الإعدادات» ← «استيراد نسخة احتياطية» على جهاز واحد، ثم انتظر «محفوظ سحابياً». يكتب الاستيراد فوق المحفظة الحالية، لكن النسخة السابقة تبقى في `app_state_history`.
