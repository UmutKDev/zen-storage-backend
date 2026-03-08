# Premium API Access System

Bu dokuman, NestJS Storage backend'inin Premium API erisim sistemini kapsar. API Key tabanli kimlik dogrulama, tier-bazli rate limiting, HMAC imzalama, webhook sistemi, kullanim takibi ve MongoDB loglama altyapisini icerir.

---

## Icindekiler

- [Hizli Baslangiç](#hizli-baslangiç)
- [Kimlik Dogrulama](#kimlik-dogrulama)
- [HMAC Imzalama](#hmac-imzalama)
- [Rate Limiting ve Kota](#rate-limiting-ve-kota)
- [Idempotency](#idempotency)
- [Hata Kodlari](#hata-kodlari)
- [Endpoint Referansi](#endpoint-referansi)
  - [Storage](#storage)
  - [Upload](#upload)
  - [Download](#download)
  - [Directories](#directories)
  - [Archive](#archive)
  - [Webhooks](#webhooks)
  - [Usage](#usage)
  - [Notification](#notification)
- [Webhook Sistemi](#webhook-sistemi)
- [Tier Limitleri](#tier-limitleri)
- [MongoDB Loglama](#mongodb-loglama)
- [Audit Log](#audit-log)
- [Ortam Degiskenleri](#ortam-degiskenleri)

---

## Hizli Baslangiç

Tum API endpoint'leri `/Api/v1/` prefix'i altinda yer alir. Her istek iki zorunlu header gerektirir:

```bash
curl -X GET "https://api.example.com/Api/v1/Storage/List?Path=/" \
  -H "x-api-key: pk_live_abc123" \
  -H "x-api-secret: sk_live_xyz789"
```

### Yanit Formati

Tum yanitlar asagidaki formatta doner:

```json
{
  "Result": { ... },
  "Status": {
    "Messages": [],
    "Code": 200,
    "Timestamp": "2026-03-07T12:00:00.000Z",
    "Path": "/Api/v1/Storage/List"
  }
}
```

Dizi yanitlari pagination bilgisi icerir:

```json
{
  "Result": {
    "Options": { "Skip": 0, "Take": 25, "Total": 100 },
    "Items": [ ... ]
  },
  "Status": { ... }
}
```

---

## Kimlik Dogrulama

API erisimi icin API Key ve Secret gereklidir. Bu degerler kullanici hesabindan olusturulur.

### Zorunlu Header'lar

| Header         | Aciklama                                 |
| -------------- | ---------------------------------------- |
| `x-api-key`    | API public key (ornek: `pk_live_abc123`) |
| `x-api-secret` | API secret key (ornek: `sk_live_xyz789`) |

### API Key Scope'lari

Her API key'e atanmis scope'lar endpoint erisimini belirler:

| Scope    | Aciklama                                      |
| -------- | --------------------------------------------- |
| `READ`   | Okuma islemleri (listeleme, arama, indirme)   |
| `WRITE`  | Yazma islemleri (yukleme, tasima, güncelleme) |
| `DELETE` | Silme islemleri                               |
| `ADMIN`  | Yonetim islemleri (webhook CRUD)              |

### API Key Ortamlari

| Ortam  | Aciklama                 |
| ------ | ------------------------ |
| `TEST` | Test ortami (sandbox)    |
| `LIVE` | Canli ortam (production) |

### Ornek: Kimlik Dogrulama Hatasi

```json
{
  "Result": null,
  "Status": {
    "Messages": ["API key and secret are required"],
    "Code": 401,
    "Timestamp": "2026-03-07T12:00:00.000Z",
    "Path": "/Api/v1/Storage/List"
  }
}
```

---

## HMAC Imzalama

HMAC-SHA256 ile istek imzalama, enterprise tier icin zorunludur. Diger tier'larda opsiyoneldir ancak güvenlik icin tavsiye edilir.

### Imza Header'lari

| Header            | Aciklama                       |
| ----------------- | ------------------------------ |
| `x-api-signature` | HMAC-SHA256 hex imza           |
| `x-api-timestamp` | Unix epoch (saniye)            |
| `x-api-nonce`     | Tekil nonce (replay korunmasi) |

### Imza Olusturma

1. **Canonical string olustur:**

```
{timestamp}.{HTTP_METHOD}.{path}.{body_sha256}
```

- `timestamp`: Unix epoch (saniye)
- `HTTP_METHOD`: Büyük harf (`GET`, `POST`, vb.)
- `path`: Tam URL yolu (`/Api/v1/Storage/List`)
- `body_sha256`: Request body'nin SHA-256 hex hash'i. Body yoksa bos string'in hash'i.

2. **HMAC-SHA256 hesapla:**

```
signature = HMAC-SHA256(api_secret, canonical_string)
```

3. **Header'lara ekle:**

```bash
curl -X POST "https://api.example.com/Api/v1/Directories" \
  -H "x-api-key: pk_live_abc123" \
  -H "x-api-secret: sk_live_xyz789" \
  -H "x-api-signature: a1b2c3d4e5f6..." \
  -H "x-api-timestamp: 1709827200" \
  -H "x-api-nonce: unique-random-string" \
  -H "Content-Type: application/json" \
  -d '{"Path": "/documents"}'
```

### Kurallar

- **Zaman penceresi**: Timestamp en fazla **5 dakika** (300 saniye) eski olabilir.
- **Nonce tekrarsizligi**: Ayni nonce ayni API key ile 5 dakika icerisinde tekrar kullanilamaz.
- **Enterprise tier**: `x-api-signature` header'i zorunludur. Gonderilmezse `401` doner.

### Ornek: JavaScript ile Imza Olusturma

```javascript
const crypto = require('crypto');

function signRequest(method, path, body, apiSecret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const bodyString = body ? JSON.stringify(body) : '';
  const bodyHash = crypto.createHash('sha256').update(bodyString).digest('hex');

  const canonical = `${timestamp}.${method}.${path}.${bodyHash}`;
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(canonical)
    .digest('hex');

  return {
    'x-api-signature': signature,
    'x-api-timestamp': timestamp,
    'x-api-nonce': nonce,
  };
}
```

---

## Rate Limiting ve Kota

### Rate Limit

Her API key icin iki seviye rate limit uygulanir:

| Seviye     | Aciklama                       | Pencere                 |
| ---------- | ------------------------------ | ----------------------- |
| Per-minute | Dakika basina istek limiti     | 1 dakika (fixed window) |
| Burst      | Saniye basina ani istek limiti | 1 saniye                |

### Yanit Header'lari

Basarili isteklerde:

| Header                  | Aciklama                     |
| ----------------------- | ---------------------------- |
| `X-RateLimit-Limit`     | Dakika basina maksimum istek |
| `X-RateLimit-Remaining` | Kalan istek sayisi           |

429 hatalarinda ek olarak:

| Header        | Aciklama                                      |
| ------------- | --------------------------------------------- |
| `Retry-After` | Yeni istek gonderilmesi gereken süre (saniye) |

### Aylik Kota

Her kullanici icin aylik istek kotasi abonelik planina gore belirlenir.

| Header              | Aciklama               |
| ------------------- | ---------------------- |
| `X-Quota-Limit`     | Aylik toplam kota      |
| `X-Quota-Remaining` | Kalan aylik kota       |
| `X-Quota-Used`      | Kullanilmis aylik kota |

### Ornek: Rate Limit Yaniti

```
HTTP/1.1 429 Too Many Requests
Retry-After: 45
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 0

{
  "Result": null,
  "Status": {
    "Messages": ["Rate limit exceeded. Retry after 45 seconds."],
    "Code": 429
  }
}
```

---

## Idempotency

Yazi islemleri (POST, PUT, DELETE) icin idempotency key desteklenir. `@Idempotent()` dekoratoru ile isaretlenmis endpoint'lerde zorunludur.

### Kullanim

```bash
curl -X POST "https://api.example.com/Api/v1/Directories" \
  -H "x-api-key: pk_live_abc123" \
  -H "x-api-secret: sk_live_xyz789" \
  -H "idempotency-key: my-unique-operation-id-123" \
  -H "Content-Type: application/json" \
  -d '{"Path": "/new-folder"}'
```

### Kurallar

- **Zorunlu**: POST, PUT, DELETE isteklerinde `@Idempotent()` endpoint'ler icin.
- **Maksimum uzunluk**: 100 karakter.
- **Cache süresi**: 24 saat (Redis'te saklanir).
- **Ayni key ile tekrar istek**: Orijinal yanitin cache'lenmis kopyasi doner, islem tekrar calistirilmaz.
- **GET istekleri**: Idempotency key opsiyoneldir, gonderilmezse normal sekilde calisir.

---

## Hata Kodlari

Tum API hatalari standart `AP-XXX` kodlari ile doner.

### Authentication (AP-1xx)

| Kod      | Sabit               | Aciklama                     |
| -------- | ------------------- | ---------------------------- |
| `AP-101` | INVALID_API_KEY     | Gecersiz API key veya secret |
| `AP-102` | API_KEY_EXPIRED     | Süresi dolmus API key        |
| `AP-103` | API_KEY_REVOKED     | Iptal edilmis API key        |
| `AP-104` | INSUFFICIENT_SCOPES | Yetersiz scope yetkisi       |
| `AP-105` | IP_NOT_WHITELISTED  | IP adresi whitelist'te degil |

### Signature (AP-2xx)

| Kod      | Sabit               | Aciklama                              |
| -------- | ------------------- | ------------------------------------- |
| `AP-201` | SIGNATURE_REQUIRED  | HMAC imzasi zorunlu (enterprise tier) |
| `AP-202` | SIGNATURE_INVALID   | Gecersiz HMAC imzasi                  |
| `AP-203` | TIMESTAMP_EXPIRED   | Timestamp 5 dakikadan eski            |
| `AP-204` | NONCE_REUSED        | Nonce daha once kullanilmis           |
| `AP-205` | SIGNATURE_MALFORMED | Bozuk imza formati                    |

### Rate Limiting (AP-3xx)

| Kod      | Sabit                  | Aciklama                         |
| -------- | ---------------------- | -------------------------------- |
| `AP-301` | RATE_LIMIT_EXCEEDED    | Dakika basina rate limit asildi  |
| `AP-302` | BURST_LIMIT_EXCEEDED   | Saniye basina burst limit asildi |
| `AP-303` | MONTHLY_QUOTA_EXCEEDED | Aylik kota asildi                |
| `AP-304` | DAILY_QUOTA_EXCEEDED   | Günlük kota asildi               |

### Idempotency (AP-4xx)

| Kod      | Sabit                    | Aciklama                  |
| -------- | ------------------------ | ------------------------- |
| `AP-401` | IDEMPOTENCY_KEY_REQUIRED | Idempotency key zorunlu   |
| `AP-402` | IDEMPOTENCY_KEY_CONFLICT | Idempotency key catismasi |
| `AP-403` | IDEMPOTENCY_KEY_TOO_LONG | Key 100 karakterden uzun  |

### Webhook (AP-5xx)

| Kod      | Sabit                      | Aciklama                   |
| -------- | -------------------------- | -------------------------- |
| `AP-501` | WEBHOOK_NOT_FOUND          | Webhook bulunamadi         |
| `AP-502` | WEBHOOK_URL_INVALID        | Gecersiz webhook URL'i     |
| `AP-503` | WEBHOOK_LIMIT_EXCEEDED     | Tier webhook limiti asildi |
| `AP-504` | WEBHOOK_DELIVERY_NOT_FOUND | Delivery kaydı bulunamadi  |
| `AP-505` | WEBHOOK_DISABLED           | Webhook devre disi         |

### Usage (AP-6xx)

| Kod      | Sabit                    | Aciklama                     |
| -------- | ------------------------ | ---------------------------- |
| `AP-601` | USAGE_DATA_NOT_AVAILABLE | Kullanim verisi mevcut degil |

### Version (AP-7xx)

| Kod      | Sabit                 | Aciklama                     |
| -------- | --------------------- | ---------------------------- |
| `AP-701` | VERSION_NOT_SUPPORTED | Desteklenmeyen API versiyonu |
| `AP-702` | VERSION_DEPRECATED    | Deprecated API versiyonu     |

### General (AP-9xx)

| Kod      | Sabit                 | Aciklama                 |
| -------- | --------------------- | ------------------------ |
| `AP-901` | SUBSCRIPTION_REQUIRED | Abonelik gerekli         |
| `AP-902` | TIER_UPGRADE_REQUIRED | Tier yükseltmesi gerekli |
| `AP-903` | FEATURE_NOT_AVAILABLE | Ozellik mevcut degil     |

---

## Endpoint Referansi

Tum endpoint'ler `/Api/v1/` altindadir. Ornek: `GET /Api/v1/Storage/List`

### Guard Pipeline (Tum API Endpoint'leri)

```
Request
  → ApiAuthGuard       (x-api-key + x-api-secret dogrulama)
  → ApiScopeGuard      (scope yetki kontrolu)
  → ApiQuotaGuard      (aylik kota kontrolu)
  → ApiRateLimitGuard   (rate limit kontrolu)
  → ApiGeolocationInterceptor  (IP geolocation)
  → ApiIdempotencyInterceptor  (idempotency cache)
  → Handler
  → ApiUsageTrackingInterceptor (kullanim kaydı)
  → TransformInterceptor (yanit sarilmasi)
```

---

### Storage

**Base**: `/Api/v1/Storage`

| Method   | Endpoint          | Scope  | Idempotent | Aciklama                 |
| -------- | ----------------- | ------ | ---------- | ------------------------ |
| `GET`    | `/Storage/List`   | READ   | -          | Dosya ve klasor listesi  |
| `GET`    | `/Storage/Find`   | READ   | -          | Tek dosya/klasor bilgisi |
| `GET`    | `/Storage/Search` | READ   | -          | Arama                    |
| `PUT`    | `/Storage/Move`   | WRITE  | Evet       | Dosya/klasor tasima      |
| `DELETE` | `/Storage/Delete` | DELETE | Evet       | Dosya/klasor silme       |

**Ornek: Dosya Listeleme**

```bash
curl "https://api.example.com/Api/v1/Storage/List?Path=/documents&Skip=0&Take=25" \
  -H "x-api-key: pk_live_abc123" \
  -H "x-api-secret: sk_live_xyz789"
```

**Ornek: Dosya Tasima**

```bash
curl -X PUT "https://api.example.com/Api/v1/Storage/Move" \
  -H "x-api-key: pk_live_abc123" \
  -H "x-api-secret: sk_live_xyz789" \
  -H "idempotency-key: move-op-001" \
  -H "Content-Type: application/json" \
  -d '{"SourceKeys": ["/docs/file.pdf"], "DestinationPath": "/archive/"}'
```

---

### Upload

**Base**: `/Api/v1/Upload`

Multipart upload akisi 3 adimdan olusur:

| Adim | Method   | Endpoint                          | Scope | Idempotent |
| ---- | -------- | --------------------------------- | ----- | ---------- |
| 1    | `POST`   | `/Upload/CreateMultipartUpload`   | WRITE | Evet       |
| 2    | `POST`   | `/Upload/GetMultipartPartUrl`     | WRITE | -          |
| 2b   | `POST`   | `/Upload/GetMultipartPartUrls`    | WRITE | -          |
| 3    | `POST`   | `/Upload/CompleteMultipartUpload` | WRITE | Evet       |
| -    | `DELETE` | `/Upload/AbortMultipartUpload`    | WRITE | -          |

**Dosya Yukleme Akisi (CLI - Optimumize):**

```
1. CreateMultipartUpload    → UploadId alinir
2. GetMultipartPartUrls     → Tum partlar icin presigned URL'ler tek istekte alinir
3. Presigned URL'lere PUT   → Partlar paralel olarak dogrudan S3'e yuklenir
4. CompleteMultipartUpload  → Upload tamamlanir
```

> **Not**: `GetMultipartPartUrl` (tekil) yerine `GetMultipartPartUrls` (batch) kullanarak sunucuya yapilan istek sayisi minimuma indirilir. 5GB dosya icin ~80 istek yerine sadece 3 istek yeterli.

**Ornek: Upload Baslat**

```bash
curl -X POST "https://api.example.com/Api/v1/Upload/CreateMultipartUpload" \
  -H "x-api-key: pk_live_abc123" \
  -H "x-api-secret: sk_live_xyz789" \
  -H "idempotency-key: upload-start-001" \
  -H "Content-Type: application/json" \
  -d '{"Key": "/documents/large-file.zip", "ContentType": "application/zip", "TotalSize": 5368709120}'
```

**Ornek: Batch Part URL'leri Al**

```bash
curl -X POST "https://api.example.com/Api/v1/Upload/GetMultipartPartUrls" \
  -H "x-api-key: pk_live_abc123" \
  -H "x-api-secret: sk_live_xyz789" \
  -H "Content-Type: application/json" \
  -d '{"Key": "/documents/large-file.zip", "UploadId": "abc123-upload-id", "TotalParts": 78}'
```

**Batch Part URL'leri Yanit:**

```json
{
  "Result": {
    "Parts": [
      {
        "PartNumber": 1,
        "Url": "https://s3.../part1?X-Amz-...",
        "Expires": 3600
      },
      {
        "PartNumber": 2,
        "Url": "https://s3.../part2?X-Amz-...",
        "Expires": 3600
      }
    ]
  }
}
```

**Batch Request Parametreleri:**

| Alan          | Tip      | Zorunlu | Aciklama                                                            |
| ------------- | -------- | ------- | ------------------------------------------------------------------- |
| `Key`         | string   | Evet    | Yuklenen dosyanin key'i                                             |
| `UploadId`    | string   | Evet    | CreateMultipartUpload'dan alinan UploadId                           |
| `TotalParts`  | number   | \*      | Toplam part sayisi (1-10000). PartNumbers ile birlikte kullanilamaz |
| `PartNumbers` | number[] | \*      | Belirli part numaralari. TotalParts ile birlikte kullanilamaz       |

> `TotalParts` veya `PartNumbers` bir tanesinin gonderilmesi zorunludur. `PartNumbers` retry senaryolari icin kullanilir — sadece basarisiz olan partlarin URL'leri yeniden alinir.

**Part Boyutu Hesaplama (CLI tarafinda):**

```
Varsayilan part boyutu: 64 MB
640 GB ustu dosyalar icin: Math.ceil(totalSize / 10000)
Minimum part boyutu: 5 MB (S3 limiti)
Part sayisi: Math.ceil(totalSize / partSize)
```

---

### Download

**Base**: `/Api/v1/Download`

| Method | Endpoint    | Scope | Aciklama                 |
| ------ | ----------- | ----- | ------------------------ |
| `GET`  | `/Download` | READ  | Dosya indirme (streamed) |

Yanit binary stream olarak doner. Throttle per-user olarak uygulanir.

```bash
curl "https://api.example.com/Api/v1/Download?Key=/documents/report.pdf" \
  -H "x-api-key: pk_live_abc123" \
  -H "x-api-secret: sk_live_xyz789" \
  -o report.pdf
```

---

### Directories

**Base**: `/Api/v1/Directories`

| Method   | Endpoint       | Scope  | Idempotent | Aciklama         |
| -------- | -------------- | ------ | ---------- | ---------------- |
| `POST`   | `/Directories` | WRITE  | Evet       | Klasor olusturma |
| `DELETE` | `/Directories` | DELETE | Evet       | Klasor silme     |

**Ornek: Klasor Olusturma**

```bash
curl -X POST "https://api.example.com/Api/v1/Directories" \
  -H "x-api-key: pk_live_abc123" \
  -H "x-api-secret: sk_live_xyz789" \
  -H "idempotency-key: mkdir-001" \
  -H "Content-Type: application/json" \
  -d '{"Path": "/projects/new-project"}'
```

---

### Webhooks

**Base**: `/Api/v1/Webhooks`

| Method   | Endpoint                   | Scope | Idempotent | Aciklama                  |
| -------- | -------------------------- | ----- | ---------- | ------------------------- |
| `GET`    | `/Webhooks`                | READ  | -          | Tum webhook'lari listele  |
| `GET`    | `/Webhooks/:Id`            | READ  | -          | Webhook detay             |
| `POST`   | `/Webhooks`                | ADMIN | Evet       | Yeni webhook olustur      |
| `PUT`    | `/Webhooks/:Id`            | ADMIN | -          | Webhook güncelle          |
| `DELETE` | `/Webhooks/:Id`            | ADMIN | -          | Webhook sil (soft delete) |
| `POST`   | `/Webhooks/:Id/Test`       | ADMIN | -          | Test delivery gönder      |
| `GET`    | `/Webhooks/:Id/Deliveries` | READ  | -          | Delivery gecmisi          |

**Ornek: Webhook Olusturma**

```bash
curl -X POST "https://api.example.com/Api/v1/Webhooks" \
  -H "x-api-key: pk_live_abc123" \
  -H "x-api-secret: sk_live_xyz789" \
  -H "idempotency-key: webhook-create-001" \
  -H "Content-Type: application/json" \
  -d '{
    "Name": "Production Webhook",
    "Url": "https://myapp.com/webhooks/storage",
    "Events": ["file.uploaded", "file.deleted", "archive.create.complete"],
    "MaxRetries": 3,
    "TimeoutSeconds": 30
  }'
```

**Yanit** (Secret sadece olusturma sirasinda doner):

```json
{
  "Result": {
    "Id": "550e8400-e29b-41d4-a716-446655440000",
    "Name": "Production Webhook",
    "Url": "https://myapp.com/webhooks/storage",
    "Events": ["file.uploaded", "file.deleted", "archive.create.complete"],
    "IsActive": true,
    "MaxRetries": 3,
    "TimeoutSeconds": 30,
    "Secret": "whsec_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2",
    "ConsecutiveFailures": 0,
    "CreatedAt": "2026-03-07T12:00:00.000Z"
  },
  "Status": { ... }
}
```

---

### Usage

**Base**: `/Api/v1/Usage`

| Method | Endpoint         | Scope | Aciklama                 |
| ------ | ---------------- | ----- | ------------------------ |
| `GET`  | `/Usage/Current` | READ  | Mevcut ay kullanim ozeti |

**Ornek: Mevcut Kullanim**

```bash
curl "https://api.example.com/Api/v1/Usage/Current" \
  -H "x-api-key: pk_live_abc123" \
  -H "x-api-secret: sk_live_xyz789"
```

**Yanit:**

```json
{
  "Result": {
    "MonthlyUsed": 4523,
    "MonthlyLimit": 100000,
    "MonthlyRemaining": 95477,
    "DailyUsed": 234,
    "RateLimitPerMinute": 600,
    "RateLimitBurstPerSecond": 20,
    "BillingPeriod": "2026-03"
  }
}
```

---

### Notification

**Base**: `/Api/v1/Notification`

> **Not**: Bu endpoint'ler session-based kimlik dogrulama kullanir (web UI icin). API key ile erisilemez.

| Method  | Endpoint                    | Aciklama                         |
| ------- | --------------------------- | -------------------------------- |
| `GET`   | `/Notification/History`     | Bildirim gecmisi (paginated)     |
| `GET`   | `/Notification/UnreadCount` | Okunmamis bildirim sayisi        |
| `PATCH` | `/Notification/:Id/Read`    | Bildirimi okundu isaretle        |
| `PATCH` | `/Notification/ReadAll`     | Tum bildirimleri okundu isaretle |

**Ornek: Bildirim Gecmisi**

```json
{
  "Result": {
    "Items": [
      {
        "_id": "65f...",
        "UserId": "550e8400-...",
        "Type": "UPLOAD_COMPLETE",
        "Title": "Yukleme Tamamlandi",
        "Message": "report.pdf basariyla yuklendi",
        "Data": { "Key": "/documents/report.pdf" },
        "IsRead": false,
        "CreatedAt": "2026-03-07T12:00:00.000Z"
      }
    ],
    "Count": 42
  }
}
```

---

## Webhook Sistemi

### Desteklenen Event'ler

| Event                      | Aciklama                    |
| -------------------------- | --------------------------- |
| `file.uploaded`            | Dosya basariyla yuklendi    |
| `file.deleted`             | Dosya silindi               |
| `file.moved`               | Dosya tasindi               |
| `file.updated`             | Dosya metadata güncellendi  |
| `directory.created`        | Klasor olusturuldu          |
| `directory.deleted`        | Klasor silindi              |
| `directory.renamed`        | Klasor yeniden adlandirildi |
| `archive.extract.complete` | Arsiv cikarma tamamlandi    |
| `archive.extract.failed`   | Arsiv cikarma basarisiz     |
| `archive.create.complete`  | Arsiv olusturma tamamlandi  |
| `archive.create.failed`    | Arsiv olusturma basarisiz   |
| `quota.warning`            | Kota uyarisi                |
| `quota.exceeded`           | Kota asildi                 |
| `api_key.rotated`          | API key rotate edildi       |
| `api_key.revoked`          | API key iptal edildi        |

### Delivery Formati

Webhook'lar HTTP POST olarak gonderilir:

```
POST https://myapp.com/webhooks/storage
Content-Type: application/json
X-Webhook-Id: 550e8400-e29b-41d4-a716-446655440000
X-Webhook-Signature: sha256=a1b2c3d4e5f6...
X-Webhook-Timestamp: 1709827200
User-Agent: NestJS-Storage-Webhook/1.0
```

```json
{
  "Event": "file.uploaded",
  "Timestamp": "2026-03-07T12:00:00.000Z",
  "Data": {
    "Key": "/documents/report.pdf",
    "Size": 1048576,
    "ContentType": "application/pdf"
  }
}
```

### Webhook Imza Dogrulamasi

Gelen webhook'larin dogrulanmasi icin:

```javascript
const crypto = require('crypto');

function verifyWebhookSignature(
  payload,
  signatureHeader,
  secret,
  timestampHeader,
) {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${timestampHeader}.${payload}`)
    .digest('hex');

  const receivedSignature = signatureHeader.replace('sha256=', '');

  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature, 'hex'),
    Buffer.from(receivedSignature, 'hex'),
  );
}

// Express middleware ornegi
app.post('/webhooks/storage', (req, res) => {
  const isValid = verifyWebhookSignature(
    JSON.stringify(req.body),
    req.headers['x-webhook-signature'],
    'whsec_your_secret_here',
    req.headers['x-webhook-timestamp'],
  );

  if (!isValid) {
    return res.status(401).send('Invalid signature');
  }

  // Webhook'u isle...
  console.log('Event:', req.body.Event);
  res.status(200).send('OK');
});
```

### Retry Politikasi

Basarisiz delivery'ler otomatik olarak tekrar denenir:

| Deneme   | Bekleme Süresi |
| -------- | -------------- |
| 1. retry | 30 saniye      |
| 2. retry | 2 dakika       |
| 3. retry | 10 dakika      |
| 4. retry | 30 dakika      |
| 5. retry | 1 saat         |

- Retry islemi her **30 saniyede** bir kontrol edilir.
- `MaxRetries` webhook basina yapilandirilabilir (varsayilan: 3, maksimum: 5).
- **10 ardisik basarisizlik** sonrasi webhook otomatik olarak devre disi birakilir ve kullaniciya bildirim gonderilir.

### Delivery Durumlari

| Durum      | Aciklama                         |
| ---------- | -------------------------------- |
| `PENDING`  | Gonderim bekliyor                |
| `SUCCESS`  | Basariyla gonderildi (2xx yanit) |
| `RETRYING` | Retry bekliyor                   |
| `FAILED`   | Tum denemeler basarisiz          |

---

## Tier Limitleri

API limitleri abonelik planina gore belirlenir. Limitler subscription `Features` JSON'indaki `api` key'inden okunur.

| Ozellik              | Free  | Pro     | Enterprise |
| -------------------- | ----- | ------- | ---------- |
| Aylik istek kotasi   | 1,000 | 100,000 | Sinirsiz   |
| Rate limit (dakika)  | 60    | 600     | 2,000      |
| Burst limit (saniye) | 5     | 20      | 50         |
| HMAC zorunlulugu     | Hayir | Hayir   | Evet       |
| Maksimum webhook     | 2     | 10      | 25         |
| Veri saklama süresi  | 7 gün | 90 gün  | 365 gün    |

### Subscription Features JSON Yapisi

```json
{
  "downloadSpeedBytesPerSec": 512000,
  "api": {
    "monthlyRequestQuota": 100000,
    "rateLimitPerMinute": 600,
    "rateLimitBurstPerSecond": 20,
    "hmacRequired": false,
    "maxWebhooks": 10,
    "retentionDays": 90
  }
}
```

---

## MongoDB Loglama

Yüksek hacimli log ve audit verileri MongoDB'de saklanir. PostgreSQL iliskisel veri icin (kullanicilar, dosyalar, abonelikler vb.) kullanilmaya devam eder.

### Baglanti Yapisi

```
MONGO_URI=mongodb://localhost:27017
MONGO_DATABASE=storage_logs
MONGO_ENABLED=true
```

`MONGO_ENABLED=false` ile MongoDB devredisi birakilabilir. Bu durumda loglama islemleri sessizce atlanir.

### Collection'lar

#### ApiUsageLogs

Her API istegi 5 dakikada bir (cron flush) bu collection'a kaydedilir.

| Alan                | Tip    | Aciklama                       |
| ------------------- | ------ | ------------------------------ |
| `UserId`            | string | Kullanici ID                   |
| `ApiKeyId`          | string | API Key ID                     |
| `Method`            | string | HTTP method (GET, POST, vb.)   |
| `Endpoint`          | string | Request URL                    |
| `StatusCode`        | number | HTTP yanit kodu                |
| `ResponseTimeMs`    | number | Yanit süresi (ms)              |
| `RequestBodyBytes`  | number | Request body boyutu            |
| `ResponseBodyBytes` | number | Response body boyutu           |
| `IpAddress`         | string | Istemci IP adresi              |
| `CountryCode`       | string | Ülke kodu (ISO 3166-1 alpha-2) |
| `City`              | string | Sehir                          |
| `Latitude`          | number | Enlem                          |
| `Longitude`         | number | Boylam                         |
| `UserAgent`         | string | User-Agent header              |
| `IdempotencyKey`    | string | Idempotency key (varsa)        |
| `ApiVersion`        | string | API versiyonu                  |
| `CreatedAt`         | Date   | Olusturulma tarihi             |

**TTL**: 365 gün (otomatik olarak silinir).

**Index'ler**:

- `{ UserId: 1, CreatedAt: -1 }` — kullanim gecmisi sorgulari
- `{ UserId: 1, Endpoint: 1, Method: 1, CreatedAt: -1 }` — endpoint breakdown
- `{ CreatedAt: 1 }` TTL index

#### NotificationHistory

Tum WebSocket bildirimleri ayrica bu collection'a kaydedilir. Kullanicilarin cevrimdisi oldugunda kaçirdigi bildirimleri gormesini saglar.

| Alan        | Tip     | Aciklama                              |
| ----------- | ------- | ------------------------------------- |
| `UserId`    | string  | Kullanici ID                          |
| `Type`      | string  | Bildirim tipi (NotificationType enum) |
| `Title`     | string  | Baslik                                |
| `Message`   | string  | Mesaj                                 |
| `Data`      | object  | Ek veri (opsiyonel)                   |
| `IsRead`    | boolean | Okundu durumu                         |
| `ReadAt`    | Date    | Okunma tarihi                         |
| `CreatedAt` | Date    | Olusturulma tarihi                    |

**TTL**: 90 gün.

**Index'ler**:

- `{ UserId: 1, IsRead: 1, CreatedAt: -1 }` — okunmamis bildirim sorgulari
- `{ CreatedAt: 1 }` TTL index

#### AuditLogs

Onemli kullanici islemlerinin kaydi.

| Alan         | Tip    | Aciklama                                           |
| ------------ | ------ | -------------------------------------------------- |
| `UserId`     | string | Islemi yapan kullanici                             |
| `TeamId`     | string | Takim ID (varsa)                                   |
| `Action`     | string | Islem tipi (asagiya bkz.)                          |
| `Resource`   | string | Etkilenen kaynak tipi (File, ApiKey, Webhook, vb.) |
| `ResourceId` | string | Etkilenen kaynak ID                                |
| `Details`    | object | Islem detaylari                                    |
| `IpAddress`  | string | Istemci IP adresi                                  |
| `UserAgent`  | string | User-Agent header                                  |
| `Result`     | string | `SUCCESS` veya `FAILURE`                           |
| `CreatedAt`  | Date   | Olusturulma tarihi                                 |

**TTL**: 365 gün.

**Index'ler**:

- `{ UserId: 1, CreatedAt: -1 }` — kullanici aktivite zaman cizgisi
- `{ TeamId: 1, CreatedAt: -1 }` — takim audit trail
- `{ Action: 1, CreatedAt: -1 }` — islem tipine gore filtreleme
- `{ CreatedAt: 1 }` TTL index

---

## Audit Log

### Audit Islem Tipleri

| Kategori           | Islem                        | Aciklama                        |
| ------------------ | ---------------------------- | ------------------------------- |
| **Authentication** | `AUTH_LOGIN`                 | Basarili giris                  |
|                    | `AUTH_LOGOUT`                | Çikis                           |
|                    | `AUTH_LOGIN_FAILED`          | Basarisiz giris denemesi        |
|                    | `AUTH_PASSWORD_CHANGED`      | Sifre degisikligi               |
|                    | `AUTH_2FA_ENABLED`           | 2FA aktif edildi                |
|                    | `AUTH_2FA_DISABLED`          | 2FA devre disi                  |
|                    | `AUTH_PASSKEY_REGISTERED`    | Passkey kaydedildi              |
|                    | `AUTH_PASSKEY_REMOVED`       | Passkey silindi                 |
| **Account**        | `ACCOUNT_UPDATED`            | Hesap bilgisi güncellendi       |
|                    | `ACCOUNT_DELETED`            | Hesap silindi                   |
| **API Keys**       | `API_KEY_CREATED`            | API key olusturuldu             |
|                    | `API_KEY_ROTATED`            | API key rotate edildi           |
|                    | `API_KEY_REVOKED`            | API key iptal edildi            |
| **Webhooks**       | `WEBHOOK_CREATED`            | Webhook olusturuldu             |
|                    | `WEBHOOK_UPDATED`            | Webhook güncellendi             |
|                    | `WEBHOOK_DELETED`            | Webhook silindi                 |
| **Storage**        | `FILE_UPLOADED`              | Dosya yuklendi                  |
|                    | `FILE_DELETED`               | Dosya silindi                   |
|                    | `FILE_MOVED`                 | Dosya tasindi                   |
|                    | `DIRECTORY_CREATED`          | Klasor olusturuldu              |
|                    | `DIRECTORY_DELETED`          | Klasor silindi                  |
| **Team**           | `TEAM_CREATED`               | Takim olusturuldu               |
|                    | `TEAM_MEMBER_INVITED`        | Üye davet edildi                |
|                    | `TEAM_MEMBER_REMOVED`        | Üye çikarildi                   |
|                    | `TEAM_ROLE_CHANGED`          | Üye rolü degistirildi           |
|                    | `TEAM_OWNERSHIP_TRANSFERRED` | Takim sahipligi transfer edildi |
| **Subscription**   | `SUBSCRIPTION_CHANGED`       | Abonelik degistirildi           |
|                    | `SUBSCRIPTION_CANCELLED`     | Abonelik iptal edildi           |

### AuditLogService Kullanimi

```typescript
import { AuditLogService } from '@modules/mongo/audit-log.service';
import { AuditAction } from '@modules/mongo/audit-log.constants';

@Injectable()
export class SomeService {
  constructor(private readonly AuditLogService: AuditLogService) {}

  async DoSomething(user: UserContext) {
    // ... islem yap ...

    // Fire-and-forget audit kaydı (asla throw etmez)
    await this.AuditLogService.Record({
      UserId: user.Id,
      Action: AuditAction.FILE_UPLOADED,
      Resource: 'File',
      ResourceId: 'file-uuid-here',
      Details: { Key: '/documents/report.pdf', Size: 1048576 },
      IpAddress: '1.2.3.4',
      UserAgent: 'Mozilla/5.0',
      Result: 'SUCCESS',
    });
  }
}
```

### Audit Sorgulama

```typescript
// Kullanici audit log'u (paginated)
const result = await auditLogService.GetUserAuditLog(
  userId,
  0, // Skip
  25, // Take
  'FILE_UPLOADED', // Opsiyonel Action filtresi
);

// Takim audit log'u (paginated)
const result = await auditLogService.GetTeamAuditLog(
  teamId,
  0, // Skip
  25, // Take
);
```

---

## Ortam Degiskenleri

### MongoDB

| Degisken         | Zorunlu | Varsayilan                  | Aciklama                   |
| ---------------- | ------- | --------------------------- | -------------------------- |
| `MONGO_URI`      | Hayir   | `mongodb://localhost:27017` | MongoDB baglanti URI'si    |
| `MONGO_DATABASE` | Hayir   | `storage_logs`              | Veritabani adi             |
| `MONGO_ENABLED`  | Hayir   | `true`                      | MongoDB'yi aktif/pasif yap |

### API Sistemi

| Degisken                      | Zorunlu | Varsayilan | Aciklama                          |
| ----------------------------- | ------- | ---------- | --------------------------------- |
| `API_IDEMPOTENCY_TTL_SECONDS` | Hayir   | `86400`    | Idempotency cache süresi (saniye) |
| `GEOIP_DB_PATH`               | Hayir   | -          | geoip-lite veritabani yolu        |

### Redis TTL Degerleri (Sabit)

| Anahtar               | Süre       | Aciklama                        |
| --------------------- | ---------- | ------------------------------- |
| API Usage Monthly     | 35 gün     | Aylik sayac TTL                 |
| API Usage Daily       | 48 saat    | Günlük sayac TTL                |
| API Rate Limit Window | 120 saniye | Rate limit penceresi            |
| API Rate Limit Burst  | 2 saniye   | Burst limit penceresi           |
| API Idempotency       | 24 saat    | Idempotency cache               |
| API Signature Nonce   | 5 dakika   | Nonce replay korunmasi          |
| Webhook User Cache    | 5 dakika   | Kullanici webhook listesi cache |
| API Geo Cache         | 24 saat    | IP geolocation cache            |
