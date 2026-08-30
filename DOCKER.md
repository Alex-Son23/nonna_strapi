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
`/api`, а отдельный административный hostname отдаёт штатную страницу входа
Strapi. Фильтрации по IP, клиентских сертификатов и дополнительного Basic Auth
нет: страницу может открыть любой пользователь, но войти в админку можно только
по логину и паролю администратора Strapi.

Текущие Strapi 4.25.1, Nuxt 3, Node 18 и nginx 1.27 сохранены намеренно. Их EOL и
известный остаточный риск приняты ради быстрого восстановления; обновление —
отдельная последующая работа.

### Подготовка production-параметров

1. Скопируйте `.env.production.example` в игнорируемый `.env.production` и
   замените домены и абсолютные пути. Файлы локальной SQLite-базы и uploads на
   VPS не копируются. Оставьте `ENFORCE_EMPTY_PUBLIC_ROLE=false` только на время
   первичной настройки новой CMS.
2. Создайте каждый secret-файл из примера с новым случайным значением. Старые
   `APP_KEYS`, salt/JWT secrets, API/transfer tokens и пароли не переносите как
   production-доступы. Файлы должны читаться только root/operator и не лежать в
   репозитории. До создания настоящего API token запишите в
   `API_BEARER_TOKEN_FILE` любое новое случайное непустое значение: оно нужно
   только для первого запуска frontend и не даст доступ к Strapi.
3. По SSH запустите только CMS, без публичного nginx. Strapi создаст таблицы из
   схем в `cms/src/api` в новом именованном volume `strapi_database`; сервис при
   этом останется доступен только внутри закрытой Docker-сети:

   ```bash
   docker compose --env-file .env.production -f prod-config/docker-compose.yml up --build -d cms
   ```

4. Там же, по SSH, создайте первого администратора и сразу проверьте, что
   `/admin/init` возвращает `hasAdmin: true`:

   ```bash
   docker compose --env-file .env.production -f prod-config/docker-compose.yml exec \
     -e ADMIN_EMAIL=admin@example.com \
     -e ADMIN_PASSWORD='replace-with-strong-password' \
     cms docker-entrypoint.sh sh -c '
       mkdir -p /tmp/strapi-cli-config
       XDG_CONFIG_HOME=/tmp/strapi-cli-config \
         ./node_modules/.bin/strapi admin:create-user \
         --email="$ADMIN_EMAIL" \
         --password="$ADMIN_PASSWORD" \
         --firstname=Site \
         --lastname=Admin
     '

   docker compose --env-file .env.production -f prod-config/docker-compose.yml exec cms \
     node -e "fetch('http://127.0.0.1:1337/admin/init').then(r => r.json()).then(body => { console.log(JSON.stringify(body)); if (!(body.hasAdmin ?? body.data?.hasAdmin)) process.exit(1) })"
   ```

   Не запускайте nginx и TLS bootstrap, пока эта проверка не завершилась успешно:
   иначе свежая Strapi откроет в интернете форму создания первого администратора.
5. После успешной проверки выпустите TLS и запустите публичный контур по
   инструкции ниже. Войдите на административном домене под созданным логином и
   паролем. Удалите все permissions у Strapi Public role, затем создайте новый
   API token только с `find` для `contacts`, `site-news-many`, `parquets`,
   `woods`, `projects`, `type-of-properties` и `findOne` для
   parquets/projects/news. Запись, upload, auth/admin и plugin API токену не
   выдаются. Замените временное значение в `API_BEARER_TOKEN_FILE` настоящим
   plain token.
6. Установите `ENFORCE_EMPTY_PUBLIC_ROLE=true` и пересоздайте контейнеры. При
   непустой Public role production CMS теперь fail-closed не запускается.

Проверка разрешённой конфигурации без production-секретов и сертификатов:

```bash
./scripts/test-deployment-smoke.sh configuration
```

Этот режим разрешает Compose, проверяет, что только nginx публикует 80/443,
проверяет rate/connection limits, TLS/admin boundary, отсутствие IP-фильтра,
клиентских сертификатов и Basic Auth, а также запускает focused tests API
contract, HTML sanitizer, Public role и upload validation.

Production Compose не монтирует seed-базу и seed-uploads. На новой VPS он создаёт
два пустых именованных volume; при первом запуске Strapi создаёт в SQLite только
актуальную структуру и необходимые системные записи. После этого контент и файлы
добавляются заново через админку. Если на VPS уже существуют volumes с такими же
именами, сначала разберитесь, кому принадлежат данные: Compose намеренно не
очищает и не перезаписывает их автоматически.

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

Запускайте bootstrap только после создания первого администратора и успешной
проверки `hasAdmin: true`: bootstrap поднимает публичный nginx.

Bootstrap временно запускает nginx с однодневным self-signed сертификатом,
получает сертификат через webroot, переключает стабильные `active` symlinks и
запускает контейнер renewal. nginx перечитывает обновлённые сертификаты каждый
час без перезапуска приложения. Репетиция продления:

```bash
PRODUCTION_ENV_FILE=.env.production ./prod-config/certbot/bootstrap.sh renewal-test
```

### Запуск и runtime smoke

После создания первого администратора и выпуска TLS запустите полный контур:

```bash
docker compose --env-file .env.production -f prod-config/docker-compose.yml up --build -d
docker compose --env-file .env.production -f prod-config/docker-compose.yml ps

SMOKE_BASE_URL=https://example.com \
SMOKE_ADMIN_URL=https://admin.example.com \
SMOKE_EXPECT_EMPTY_CMS=true \
./scripts/test-deployment-smoke.sh staging
```

Runtime smoke обязательно проверяет все шесть разрешённых коллекций и карточки
паркета, проекта и новости. При `SMOKE_EXPECT_EMPTY_CMS=true` каждая коллекция
должна вернуть пустой массив для локалей `ru` и `en`, а карточки — `404`;
так проверяется отсутствие перенесённого контента. После наполнения базы уберите
этот параметр: коллекции и карточки должны вернуть `200`. Если у новых
опубликованных записей другие ID,
задайте `SMOKE_PARQUET_ID`, `SMOKE_PROJECT_ID` и `SMOKE_SITE_NEWS_ID`. Таймауты
можно переопределить через `SMOKE_CONNECT_TIMEOUT_SECONDS` (по умолчанию 5
секунд) и `SMOKE_MAX_TIME_SECONDS` (по умолчанию 20 секунд).

Для режимов `staging` и `production` smoke требует, чтобы страница входа Strapi
на административном домене открывалась без клиентского сертификата с кодом `200`,
`/admin/init` подтверждал наличие администратора, а Strapi API был недоступен на
административном hostname.

Strapi сохраняет лимит одного файла 15 MiB. nginx разрешает multipart-запрос до
16 MiB, чтобы служебные поля и границы multipart не отклоняли допустимый файл,
но общий размер запроса оставался ограниченным.

После DNS cutover используйте тот же вызов с режимом `production`. Реальные
domain/TLS проверки требуют VPS и выпущенного сертификата; локально обязательным
является режим `configuration`.

Публичные серверные сертификаты основного и административного доменов выпускает
Let's Encrypt, поэтому браузерам не требуется вручную устанавливать сертификаты.
