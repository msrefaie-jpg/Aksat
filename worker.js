// نقطة دخول Cloudflare Worker لتطبيق «أقساط»
// يخدم الملفات الثابتة من مجلد public (عبر ربط ASSETS) ويعالج مسارات /api.
import { handleState, handleRate, handleInspect, handlePortfolios, handleShares, handleReport, handlePush, runDailyReminders } from './lib/api.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === '/api/state') return handleState(request, env);
    if (p === '/api/portfolios') return handlePortfolios(request, env);
    if (p === '/api/shares') return handleShares(request, env);
    if (p === '/api/report') return handleReport(request, env);
    if (p.startsWith('/api/push/')) return handlePush(request, env);
    if (p === '/api/rate') return handleRate(request, env);
    if (p === '/api/inspect') return handleInspect(request, env);
    // أي مسار آخر → الملفات الثابتة
    return env.ASSETS.fetch(request);
  },

  // مُشغّل مجدول يومي (Cron) لإرسال تذكيرات الأقساط
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyReminders(env));
  },
};
