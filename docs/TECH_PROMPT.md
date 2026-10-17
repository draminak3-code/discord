# البرومبت التقني الهندسي: بناء نسخة متطابقة من Discord (Discord Clone)

> **وثيقة مرجعية شاملة** — تترجم متطلبات "من البرومبت التقني إلى البيئة التشغيلية" إلى مواصفات
> هندسية دقيقة، ثم إلى كود تشغيلي فعلي في هذا المستودع (`backend/`, `frontend/`, `docker-compose.yml`).

---

## 1. بنية التطبيق الهجينة: REST + WebSocket

### 1.1 المبدأ العام
نموذج هجين يجمع بين:
- **واجهة RESTful** للعمليات غير المتزامنة وبدون حالة (stateless): التسجيل/الدخول، ملفات المستخدمين،
  إنشاء/تعديل السيرفرات والقنوات، إدارة الأدوار، علاقات الأصدقاء، وجلب السجل التاريخي للرسائل.
- **خادم WebSocket** لاتصالات ثنائية الاتجاه لحظية بعد ترقية HTTP (`Upgrade: websocket`).

| المكون | المسؤولية | التقنية في هذا المشروع |
|---|---|---|
| REST API | إدارة حالة التطبيق،读写 قاعدة البيانات حصريًا | Node.js + Express (`backend/src/rest`) |
| WebSocket Gateway | توزيع الأحداث اللحظية فقط (لا يلمس قاعدة البيانات) | مكتبة `ws` (`backend/src/gateway`) |
| Pub/Sub | تمرير الرسائل بين عدة خوادم WebSocket | Redis Pub/Sub (`backend/src/pubsub`) |
| إدارة الاتصال | Hello/HB/ACK، إعادة تشغيل الجلسة، Reconnect تصاعدي | Opcodes مطابقة لبروتوكول Discord |
| الأمان | JWT عبر سلسلة الاستعلام + Rate Limits | `?token=` عند الترقية، رؤوس `X-RateLimit-*` |

### 1.2 أمثلة على نقاط REST
```
POST /api/auth/register            تسجيل مستخدم جديد (bcrypt)
POST /api/auth/login               → { token, user }
GET  /api/channels/{id}/messages?limit=100   أحدث 100 رسالة من السجل
POST /api/channels                 إنشاء قناة (المراقبة → التخزين → استجابة ناجحة)
```

### 1.3 بروتوكول WebSocket (Opcodes مطابقة لديسكورد)
**من العميل إلى الخادم (Client → Gateway):**
| Opcode | الاسم | الحمولة (Payload) |
|---|---|---|
| 0 | DISPATCH | حدث موزَّع (استقبال فقط نظريًا) |
| 1 | HEARTBEAT | `{ seq, session_id }` |
| 2 | IDENTIFY | `{ token, intents, properties }` |
| 3 | PRESENCE_UPDATE | `{ status, activities }` |
| 4 | VOICE_STATE_UPDATE | `{ guild_id, channel_id, self_mute, self_deaf }` |
| 6 | RESUME | `{ token, session_id, seq }` |
| 7 | RECONNECT | طلب إعادة اتصال مخطط |
| 11 | HEARTBEAT_ACK | (إقرار من الخادم) |

**من الخادم إلى العميل (Gateway → Client):**
| Opcode | الاسم | الوصف |
|---|---|---|
| 0 | DISPATCH | `MESSAGE_CREATE`, `TYPING_START`, `PRESENCE_UPDATE`, ... |
| 10 | HELLO | `{ heartbeat_interval: 41250 }` — يُرسل فور الاتصال |
| 11 | HEARTBEAT_ACK | إقرار بالنقرة القلبية |
| 7 | RECONNECT | أبلغ العميل ببدء عملية reconnect |

### 1.4 دورة حياة الاتصال (يجب تنفيذها حرفيًا)
1. **الاتصال**: `wss://api.example.com/ws?token=<JWT>` — الخادم يتحقق من الرمز **قبل** قبول الترقية.
2. **HELLO (op10)**: يرسل الخادم `heartbeat_interval`.
3. **IDENTIFY (op2)** أو **RESUME (op6)**: مع `session_id` و `seq` آخر تسلسل معروف لاستعادة الأحداث الفائتة.
4. **HEARTBEAT (op1)** دوري بنفس الفترة؛ إذا لم يصل **ACK (op11)** ضمن النافذة → إغلاق وإعادة بناء
   (كشف الانقطاعات الصامتة خلف الجدران النارية).
5. **إعادة اتصال تلقائي** باستراتيجية Backoff تصاعدي (exponential + jitter) لتجنب الضغط على الخادم.
6. **مؤقت بطيء (op10 latency)**: ينتظر العميل ACK أول نبضة قبل إرسال أحداث حساسة للترتيب.

### 1.5 التوزيع عبر Pub/Sub
- خادم WS **لا يقرأ/يكتب قاعدة البيانات إطلاقًا**؛ هو مجرد ناقل للأحداث المولَّدة من REST بعد الحفظ.
- كل خادم REST ينشر الحدث بعد الحفظ على قناة Redis مثل `channel:<channel_id>` أو `guild:<guild_id>`.
- كل خادم WS مشترك في القنوات ذات الصلة ويعيد توزيعها على عملائه المتصلين به.
- هذا يفكك الاعتماد المتبادل بين الخوادم ويجعل النظام قابلًا للتوسع أفقيًا.

### 1.6 الأمان والـ Rate Limiting
- JWT يمرر كمعامل `?token=` في طلب الترقية (لا يمكن استخدام رؤوس HTTP مع WS مباشرة).
- حد عالمي: **50 طلب/ثانية للبوت** + قيود على مستوى المسار.
- العميل يجب أن يقرأ `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After` ويدير سرعته
  تلقائيًا لتجنب أخطاء **429**.

---

## 2. بنية Persistence متعددة المخازن

فلسفة ديسكورد: **كل نوع بيانات يخزَّن في المخزن الأنسب لنمط الوصول والحجم**.

| نوع البيانات | المخزن المقترح | السبب | التنفيذ في هذا المشروع |
|---|---|---|---|
| الملفات التعريفية والهيكل التنظيمي (مستخدمون، سيرفرات، قنوات، أدوار، صلاحيات) | **PostgreSQL** | اتساق ACID قوي وعلاقات معاملاتية | جداول كاملة في `backend/src/db/schema.sql` |
| سجل الرسائل (كتابات هائلة، قراءة زمنية) | **ScyllaDB / Cassandra** (أو MinIO AIStor كخيار مفتوح) | تعامل مع الكتابات المترامية وزمن وصول منخفض | جدول Messages مصنف بـ `channel_id` + `timestamp` (موضح أدناه)، مع PostgreSQL كطبقة تنفيذ مبسطة قابلة للتشغيل |
| البيانات المؤقتة (حالة المتصلين، مؤشر الكتابة، مؤشرات القراءة، عدادات عدم القراءة) | **Redis** | سرعة فائقة، لا حاجة للديمومة؛ تُعاد بنيتها من اتصالات WS النشطة | Hashes/Sets/ZSets في `backend/src/cache` |
| الوسائط (صور/فيديو/مستندات) | **MinIO (S3-compatible)** | فصل تدفق الملفات عن خوادم الرسائل؛ روابط مباشرة | رفع مباشر عبر presigned URL ثم إرسال `file_id` داخل نص الرسالة |
| المعرفات | **Snowflake IDs** (Twitter-style) | معرفات فريدة مرتبة زمنيًا موزعة | `backend/src/lib/snowflake.js` |

### 2.1 PostgreSQL — الجداول والفهارس
جداول منفصلة: `users`, `guilds`, `channels`, `roles`, `member_roles`, `messages`, `reactions`,
`attachments`, `read_receipts`, `friendships`, `invites`.
- **فهارس على كل المفاتيح الأجنبية**: `messages.channel_id`, `member_roles.user_id`, ...
- المعرفات الرئيسية أرقام Snowflake (BIGINT).
- تعديل اسم سيرفر أو إنشاء دور يتم **ضمن معاملة (TRANSACTION) آمنة**.

### 2.2 طبقة الرسائل عالية الحجم (نمط ScyllaDB/Cassandra)
```sql
CREATE TABLE messages (
    channel_id  bigint,
    id          bigint,          -- snowflake
    author_id   bigint,
    content     text,
    timestamp   bigint,          -- ms since epoch
    PRIMARY KEY ((channel_id), timestamp, id)
) WITH CLUSTERING ORDER BY (timestamp DESC, id DESC);
```
- كل رسالة كيان مستقل مفهرس بـ `id` + `channel_id` + `timestamp`.
- **تجزئة حسب `channel_id`** لتجنب "المقاطع الساخنة" (hot partitions) في القنوات النشطة.

### 2.3 Redis — structures
- الحالة: `SET presence:online` + `HASH presence:user:<uid>` → `{status, game}`
- مؤشر الكتابة: `ZSET typing:<channel_id>` (members بانتهاء TTL ~10s)
- مؤشر القراءة: `HASH reads:<user_id>` حقل `channel_id → last_message_id`
- عدادات غير مقروءة: `HASH badges:<user_id>`

### 2.4 تدفق رفع الوسائط (لا يمر عبر خادم الرسائل أبدًا)
```
Client ──POST /api/uploads──▶ REST API ──presigned PUT──▶ MinIO
Client ◀── { file_id, url } ──                            │
Client ──رسالة نصية تحوي file_id──▶ REST ─▶ DB ─▶ PubSub ─▶ WS ─▶ بقية العملاء
العملاء الآخرون يستخدمون file_id للحصول على الرابط المباشر من MinIO.
```
خدمة فرعية للصور المصغرة: worker مستقل بمكتبة `sharp` يراقب التخزين وينتج نسخًا مصغرة.

---

## 3. تصميم واجهة المستخدم وتجربة الاستخدام (UI/UX)

### 3.1 نظام الألوان (Dark-first)
| العنصر | القيمة |
|---|---|
| الخلفية الرئيسية (منطقة الدردشة) | `#313338` |
| شريط القنوات الثانوي | `#2b2d31` |
| الخلفية العميقة (Server Rail) | `#1e1f22` |
| Blurple (العلامة التجارية) | `#5865F2` |
| نص رئيسي | `#dbdee1` |
| نص ثانوي/مبهم | `#949ba4` |
| Online | `#23a55a` |
| Idle | `#f0b232` |
| Do-Not-Disturb | `#f23f43` |
| Offline / Invisible | `#80848e` |

### 3.2 الخطوط
- رئيسي: `"gg sans", "Noto Sans", "Helvetica Neue", sans-serif`
- كود: `"gg mono", Consolas, monospace`

### 3.3 الهيكل ثلاثي الأعمدة الثابت
| العمود | العرض | المحتوى |
|---|---|---|
| Server Rail | **72px** | أيقونة التطبيق + أيقونات السيرفرات + زر إنشاء سيرفر |
| Channel Sidebar | **240px** | قائمة القنوات، أعضاء، الأدوار |
| Chat Column | متغيّر (حد أدنى **380px**) | رأس القناة، الرسائل، صندوق الإدخال |

- أيقونات السيرفرات/القنوات: مربعات بحواف `16px` تتحول لدوائر عند التأشير (hover).

### 3.4 مواصفات مكوّن الرسالة
| المواصفة | القيمة |
|---|---|
| حجم خط الرسالة | 16px |
| ارتفاع السطر | 22px (1.375) |
| اسم المستخدم | 16px متوسط الوزن |
| وقت الرسالة | 12px بلون `#949ba4` |
| مساحة يسار الرسالة (Avatar gutter) | 48px |
| صورة الملف الشخصي | 40px قطرية |
| عند hover على الرسالة | خلفية شبه شفافة + حدود دائرية |
| حلقة المتحدث في القناة الصوتية | خضراء `#23a55a` (10x10px) |
| أيقونة كتم الصوت | 16px تتحول إلى `#f23f43` عند التفعيل |
| أيقونة القناة الصوتية | أيقونة مكبر صوت |

### 3.5 التفاعلات المنطقية
- **Threads**: نقاشات داخل قناة تعرض كنافذة جانبية (side panel) منفصلة.
- **Reactions**: إيموجي أسفل الرسالة مع عدّاد، تبديل بالنقر.
- **Replies**: اقتباس مقطع صغير من الرسالة الأصلية فوق الرسالة الجديدة.
- **الإطار**: React + Vite، وأنماط CSS تتبع قيم Tailwind-equivalent أعلاه.
- **الهيكلة**: Feature-based architecture (حزم المكونات والمنطق لكل ميزة معًا).
- **UX**: تحديث تلقائي للشاشة عند وصول رسائل جديدة عبر WS، حالات انقطاع الإنترنت
  (banner "Connecting…" + backoff)، وقابلية وصول (ARIA، تنقل بلوحة المفاتيح).

---

## 4. الميزات المتقدمة: البوتات/Webhooks والصوت والفيديو

### 4.1 البوتات مقابل Webhooks
| | البوت | الـ Webhook |
|---|---|---|
| الاتصال | WebSocket مستمر عبر البوابة (IDENTIFY برمز Bot) | نقطة نهاية HTTP واحدة الاتجاه |
| الاتجاه | ثنائي (يستمع ويتفاعل) | أحادي (POST من أي خادم خارجي) |
| الاستخدام | أوامر، تفاعلات، إدارة | إشعارات CI/CD، RSS |

### 4.2 أنواع الأوامر والعناصر التفاعلية
- **Slash Commands** (`/ping`)، **User Commands**، **Message Commands**.
- عناصر تفاعلية: أزرار، قوائم اختيار ثابتة، ونوافذ **Modals** لجمع بيانات المستخدم.
- **قاعدة الـ 3 ثوانٍ**: يجب إرسال استجابة أولية (ACK/Deferred) خلال 3s، تُرجع Interaction Token
  يُستخدم للردود اللاحقة Follow-up.

### 4.3 التحقق الأمني
- Webhooks: تحقق من رؤوس `X-Signature-Ed25519` + `X-Signature-Timestamp` (HMAC/Ed25519)
  لضمان مصدر الطلب ومنع الانتحال.
- البوتات: رمز Bot عبر سلسلة الاستعلام عند ترقية WS، مع تحقق الخادم قبل القبول.

### 4.4 الصوت/الفيديو: WebRTC + SFU
1. **الإشارة (Signaling)** عبر خادم WebSocket: عرض/إجابة SDP وتبادل ICE Candidates.
2. نموذج P2P ينهار في المكالمات الجماعية (10 أشخاص = 9 تدفقات لكل مستخدم).
3. الحل: **SFU** — كل مستخدم يرسل تدفقًا واحدًا للخادم الوسيط الذي ينسخه للمستمعين.
   - التوصية: **Mediasoup** (C++/Node منخفضة المستوى) أو **LiveKit** (Go جاهزة).
   - تُدمج كخدمة `mediasoup-worker` إضافية في `docker-compose.yml`.
4. **E2EE**: تشفير DTLS-SRTP + تبادل مفاتيح Diffie-Hellman؛ إضافة "Voice Privacy Code"
   لمقارنة رمز بصري بين المشاركين والتأكد من عدم وجود طرف ثالث.
5. مشاركة الشاشة: تدفق `getDisplayMedia` إضافي عبر نفس قناة WebRTC.

---

## 5. نظام الصلاحيات: Permissions Bitfield

### 5.1 التمثيل
كل صلاحية = بت في عدد صحيح (حتى 53-bit) مخزن في عمود `permissions BIGINT`:
`value = 2^n`. الجمع بين صلاحيات الدور يتم بـ **OR bitwise (|)**. الفحص بـ **AND bitwise (&)**:
```js
hasPermission = (member_permissions & SEND_MESSAGES) === SEND_MESSAGES; // 2048
```

### 5.2 جدول الصلاحيات المرجعي (مقتطف مطابق للمواصفات)
| الصلاحية | Value | Hex | التأثير الضمني |
|---|---|---|---|
| CREATE_INSTANT_INVITE | 1 | 0x00000001 | — |
| KICK_MEMBERS | 2 | 0x00000002 | — |
| BAN_MEMBERS | 4 | 0x00000004 | — |
| ADMINISTRATOR | 8 | 0x00000008 | يتجاوز كل شيء |
| MANAGE_CHANNELS | 16 | 0x00000010 | — |
| MANAGE_GUILD | 32 | 0x00000020 | — |
| READ_MESSAGES (VIEW_CHANNEL) | 512 | 0x00000200 | بوابة كل الصلاحيات الأخرى |
| SEND_MESSAGES | 1024 | 0x00000400 | يلغي MENTION_EVERYONE, SEND_TTS_MESSAGES, ATTACH_FILES, EMBED_LINKS |
| CONNECT | 1048576 | 0x00100000 | يتطلب MANAGE_CHANNEL للتحكم |
| SPEAK | 2097152 | 0x00200000 | — |
| MUTE_MEMBERS | 4194304 | 0x00400000 | — |
| DEAFEN_MEMBERS | 8388608 | 0x00800000 | — |
| MOVE_MEMBERS | 16777216 | 0x01000000 | — |
| MANAGE_ROLES | 268435456 | 0x10000000 | — |

### 5.3 خوارزمية التقييم (بالترتيب الصارم — Deny يتجاوز Allow في كل مرحلة)
```
1. ADMINISTRATOR؟ → نعم: كل الصلاحيات مسموحة.
2. @everyone role permissions (أساس الدور الافتراضي للسيرفر).
3. تطبيق channel @everyone overwrite:  allowed |= oa; denied |= od  (deny أولاً).
4. OR جمع صلاحيات كل أدوار العضو.
5. تطبيق channel role overwrites لكل دور (deny ثم allow).
6. تطبيق Member-specific overwrite (الأعلى تأثيرًا والأخير دائمًا).
7. فحص VIEW_CHANNEL: رفضه = رفض ضمني لكل صلاحيات القناة الأخرى.
8. مثال: دور A يسمح SEND_MESSAGES ودور B يمنعه → ممنوع.
   لكن دور C (أيضًا) يسمح بعد معالجة deny → مسموح (ترتيب apply مهم).
```

### 5.4 هرمية الأدوار
لكل دور `position` (رقم صحيح؛ الأعلى في القائمة = موقع أقل/أعلى رتبة).
**قاعدة**: لا يستطيع مستخدم أو بوت إدارة دور موقعه **أعلى أو يساوي** موقع أعلى أدواره —
يمنع تعيين الذات لأدوار أعلى. تُطبق في REST API عند تعديل الأدوار.

---

## 6. استراتيجية الاستضافة والنشر: Docker + Nginx

### 6.1 الحقيقة حول Qwen Code
Qwen Code مساعد برمجة بالذكاء الاصطناعي (CLI/IDE extension بنظام اشتراك وحدود زمنية) —
**ليست منصة استضافة ولا تصلح كخادم دائم يستضيف اتصالات WebSocket**. لذلك تتحول الاستراتيجية إلى:
استخدامها كأداة توليد الكود/الدليل، والنشر الفعلي على بيئة حاويات حقيقية.

### 6.2 الحاويات (منفذة في هذا المستودع)
| الخدمة | الصورة | المنفذ |
|---|---|---|
| frontend | nginx:alpine (بعد build من node:20) | 80 (داخلي 3000) |
| backend (REST+WS) | node:20-alpine | 3000 |
| database | postgres:16-alpine | 5432 |
| cache | redis:7-alpine | 6379 |
| media-storage | minio/minio | 9000/9001 |
| reverse-proxy | nginx:alpine | 80/443 |

- شبكة Docker داخلية مخصصة `discord-net` — تواصل بالأسماء DNS: `http://backend:3000`.
- `depends_on` + `healthcheck` لترتيب الإقلاع، وvolumes لبيانات PG/MinIO.

### 6.3 Nginx كReverse Proxy
- `proxy_pass` توجيه `/api/*` و`/ws` إلى backend مع ترحيل WebSocket:
  `proxy_http_version 1.1; Upgrade/Connection headers; proxy_read_timeout 3600s;`
- الملفات الثابتة للواجهة تخدم مباشرة من حاوية frontend.
- SSL/TLS مجاني عبر Let's Encrypt باستخدام `jrcs/letsencrypt-nginx-proxy-companion`.
- ضبط `resolver 127.0.0.11 valid=10s;` (DNS الداخلي في Docker) لتجنب تثبيت أسماء المضيفين
  الديناميكية (502 بعد إعادة إنشاء الحاويات).

### 6.4 الأمان والتشغيل المستمر
- TLS 1.2+ لكل الاتصالات الخارجية.
- الأسرار عبر متغيرات بيئة Docker (`.env` خارج Git) — لا مفاتيح في الكود.
- Rate limiting على REST وWS معًا (انظر §1.6).
- في Qwen Code: ضبط `security.allowedHttpHookUrls` للسماح بالاتصال بالخدمات الخارجية فقط الموثوقة.
- **CI/CD**: GitHub Actions يبني الصور → يدفعها لمستودع الصور → على الخادم:
  `docker compose pull && docker compose up -d`.

---

## 7. خريطة تنفيذ الكود في هذا المستودع

```
/workspace
├── docker-compose.yml              # البيئة الموزعة الكاملة (6 خدمات + شبكة + volumes)
├── .env.example                    # متغيرات البيئة (JWT secret, DB creds, MinIO keys)
├── nginx/nginx.conf                # Reverse proxy + ترحيل WS + resolver + limits
├── backend/
│   ├── Dockerfile                  # node:20-alpine
│   ├── package.json
│   └── src/
│       ├── index.js                # نقطة الدخول: Express + ws + pub/sub + healthcheck
│       ├── lib/snowflake.js        # مولّد معرفات Snowflake
│       ├── lib/jwt.js              # توقيع/تحقق JWT
│       ├── config/permissions.js   # Bitfields كاملة + خوارزمية التقييم §5
│       ├── db/schema.sql           # مخطط PostgreSQL الكامل + الفهارس
│       ├── db/index.js             # تجميعة ذاكرة متوافقة مع SQL (وضع التطوير)
│       ├── cache/redis.js          # Presence/Typing/Read-receipts + Pub/Sub
│       ├── rest/*.js               # auth, users, guilds, channels, messages, roles, invites, webhooks, uploads
│       └── gateway/server.js       # WS Gateway: Opcodes 0-11، HB/ACK، Resume، Backoff
├── frontend/
│   ├── Dockerfile                  # multi-stage: node build → nginx serve
│   ├── package.json / vite.config.js / index.html
│   └── src/
│       ├── styles/discord.css      # نظام الألوان والخطوط والمقاسات §3 حرفيًا
│       ├── App.jsx                 # الهيكل ثلاثي الأعمدة + هجرة WS + Backoff
│       └── features/               # feature-based: auth, guilds, channels, chat, members
└── docs/TECH_PROMPT.md             # هذه الوثيقة
```

**وضع التطوير بدون Docker**: `npm install && npm start` في `backend/` يشغّل خادمًا كاملاً
بقاعدة بيانات ذاكرة متوافقة مع نفس المخطط، وRedis محايد (fallback)، وكل البروتوكولات كما هي.
