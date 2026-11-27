# الاجتماع 001 — تقرير العضو 15: خبير امتثال متجر Apple

**النطاق:** جاهزية نشر غلاف `native/` (Capacitor 8.6.3) على App Store.
**المصادر الرسمية (اطّلاع 2026-11-27):**
- App Store Review Guidelines: https://developer.apple.com/app-store/review/guidelines/ — قُرئ أول 100 ألف حرف (تشمل البنود المذكورة هنا)؛ الصفحة لا تعرض تاريخ تحديث فلم أتحقق من رقم الإصدار.
- Offering account deletion in your app: https://developer.apple.com/support/offering-account-deletion-in-your-app/ — تمت قراءتها.
- Privacy manifest files: https://developer.apple.com/documentation/bundleresources/privacy-manifest-files — **تعذّرت قراءة المحتوى** (صفحة تعتمد JavaScript)؛ لا أبني عليها نصاً حرفياً.

## 1. الملخص التنفيذي
التطبيق **غير جاهز للنشر** بوضعه الحالي. يوجد مانعان صريحان: **لا يوجد حذف حساب داخل التطبيق** (5.1.1(v)) و**لا توجد سياسة خصوصية** لا في التطبيق ولا في المستودع (5.1.1(i)). ويوجد خطر رفض مرتفع جداً بموجب 4.2 لأن الغلاف لا يزيد عن `WKWebView` يحمّل موقعاً بعيداً دون أي ميزة أصلية، مع تعطّل إشعارات Push داخله باعتراف `native/README.md`. تسجيل الدخول لا يستلزم Sign in with Apple، والمحتوى المالي لا يقع تحت قواعد الإقراض. الأيقونات وشاشة البداية سليمة من حيث الشكل.

## 2. النتائج

### مانع للنشر
| # | النتيجة | التصنيف | الدليل |
|---|---|---|---|
| B1 | لا يوجد حذف حساب. قسم الحساب ينتهي بزر «تسجيل الخروج» فقط، ولا يوجد مسار API للحذف. | حقيقة | `public/index.html:483-493`؛ مسارات `worker.js:9-15` (state, portfolios, shares, report, push, rate, inspect)؛ لا استدعاء لـ `currentUser.delete` في `public/app.js` (الحذف الوحيد للمشاركات `app.js:1825,1835` والتقارير `app.js:2380`). إنشاء الحساب موجود `app.js:1935`. |
| B2 | لا توجد سياسة خصوصية ولا رابط لها. البحث عن privacy/خصوصية/سياسة في `public/` لا يعطي نتيجة، والقسم الوحيد هو `README.md:54`. | حقيقة | 5.1.1(i) يشترط رابطاً «within the app in an easily accessible manner» وفي حقل App Store Connect. |
| B3 | لا يوجد حساب Apple Developer مدفوع. الدليل يقول إن الحساب المجاني «لا يمكن نشره على المتجر». | حقيقة (توثيق) | `native/README.md` قسم «قيود الحساب المجاني»؛ `CODE_SIGN_STYLE = Automatic` بلا `DEVELOPMENT_TEAM` في `project.pbxproj:302,324`. |

### خطر رفض
| # | النتيجة | التصنيف | الدليل |
|---|---|---|---|
| R1 | **4.2 Minimum Functionality:** الغلاف يحمّل `server.url` بعيداً ولا يحتوي أي كود أصلي غير `CAPBridgeViewController` الافتراضي وإضافة `StatusBar`. نص البند: «elevate it beyond a repackaged website». و4.2.2 يمنع «web clippings». | حقيقة (الإعداد) + استنتاج (الرفض مرجّح) | `native/capacitor.config.json:5-9`؛ `SceneDelegate.swift`؛ `package.json` (ثلاث حزم فقط)؛ والدافع الموثّق للغلاف هو رسم الواجهة في عمود الساعة فقط `native/README.md`. |
| R2 | **2.5.2 / 2.3.1:** كل الميزات تأتي من الخادم، و«أي تحديث تنشره على `main` يظهر فيه دون إعادة بناء». هذا يغيّر وظائف التطبيق دون مراجعة. أقدّر أن الخطر الفعلي متوسط، لأن تنفيذ كود الويب عبر WebKit مقبول عموماً، لكنه يقوّي حجة 4.2. | حقيقة + استنتاج | `native/README.md` السطر الثاني؛ Firebase SDK يُحمَّل من `gstatic` `public/index.html:586-587`. |
| R3 | **2.1 App Completeness:** دون شبكة أو عند تعطّل الخادم تظهر صفحة خطأ. Service Worker لا يعمل افتراضياً داخل `WKWebView` (يتطلب `WKAppBoundDomains`، وهو غير موجود في `Info.plist`)، فالعمل دون إنترنت غير مضمون. | حقيقة (غياب المفتاح) + افتراض (سلوك WebKit، لم يُختبر) | `Info.plist` كاملاً؛ `app.js:2415`. |
| R4 | **ميزة معطّلة ظاهرة:** إشعارات Push «لا تعمل داخل التطبيق الأصلي». الصف مخفي عند غياب الدعم، لكن خيار «تنبيهات المتصفح» يبقى ظاهراً. | حقيقة | `native/README.md`؛ `app.js:1089,1151`؛ `index.html:453-460`. |
| R5 | **البصمة/Face ID عبر WebAuthn:** `rp.id = location.hostname` داخل `WKWebView`. تشغيل Passkeys/WebAuthn في WKWebView يتطلب عادةً Associated Domains (`webcredentials`)، ولا يوجد ملف entitlements. استنتاجي أن الميزة ستفشل عند المراجع وتُعرض كزر معطّل، وهو مبرر رفض وفق 2.1. لا يلزم `NSFaceIDUsageDescription` لأن LocalAuthentication غير مستخدم. | حقيقة (الكود) + افتراض (سلوك WKWebView) | `app.js:1336-1360`؛ `index.html:471-476,581`؛ لا توجد `CODE_SIGN_ENTITLEMENTS` في `project.pbxproj`. |
| R6 | **Privacy Manifest:** لا يوجد `PrivacyInfo.xcprivacy` في هدف التطبيق. توجد ملفات Capacitor نفسه في `node_modules/@capacitor/ios/.../PrivacyInfo.xcprivacy`. لم أتمكن من قراءة صفحة Apple لتأكيد هل يكفي ذلك. | حقيقة + معلومة ناقصة | `find` في `native/ios`. |
| R7 | **5.1.1(ix) و3.2.1(viii):** نص 3.2.1(viii): «money management should be submitted by the financial institution». التطبيق متتبّع شخصي للأقساط العقارية لا ينفّذ معاملات. أرجّح أنه لا يعدّ خدمة مالية منظّمة، لكن المراجع قد يسأل. Bundle ID شخصي `com.msrefaie.aksat`. | حقيقة (الوصف) + استنتاج (خطر منخفض إلى متوسط) | `README.md:1-4`؛ `project.pbxproj:312`. |
| R8 | **Privacy Nutrition Label:** يجب إفصاح دقيق عن البريد والاسم ومعرّف المستخدم (Firebase)، وبيانات مالية يدخلها المستخدم (Neon)، وروابط تقارير عامة للقراءة يمكن لأي حامل رابط فتحها. كما تصل طلبات إلى Google Fonts و`open.er-api.com`. | حقيقة | `app.js:2346`؛ `index.html:12-14`؛ `app.js:1190`؛ جداول `lib/auth.js:111-157`. |
| R9 | **حسابات تجريبية للمراجع:** التطبيق يفتح على شاشة دخول إلزامية، فيجب تقديم حساب تجريبي فيه بيانات وهمية في App Review Notes (2.1). | حقيقة (شاشة الدخول `index.html:499`) + متطلب إجرائي | — |

### سليم
- **تسجيل الدخول (4.8):** بريد وكلمة مرور فقط عبر Firebase (`app.js:1935,1940`)، دون أي تسجيل اجتماعي. هذا يندرج تحت الاستثناء «exclusively uses your company's own account setup». **Sign in with Apple غير مطلوب** ما لم يُضف دخول Google أو غيره.
- **المحتوى المالي (3.2.2(ix)):** لا إقراض ولا APR ولا تداول، فقواعد القروض لا تنطبق.
- **الأيقونة:** `AppIcon-512@2x.png` بحجم 1024×1024 بنظام RGB دون قناة alpha، وهذا مقبول. لكن يُستحسن فحصها بصرياً.
- **شاشة البداية:** `LaunchScreen.storyboard` مع `Splash` بحجم 2732×2732، و`UILaunchStoryboardName` موجود.
- **Info.plist:** `CFBundleDisplayName` = «أقساط»، والتوجيهات الأربعة مدعومة على iPad (`TARGETED_DEVICE_FAMILY = 1,2`)، فلقطات شاشة iPad لازمة. لا توجد مفاتيح أذونات، وهذا صحيح لأنه لا كاميرا ولا موقع.
- **الروابط الخارجية:** `allowNavigation` مقصور على النطاق نفسه، ولا روابط شراء خارجية، فلا قضايا 3.1.
- **التشفير:** لا يوجد `ITSAppUsesNonExemptEncryption`. HTTPS فقط، فالإجابة «No» أو الإعفاء في App Store Connect كافية (افتراض قياسي).

## 3. المخاطر
| الخطر | الخطورة |
|---|---|
| رفض 5.1.1(v) لغياب حذف الحساب | حرجة |
| رفض 5.1.1(i) لغياب سياسة الخصوصية | حرجة |
| رفض 4.2 كموقع مُعاد تغليفه | عالية |
| فشل البصمة/Push أمام المراجع (2.1) | عالية |
| تعطّل التطبيق كلياً عند انقطاع الخادم أو الشبكة | متوسطة |
| غياب Privacy Manifest للتطبيق | متوسطة (غير مؤكَّد) |
| تصنيف التطبيق كخدمة مالية منظّمة (5.1.1(ix)) | منخفضة إلى متوسطة |
| إفصاح خاطئ في Nutrition Label (2.3 و5.1.2) | متوسطة |

## 4. التوصيات

**إلزامية قبل الإطلاق**
1. إضافة «حذف الحساب» في قسم الحساب. يجب أن يحذف من الخادم `app_state` و`users` و`shares` و`reports` و`push_subs` و`push_state` المرتبطة بالـ `uid`، ثم يحذف مستخدم Firebase (`currentUser.delete()` مع إعادة مصادقة)، ويوضّح للمستخدم ما يُحذف، مع رسالة تأكيد واحدة فقط.
2. نشر صفحة سياسة خصوصية تغطي البنود الثلاثة في 5.1.1(i): البيانات المجمّعة، والأطراف الثالثة (Firebase/Google، Neon، Cloudflare، Google Fonts، `open.er-api.com`)، والاحتفاظ والحذف. توضع روابطها في شاشة الدخول وقسم الحساب وفي App Store Connect.
3. الاشتراك في Apple Developer Program وتعيين Team.
4. تقديم حساب تجريبي ببيانات وهمية في App Review Notes.

**مهمة قبل الإطلاق**
5. تقليل خطر 4.2 بميزات أصلية حقيقية، مثل الإشعارات المحلية أو Push الأصلية للتذكير بالأقساط عبر `@capacitor/local-notifications` أو `push-notifications`، والقفل عبر Face ID أصلياً (مع `NSFaceIDUsageDescription`). الخيار الثاني أن تُحزم الواجهة محلياً (`webDir` دون `server.url`) وتُستدعى الـ API فقط. هذا ليس إعادة بناء، فـ `webDir: ../public` مضبوط أصلاً.
6. إخفاء ميزتي البصمة (WebAuthn) و«تنبيهات المتصفح» داخل البيئة الأصلية إن لم تعملا، والتحقق من ذلك على جهاز حقيقي.
7. إضافة `PrivacyInfo.xcprivacy` للتطبيق وتعبئة Nutrition Label بدقة، مع ذكر روابط التقارير العامة.
8. معالجة حالة عدم الاتصال بشاشة واضحة بدل صفحة خطأ.

**تحسين اختياري:** إزالة `armv7` من `UIRequiredDeviceCapabilities` واستبدالها بـ `arm64`، وتحميل الخطوط محلياً بدل Google Fonts.
**مؤجلة:** Sign in with Apple يصبح إلزامياً فقط إن أُضيف دخول Google أو أي دخول اجتماعي.

## 5. المعلومات الناقصة
- نوع حساب المطوّر (فرد أم كيان) وأسواق التوزيع (مصر/السعودية).
- نتيجة تشغيل فعلي على جهاز لـ WebAuthn وService Worker داخل `WKWebView`.
- النص الحالي لصفحة Privacy Manifest (تعذّر الوصول)، وهل تكفي ملفات Capacitor المضمّنة.
- تاريخ آخر تحديث لإرشادات المراجعة، إذ لم يظهر في الصفحة.
- هل توجد خطة لإضافة دخول Google لاحقاً.

## 6. درجة الثقة
**عالية (≈85%)** في المانعين B1 وB2، لأن الدليل قاطع من الكود والنص الرسمي مقروء مباشرة. **متوسطة (≈65%)** في 4.2، فقرار المراجع تقديري لكن النمط معروف. **منخفضة إلى متوسطة** في R3 وR5 وR6، لأنها تعتمد على سلوك WebKit وصفحة لم أقرأها.
