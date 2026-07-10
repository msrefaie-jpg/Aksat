-- مخطط قاعدة بيانات تطبيق «أقساط» على Neon (PostgreSQL)
-- يُنشأ تلقائياً عند أول استدعاء للدالة، ويمكن تشغيله يدوياً من محرر Neon SQL.
--
-- نموذج التخزين: مستند JSON واحد لكل «رمز حساب» (user_key).
-- هذا يبقي المزامنة بين الأجهزة بسيطة وموثوقة، والحسابات كلها تتم في الواجهة.

CREATE TABLE IF NOT EXISTS app_state (
  user_key    TEXT PRIMARY KEY,
  state       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (اختياري) سجل لأسعار الصرف المجلوبة تلقائياً للتخزين المؤقت
CREATE TABLE IF NOT EXISTS fx_cache (
  pair        TEXT PRIMARY KEY,     -- مثال: 'USD_BASE'
  rate        NUMERIC,              -- جنيه لكل ريال
  usd_rate    NUMERIC,              -- جنيه لكل دولار
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- لقطات تقارير للقراءة فقط تُشارَك برابط عام (تنتهي صلاحيتها بعد ٩٠ يوماً)
CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,     -- معرّف عشوائي يُستخدم في الرابط العام
  owner_uid   TEXT NOT NULL,        -- منشئ التقرير (للإلغاء)
  data        JSONB NOT NULL,       -- لقطة التقرير المعروضة
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ
);
