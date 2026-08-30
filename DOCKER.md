# Локальный запуск Nonna в Docker

Стек состоит из Strapi, Nuxt и nginx. Основная точка входа — `http://localhost:8080`.

`dev-config/docker-compose.yml` остаётся совместимым входом в локальный стек.
`prod-config/docker-compose.yml` — отдельный production-контур с доменами, TLS
и закрытыми внутренними сервисами; порядок его подготовки описан ниже.

## 1. Подготовка данных

Положите восстановленную SQLite-базу в `cms/.tmp/data.db`, а файлы медиатеки — в
`cms/public/uploads/`. Эти каталоги игнорируются Git и не попадут в образ.

При первом запуске база и отсутствующие uploads копируются в именованные Docker
volumes. Следующие запуски не перезаписывают рабочую базу.

## 2. Переменные окружения

В `cms/.env` должны быть секреты Strapi. Если файла нет, скопируйте
`cms/.env.example` и заполните значения. Для восстановленной базы используйте
тот же `API_TOKEN_SALT`, с которым создавались её API-токены; иначе Strapi будет
отклонять их.

Скопируйте `.env.docker.example` в `.env`. В `API_BEARER_TOKEN` укажите обычное
значение read-only API-токена из Strapi. Если токена пока нет, стек можно поднять
с пустым значением, открыть `/admin`, создать токен, добавить его в `.env` и
пересоздать frontend:

```bash
docker compose up -d --force-recreate frontend nginx
```

Токен передаётся только серверной части Nuxt. Браузер обращается к `/api`, а
Nuxt добавляет авторизацию перед запросом к Strapi; в публичный runtime-конфиг
секрет не попадает. Прокси принимает только `GET` и `HEAD`, поэтому для сайта
нужен токен без прав на изменение данных.

По умолчанию все опубликованные порты привязаны к `127.0.0.1`. Не меняйте
`BIND_ADDRESS` на `0.0.0.0`, пока доступ извне не закрыт firewall и TLS-прокси.

Чтобы использовать другую резервную копию, измените `CMS_SEED_DATABASE`, например:

```dotenv
CMS_SEED_DATABASE=./cms/.tmp/local-run-data.db
```

## 3. Сборка и запуск

```bash
docker compose up --build -d
docker compose ps
```

После сборки можно отдельно проверить безопасный первичный и повторный seed:

```bash
./scripts/test-docker-recovery.sh
```

После запуска доступны:

- сайт: `http://localhost:8080`;
- Strapi admin: `http://localhost:8080/admin`;
- Strapi напрямую: `http://localhost:1337`;
- Nuxt напрямую: `http://localhost:3000`.

Логи:

```bash
docker compose logs -f cms frontend nginx
```

Остановка без удаления данных:

```bash
docker compose down
```

Важно: `docker compose down -v` удалит volumes вместе с рабочей SQLite-базой и
загруженными через Strapi файлами. Перед этой командой сделайте резервную копию.

## Production-контур U2

Production использует отдельный файл `prod-config/docker-compose.yml` и не
публикует порты Strapi/Nuxt. Снаружи доступны только nginx `80/tcp` и `443/tcp`:
основной hostname отдаёт Nuxt, read-only `/uploads` и положительно разрешённый
`/api`, а отдельный административный hostname требует одновременно клиентский
mTLS-сертификат и попадание адреса в IP/VPN allowlist. mTLS не использует
`Authorization`, поэтому Bearer-сессия Strapi передаётся без конфликта.

Текущие Strapi 4.25.1, Nuxt 3, Node 18 и nginx 1.27 сохранены намеренно. Их EOL и
известный остаточный риск приняты ради быстрого восстановления; обновление —
отдельная последующая работа.

### Подготовка production-параметров

1. Скопируйте `.env.production.example` в игнорируемый `.env.production` и
   замените домены и абсолютные пути. Базу и uploads берите только из проверенной
   копии U1; не размещайте единственную копию на VPS. Задайте для этой пары
   уникальный `RECOVERY_GENERATION_ID` (буквы, цифры, `.`, `_`, `-`) и не
   используйте его для другого снимка.
2. Создайте каждый secret-файл из примера с новым случайным значением. Старые
   `APP_KEYS`, salt/JWT secrets, API/transfer tokens и пароли не переносите как
   production-доступы. Файлы должны читаться только root/operator и не лежать в
   репозитории.
3. Создайте read-only Strapi API token только с `find` для `contacts`,
   `site-news-many`, `parquets`, `woods`, `projects`, `type-of-properties` и
   `findOne` для parquets/projects/news. Запись, upload, auth/admin и plugin API
   токену не выдаются. Plain token хранится только в `API_BEARER_TOKEN_FILE` и
   монтируется в server-only Nuxt runtime.
4. Создайте отдельный CA для доступа операторов, выпустите им клиентские
   сертификаты с закрытыми ключами и укажите PEM-сертификат этого CA в
   `ADMIN_CLIENT_CA_FILE`. Закрытый ключ CA на VPS не храните. Создайте allowlist
   из `prod-config/admin-allowlist.conf.example`; последней строкой всегда
   оставляйте `deny all;`.
5. Перед включением `ENFORCE_EMPTY_PUBLIC_ROLE=true` удалите все permissions у
   Strapi Public role. В восстановленном снимке также проверьте и отзовите
   неподтверждённых admin users/sessions, API и transfer tokens, auth providers и
   webhooks. Для первичного закрытого входа можно один раз запустить CMS с
   `ENFORCE_EMPTY_PUBLIC_ROLE=false` только за admin IP/mTLS boundary;
   после очистки верните `true` и пересоздайте CMS. При непустой Public role
   production CMS затем fail-closed не запускается.

Проверка разрешённой конфигурации без production-секретов и сертификатов:

```bash
./scripts/test-deployment-smoke.sh configuration
```

Этот режим разрешает Compose, проверяет, что только nginx публикует 80/443,
проверяет rate/connection limits, TLS/admin boundary и запускает focused tests
API contract, HTML sanitizer, Public role и upload validation.

При первом production-запуске CMS принимает только одновременно пустые volumes
базы и uploads, копирует в них один проверенный снимок и лишь после успешного
копирования записывает одинаковый marker поколения в оба volume. Повторный запуск
разрешён только при совпадении обоих marker с `RECOVERY_GENERATION_ID`. Непустые
volumes без marker, отсутствующий marker или смешанные поколения останавливают
CMS без перезаписи данных; такие volumes нужно сохранить для разбора, а не
очищать автоматически.

### Выпуск и продление TLS

Certbot закреплён на `certbot/certbot:v5.7.0`. До bootstrap создайте каталоги из
`CERTBOT_STATE_DIR` и `CERTBOT_WEBROOT_DIR`, направьте основной, `www` и admin
hostname на VPS, откройте 80/443 и экспортируйте несекретные параметры:

```bash
export DOMAIN=example.com
export ADMIN_DOMAIN=admin.example.com
export CERTBOT_EMAIL=operator@example.com
export CERTBOT_STATE_DIR=/srv/nonna/certbot/state
PRODUCTION_ENV_FILE=.env.production ./prod-config/certbot/bootstrap.sh
```

Bootstrap временно запускает nginx с однодневным self-signed сертификатом,
получает сертификат через webroot, переключает стабильные `active` symlinks и
запускает контейнер renewal. nginx перечитывает обновлённые сертификаты каждый
час без перезапуска приложения. Репетиция продления:

```bash
PRODUCTION_ENV_FILE=.env.production ./prod-config/certbot/bootstrap.sh renewal-test
```

### Запуск и runtime smoke

```bash
docker compose --env-file .env.production -f prod-config/docker-compose.yml up --build -d
docker compose --env-file .env.production -f prod-config/docker-compose.yml ps

SMOKE_BASE_URL=https://example.com \
SMOKE_ADMIN_URL=https://admin.example.com \
SMOKE_ADMIN_CLIENT_CERT=/etc/nonna/operator/client.crt \
SMOKE_ADMIN_CLIENT_KEY=/etc/nonna/operator/client.key \
./scripts/test-deployment-smoke.sh staging
```

Runtime smoke обязательно проверяет все шесть разрешённых коллекций и карточки
паркета, проекта и новости. По умолчанию для карточек используются ID `1` из
проверенного baseline; если на стенде другие опубликованные записи, задайте
`SMOKE_PARQUET_ID`, `SMOKE_PROJECT_ID` и `SMOKE_SITE_NEWS_ID`. Таймауты можно
переопределить через `SMOKE_CONNECT_TIMEOUT_SECONDS` (по умолчанию 5 секунд) и
`SMOKE_MAX_TIME_SECONDS` (по умолчанию 20 секунд).

Для режимов `staging` и `production` клиентский сертификат и ключ обязательны.
Smoke сначала доказывает отказ без клиентского сертификата, затем требует `200`
с сертификатом оператора и тем самым одновременно проверяет mTLS и allowlist.

Strapi сохраняет лимит одного файла 15 MiB. nginx разрешает multipart-запрос до
16 MiB, чтобы служебные поля и границы multipart не отклоняли допустимый файл,
но общий размер запроса оставался ограниченным.

После DNS cutover используйте тот же вызов с режимом `production`. Реальные
domain/TLS проверки требуют VPS и выпущенного сертификата; локально обязательным
является режим `configuration`.
