# GmailFlow — Teknik dokümantasyon

Kendi Gmail hesabınızla, Excel/CSV listesindeki her alıcıya **ayrı ayrı** kişiselleştirilmiş e-posta gönderen Windows masaüstü uygulaması.

- Her alıcıya ayrı bir mesaj gider: `To:` alanında yalnızca o alıcı bulunur, **CC/BCC asla kullanılmaz**. Alıcılar birbirini görmez.
- Gmail limitlerine uyulur: son 24 saatte en fazla 450 (kişisel Gmail) / 1800 (Workspace) gönderim yapılır. Limit dolunca gönderim otomatik duraklatılır.
- Aynı kişiye tekrar gönderim engellenir (aşağıdaki "Mükerrer gönderim koruması" bölümüne bakın).
- Uygulama aynı zamanda bir **Gmail masaüstü istemcisidir** (Thunderbird benzeri, yalnızca Gmail). Kampanyalara gelen yanıtlar ve geri dönen mailler otomatik olarak takip edilir.

## Mükerrer gönderim koruması

Aynı kişiye iki kez mail gitmemesi için şu kurallar uygulanır:

| Durum | Ne olur |
|---|---|
| Listede aynı adres iki kez (büyük/küçük harf, boşluk farkı) | İçe aktarırken ayıklanır |
| Aynı Gmail kutusunun farklı yazımları (`ali@gmail.com`, `a.li@gmail.com`, `ali+x@googlemail.com`) | Aynı kişi sayılır: listede ayıklanır, gönderimde ikincisi atlanır |
| Daha önceki bir toplu gönderimde **gönderilmiş ya da durumu belirsiz kalmış** adres | Atlanır ("Daha önce gönderim yapılmış adresleri atla" varsayılan olarak açıktır) |
| Engelli adres (geri döndü / abonelikten çıktı / elle) | Hiçbir gönderimde mail gitmez |
| Aynı gönderim içinde | Veritabanında her adres yalnızca bir kez bulunabilir |
| Bağlantı koparsa veya Gmail sunucu hatası (5xx) verirse | **Otomatik olarak yeniden denenmez.** Alıcı "belirsiz" olarak işaretlenir ve gönderim duraklatılır; kullanıcı Gmail'in Gönderilmiş klasörüne bakıp "Gönderildi say" veya "Tekrar dene" der |
| Uygulama gönderim sırasında kapanırsa | Yarıda kalan alıcı "belirsiz" olur, yeniden gönderilmez |
| Gmail isteği kesin olarak reddettiyse (429 hız sınırı, kota, yetki) | Mesaj gitmemiştir; güvenle yeniden denenir |
| Aynı anda iki gönderim | Mümkün değildir: tek kuyruk vardır ve uygulamanın yalnızca bir kopyası çalışabilir |

Kullanıcının bilerek yapabileceği tekrarlar ise şunlardır:
- "Daha önce gönderim yapılmış adresleri atla" seçeneğini kapatmak,
- belirsiz bir alıcı için "Tekrar dene" demek,
- bir gönderimi silmek (silinen gönderimin geçmişi artık korumada dikkate alınmaz).

## Posta (gelen kutusu)

Sol menüdeki **Posta** ekranı Gmail API ile çalışır ve üç bölmeden oluşur: klasörler, konuşma listesi, okuma bölmesi.

- **Klasörler:** Gelen kutusu, Yıldızlı, Önemli, Gönderilmiş, Taslaklar, Tüm postalar, Spam, Çöp kutusu; Güncellemeler, Promosyonlar, Sosyal ve Forumlar kategorileri; kendi Gmail etiketleriniz.
  - *Ertelenenler* gösterilemez, çünkü Gmail API ertelenen postalara erişim vermiyor.
- **İşlemler:** okuma, yıldızlama, önemli olarak işaretleme, okundu/okunmadı, arşivleme, çöp kutusuna taşıma ve geri alma, spam bildirme, etiket ekleme ve kaldırma. Bu işlemler tek tek veya çoklu seçimle yapılabilir ve Gmail ile iki yönlü eşitlenir.
  - Kalıcı silme yoktur, çünkü bu tam erişim izni gerektirir.
- **Yazma:** yeni posta, yanıtla, tümünü yanıtla, ilet (orijinal eklerle).
  - Kime, Bilgi ve Gizli alanları Kayıtlı mailler ve yazıştığınız kişilerden otomatik tamamlanır.
  - Taslak, yazarken otomatik olarak Gmail'e kaydedilir.
  - İmza Ayarlar'dan girilir. Ctrl+Enter ile gönderilir.
- **Gizlilik:** e-postalar, betik çalıştıramayan yalıtılmış bir çerçevede gösterilir. Uzak görseller (izleme pikselleri dahil) varsayılan olarak engellenir; "Görselleri göster" veya "Bu gönderenden hep göster" ile açılır.
- **Önbellek:** son 30 günün postaları (süre Ayarlar'dan değiştirilebilir) içerikleriyle bu bilgisayara indirilir. Türkçe karakterlere duyarsız tam metin arama yapılabilir; örneğin "toplanti" araması "Toplantı"yı bulur. Daha eski postalar "Daha eski postaları yükle" veya "Tüm Gmail'de ara" ile getirilir. Ekler yalnızca açıldığında indirilir.
- **Senkronizasyon:** 30 saniyede bir yalnızca değişiklikler çekilir (Gmail history API). Uzun süre kapalı kalındıysa otomatik olarak tam senkronizasyon yapılır.
- **Gmail kota sınırları:** istekler ihtiyatlı bir hızla (≈ 4.800 birim/dakika) gönderilir. Gmail "Units per minute per user" hatası verirse tüm istekler 60 saniye bekler ve hız yarıya iner; başarılı istekler geldikçe hız yavaşça geri yükselir. İndirilemeyen postalar kaybolmaz, kuyruğa alınıp sonraki senkronizasyonda indirilir. Uygulama her açıldığında Gmail ile önbellek karşılaştırılır ve eksikler tamamlanır.
- **Bildirim:** yeni postalarda Windows bildirimi gösterilir; bildirime tıklayınca ilgili konuşma açılır.
- **Klavye kısayolları:** `c` yeni · `r` yanıtla · `a` tümünü yanıtla · `f` ilet · `e` arşivle · `#` sil · `s` yıldız · `j`/`k` gezin · `/` ara · `Esc` kapat.
- **Bağlantı kesilirse:** hesabın bağlantısı kesildiğinde veya başka bir hesaba geçildiğinde posta önbelleği silinir.

### Kampanya takibi ve engelleme listesi

Gelen kutusu okunabildiği için kampanya gönderimleri otomatik olarak izlenir:

| Olay | Nasıl anlaşılır | Sonuç |
|---|---|---|
| **Yanıt** | Kampanya mailinin konuşmasına alıcıdan ileti gelmesi | Kampanyada ve Kayıtlı maillerde "Yanıtladı" görünür |
| **Geri dönen mail (bounce)** | `mailer-daemon` raporu: X-Failed-Recipients başlığı veya teslimat durumu raporu. Yalnızca **5.x.x kalıcı hatalar** sayılır, geçici 4.x.x hatalar yok sayılır | Adres **engellenir** |
| **Abonelikten çıkma** | Yanıtta "listeden çıkarın", "mail atmayın", "unsubscribe" vb. ifadeler (alıntılanan önceki metin hariç) veya List-Unsubscribe ile gelen "unsubscribe" maili | Adres **engellenir** |

- Engelli adreslere hiçbir kampanyada gönderim yapılmaz; gönderim öncesi özet, kaç adresin bu yüzden atlanacağını gösterir.
- Kayıtlı mailler sayfasında Yanıtladı / Geri döndü / Abonelikten çıktı / Engelli filtreleri ve **Engelle / Engeli kaldır** işlemleri vardır.
- Kampanya maillerine isteğe bağlı olarak (varsayılan açık) `List-Unsubscribe` başlığı eklenir. Böylece Gmail alıcıya tek tıkla abonelikten çıkma düğmesi gösterir; bu da spam olarak işaretlenme riskini azaltır.
- Panel'de yanıt oranı ve geri dönme oranı gösterilir.

### İzinler

Bağlanırken üç Gmail izni istenir:
- `gmail.send`: gönderim,
- `gmail.modify`: okuma, etiketleme ve çöp kutusu işlemleri,
- `gmail.compose`: taslaklar.

Önceki sürümle bağlanmış bir hesap için uygulama "Yeniden bağlan" uyarısı gösterir; toplu gönderim bu arada çalışmaya devam eder.

`gmail.modify` ve `gmail.compose` Google'ın "kısıtlı" izinleridir. Kendi OAuth istemcinizle kişisel kullanımda sorun olmaz; yalnızca "doğrulanmamış uygulama" uyarısı çıkar. Uygulamayı tek bir istemciyle geniş kitleye dağıtmak için Google doğrulaması ve yıllık güvenlik denetimi (CASA) gerekir.

## Alıcı listesi ekleme

**1. Dosyadan (Excel .xlsx veya CSV)**

| Ad Soyad | E-posta | Şirket |
|---|---|---|
| Ayşe Yılmaz | ayse@ornek.com | Yılmaz Ltd |

- İlk satır sütun başlıklarıdır. Başlık satırı yoksa da dosya okunur; sütunlar otomatik adlandırılır.
- E-posta adreslerinin bulunduğu bir sütun zorunludur. Sütunun adı ve sırası önemli değildir; otomatik bulunur ve gerekirse değiştirilebilir.
- Diğer tüm sütunlar mesajda kişiselleştirme değişkeni olur. Örneğin `Şirket` sütunu mesajda `{{sirket}}` olarak kullanılır.
- CSV'de virgül, noktalı virgül veya sekme ayırıcı olabilir. UTF-8 ve Türkçe Windows (1254) kodlamaları desteklenir.
- Eski `.xls` biçimi desteklenmez; dosyayı Excel'de `.xlsx` olarak kaydedin.
- İçe aktarma penceresinden örnek bir şablon indirilebilir.

**2. Yapıştır / elle yaz**

Adresler virgül, noktalı virgül, iki nokta, boşluk veya alt satırla ayrılabilir. Excel'den kopyalanan bir sütun da doğrudan yapıştırılabilir:

```
a@gmail.com,b@gmail.com
c@firma.com:d@firma.com:
```

Var olan bir listeye de aynı yöntemle adres eklenebilir (liste sayfasındaki **Adres ekle** düğmesi). Listede zaten bulunan adresler tekrar eklenmez.

**3. Kayıtlı mailler (adres defteri)**

İçe aktarılan ve elle eklenen tüm geçerli adresler, her adres bir kez olacak şekilde **Kayıtlı mailler** sayfasında toplanır. Aynı adres farklı listelerden gelirse ad ve diğer bilgileri birleştirilir. Liste silinse bile adres defterde kalır.

- Her adres için ad, bulunduğu listeler, gönderim sayısı, son gönderim tarihi ve hata durumu gösterilir.
- Filtreler: Tümü / Hiç gönderilmedi / Gönderildi / Hatalı. Ayrıca listeye göre filtreleme ve e-posta, ad veya şirkete göre arama yapılabilir.
- Adresler tek tek ya da "filtreye uyan tümünü seç" ile toplu seçilebilir. Seçilenlerle **yeni liste oluşturulabilir** veya **var olan listeye eklenebilir**. Ad ve şirket gibi bilgiler listeye sütun olarak taşınır, böylece kişiselleştirmede kullanılabilir.
- Ad hücresine tıklayarak ad düzenlenebilir. Elle girilen ad, sonraki içe aktarmalarda değiştirilmez.
- Defterden silmek mevcut listeleri ve gönderim geçmişini etkilemez.
- Önceki sürümle oluşturulmuş veritabanlarında, var olan listelerdeki adresler ilk açılışta deftere otomatik aktarılır.

## Mimari

| Katman | Teknoloji | Konum |
|---|---|---|
| Masaüstü kabuğu | Electron 45 | `electron/` |
| API | Fastify 5 (Electron ana sürecinde `127.0.0.1`'e bağlı, oturum anahtarlı) | `server/` |
| Veritabanı | SQLite (Node'un yerleşik `node:sqlite` modülü, native derleme gerekmez) | `server/db/` |
| Arayüz | Vue 3 + Vite + Pinia + vue-i18n (TR/EN) + TipTap | `renderer/` |
| Gmail | Gmail API (OAuth 2.0 PKCE): gönderim, posta senkronizasyonu (history API), okuma/etiket/taslak | `server/services/` |

Önemli servisler:

- `sender.js`: gönderim kuyruğu. Başlat, duraklat, devam ettir ve iptal işlemlerini yönetir. Günlük limit, hata sınıflandırma ve çökme sonrası kurtarma da buradadır.
- `importer.js`: .xlsx ve .csv dosyalarını okur. CSV için `;`, `,`, sekme ve `|` ayırıcılarını, UTF-8, BOM ve Windows-1254 kodlamalarını otomatik algılar.
- `validator.js`: adresleri doğrular, normalleştirir ve tekrarları ayıklar.
- `template.js`: kişiselleştirme yer tutucularını işler. `{{ad}}` biçiminde değişken, `{{sirket|Değerli müşterimiz}}` biçiminde varsayılan değer kullanılabilir.
- `mime.js`: RFC 5322 mesajını üretir (HTML ve düz metin alternatifleri, ekler; toplam ek boyutu en fazla 25 MB).
- `oauth.js`: Google OAuth akışını yürütür. Refresh token, Windows DPAPI (`safeStorage`) ile şifrelenerek saklanır.

**Kullanıcı verileri** `%APPDATA%\GmailFlow\` klasöründe tutulur: `gmailflow.db`, `attachments\` ve `secrets.json`. Bu klasör uygulama güncellendiğinde veya yeniden kurulduğunda silinmez.

## Google OAuth istemcisi (kullanıcı başına bir kez)

Uygulamadaki **Gmail hesabı** sayfasında adım adım bir rehber ve ilgili konsol sayfalarına bağlantılar bulunur. Özetle:

1. Google Cloud Console'da bir proje oluşturun ve **Gmail API**'yi etkinleştirin.
2. Google Auth Platform → **Branding** sayfasında uygulama adını girin. **Audience** sayfasında kullanıcı türü olarak *External* seçin ve kendi Gmail adresinizi *Test users* listesine ekleyin.
3. **Clients** → *Create client* → uygulama türü olarak **Desktop app** seçin.
4. Client ID ve Client Secret değerlerini uygulamaya girip **Google ile bağlan** düğmesine basın.

> Uygulama *Testing* durumundayken Google, bağlantıyı 7 günde bir sona erdirir. Bu durumda "Yeniden bağlan" demeniz yeterlidir. Kalıcı bağlantı için uygulamayı *In production* durumuna alabilirsiniz.

## Geliştirme

### Docker ile (yerelde Node gerekmez)

```bash
docker compose up --build            # http://localhost:5173  (API: 127.0.0.1:3000)
API_PORT=3300 WEB_PORT=5273 docker compose up   # portlar doluysa
docker compose run --rm test         # birim testleri
```

- Kaynak kod konteynere bağlanır; API (`node --watch`) ve arayüz (Vite HMR) değişiklikte otomatik olarak yeniden yüklenir.
- Veriler `./.devdata` klasöründe tutulur. Bu modda gizli bilgiler **şifrelenmez**.

### Ana makinede

```bash
npm install
npm run dev:web        # tarayıcı modu (API + Vite)
npm run dev:electron   # Electron kabuğu ile
npm test
```

## Uygulama ikonu

İkonun kaynağı `build/gmailflow.svg` dosyasıdır. SVG değiştirildikten sonra şu komut çalıştırılır:

```bash
npm run icon   # → build/icon.png, build/icon.ico (16–256 px), renderer/src/assets/logo.png
```

Komut SVG'yi Electron'un tarayıcı motoruyla her boyutta vektörden çizer. Boş kenarları otomatik kırptığı için küçük boyutlarda da ikon net görünür.

## Kurulum dosyası (Windows x64)

```bash
npm run dist           # → dist/GmailFlow-Setup-x64.exe
```

**İmzalama:** derlemeden önce aşağıdaki ortam değişkenlerini tanımlayın. electron-builder hem uygulamayı hem de kurulum dosyasını imzalar; değişkenler yoksa imzalama atlanır.

```powershell
$env:CSC_LINK = "C:\yol\sertifika.pfx"
$env:CSC_KEY_PASSWORD = "parola"
npm run dist
signtool verify /pa dist\GmailFlow-Setup-x64.exe
```

(EV sertifikası donanım anahtarında veya Azure Trusted Signing üzerindeyse `electron-builder.yml` içindeki `win.signtoolOptions` buna göre uyarlanmalıdır.)

Son kullanıcının bilgisayarında Node.js, npm, Docker veya Python kurulu olması gerekmez. Desteklenen sistemler: Windows 10 ve Windows 11 x64.

## Gönderim kuralları

- Her e-postadan sonra kullanıcının belirlediği sabit bekleme süresi uygulanır (en az 1 sn).
- Spam filtrelerini atlatmaya yönelik rastgele gecikme, içerik varyasyonu veya hesap çoğaltma gibi teknikler kullanılmaz.
- **Geçersiz alıcı** (400): satır *başarısız* olarak işaretlenir ve gönderim devam eder. Art arda 5 hata olursa kampanya duraklatılır.
- **Hız sınırı** (429) veya geçici sunucu hatası (5xx): üstel bekleme ile en fazla 3 kez yeniden denenir.
- **Gmail günlük kota hatası**, **yetki hatası** veya **ağ kopması**: kampanya duraklatılır. İsteğin Google'a ulaşıp ulaşmadığı belli değilse ilgili satır *belirsiz* olarak işaretlenir. Bu satırlar için "gönderildi say" ya da "tekrar dene" kararını kullanıcı verir.
