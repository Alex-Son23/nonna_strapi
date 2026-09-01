# Nonna — восстановление и эксплуатация

Этот репозиторий содержит Docker-окружение сайта-визитки Nonna:

- Nuxt-фронтенд находится в сабмодуле `nonna.ru`;
- Strapi хранит мультиязычный контент;
- nginx принимает внешний HTTP/HTTPS-трафик;
- Certbot выпускает и продлевает сертификаты Let's Encrypt.

Production-адреса:

- сайт: `https://nonna.design`;
- админка: `https://admin.nonna.design/admin`;
- текущая VPS: `89.108.83.239`;
- каталог приложения на VPS: `/srv/nonna/app`;
- ветка развертывания: `codex/docker-local-stack`.

Пароли, API-токены, Strapi secrets, `.env.production`, база и uploads никогда не
добавляются в Git.

## Быстрый локальный запуск

```bash
git submodule update --init --recursive
cp .env.docker.example .env
cp cms/.env.example cms/.env
docker compose up --build -d
docker compose ps
```

Локальные адреса:

- сайт: `http://localhost:8080`;
- Strapi: `http://localhost:8080/admin`.

Подробности локального и production-окружения находятся в [DOCKER.md](DOCKER.md).

## Полное восстановление на новой VPS

### 1. DNS и сервер

Создайте три A-записи, указывающие на новую VPS:

```text
@      -> IP_VPS
www    -> IP_VPS
admin  -> IP_VPS
```

На сервере должны быть установлены Git, Docker Engine и Docker Compose. Откройте
в firewall порты `22`, `80` и `443`.

### 2. Получение кода

```bash
mkdir -p /srv/nonna
cd /srv/nonna
git clone --branch codex/docker-local-stack --recurse-submodules \
  https://github.com/Alex-Son23/nonna_strapi.git app
cd /srv/nonna/app
git submodule sync --recursive
git submodule update --init --recursive
```

### 3. Production-параметры и secrets

```bash
cp .env.production.example .env.production
mkdir -p /etc/nonna/secrets
chmod 700 /etc/nonna/secrets
```

В `.env.production` укажите `nonna.design`, `admin.nonna.design`, каталоги
Certbot и абсолютные пути к secret-файлам. На время создания первого
администратора оставьте:

```dotenv
ENFORCE_EMPTY_PUBLIC_ROLE=false
```

Создайте новые случайные значения для файлов:

```text
/etc/nonna/secrets/app-keys
/etc/nonna/secrets/api-token-salt
/etc/nonna/secrets/admin-jwt-secret
/etc/nonna/secrets/transfer-token-salt
/etc/nonna/secrets/jwt-secret
/etc/nonna/secrets/read-only-api-token
```

Для пяти одиночных secrets подходит вывод `openssl rand -base64 32`.
`app-keys` должен содержать четыре случайных значения через запятую. До создания
настоящего API-токена запишите в `read-only-api-token` временное непустое
случайное значение. Установите права:

```bash
chmod 600 /etc/nonna/secrets/*
```

### 4. Первый запуск Strapi

```bash
docker compose --env-file .env.production \
  -f prod-config/docker-compose.yml up --build -d cms
```

Создайте администратора командой из раздела «Подготовка production-параметров»
в [DOCKER.md](DOCKER.md), затем убедитесь, что `/admin/init` возвращает
`hasAdmin: true`.

### 5. HTTPS

После обновления DNS запустите bootstrap Certbot:

```bash
export DOMAIN=nonna.design
export ADMIN_DOMAIN=admin.nonna.design
export CERTBOT_EMAIL=operator@example.com
export CERTBOT_STATE_DIR=/srv/nonna/certbot/state
PRODUCTION_ENV_FILE=.env.production ./prod-config/certbot/bootstrap.sh
```

Скрипт сам использует временный self-signed сертификат, получает сертификат
Let's Encrypt и включает автоматическое продление.

Админка открыта для всех по URL, но вход возможен только по логину и паролю
Strapi. mTLS, IP-фильтрации и дополнительного Basic Auth нет.

### 6. Read-only API-токен для сайта

Это обязательный шаг. Без него `/api/*` возвращает `401`, а контакты, проекты и
коллекции не появляются на сайте.

В `https://admin.nonna.design/admin` откройте:

```text
Settings -> API Tokens -> Create new API Token
```

Параметры токена:

- имя: `frontend-readonly`;
- тип: `Custom`;
- срок действия: без ограничения;
- разрешения только на чтение:
  - Contact: `find`;
  - Site news: `find`, `findOne`;
  - Parquet: `find`, `findOne`;
  - Wood: `find`;
  - Project: `find`, `findOne`;
  - Type of property: `find`.

Не выдавайте токену права `create`, `update`, `delete`, upload, auth, admin или
plugin API. Strapi показывает plain token только один раз. Сохраните его только
в файл, указанный как `API_BEARER_TOKEN_FILE` (сейчас
`/etc/nonna/secrets/read-only-api-token`), установите права `600` и пересоздайте
frontend:

```bash
docker compose --env-file .env.production \
  -f prod-config/docker-compose.yml up -d --force-recreate --no-deps frontend
docker compose --env-file .env.production \
  -f prod-config/docker-compose.yml up -d --wait --no-deps frontend
```

Проверка:

```bash
curl -i 'https://nonna.design/api/contacts?locale=ru&populate=*'
curl -i 'https://nonna.design/api/contacts?locale=en&populate=*'
```

Оба запроса должны вернуть `200`, а не `401`.

### 7. Завершение запуска

Удалите все permissions у роли Strapi `Public`, установите в
`.env.production`:

```dotenv
ENFORCE_EMPTY_PUBLIC_ROLE=true
```

Затем запустите весь контур:

```bash
docker compose --env-file .env.production \
  -f prod-config/docker-compose.yml up --build -d
docker compose --env-file .env.production \
  -f prod-config/docker-compose.yml ps
```

## Наполнение Strapi

Контент восстанавливается вручную через админку. Для мультиязычных типов:

1. Создайте запись в локали `ru`.
2. Создайте связанную локализацию `en`.
3. Нажмите `Publish` для каждой локали отдельно.
4. Проверьте соответствующий API-запрос с `locale=ru` и `locale=en`.

Если запись есть в админке, но отсутствует на сайте, проверяйте по порядку:

1. Запись опубликована, а не сохранена как draft.
2. Созданы нужные локали `ru` и `en`.
3. `/api/...` возвращает `200`, а не `401`.
4. Read-only token содержит нужный `find`/`findOne` permission.
5. После замены token-файла frontend был пересоздан.

Поля CKEditor сохраняют разрешённый HTML, включая абзацы и переносы строк.
Frontend очищает опасные теги и атрибуты перед выводом.

### Автоматическое восстановление каталога паркета

Исходные данные 33 позиций и их переводы хранятся в
`cms/scripts/content/parquets.json`. Для каждой позиции создаются связанные
русская и английская записи. Фотографии скачиваются из указанной в каталоге
папки Яндекс Диска, приводятся к JPEG размером не более 2400 px и загружаются в
медиатеку Strapi.

Подготовьте фотографии в отдельном локальном каталоге, чтобы они сохранились
после завершения одноразового контейнера:

```bash
mkdir -p /tmp/nonna-parquet-media
docker compose run --rm --no-deps \
  -v /tmp/nonna-parquet-media:/opt/import-media \
  cms node scripts/import-parquets.js \
  --prepare-media --media-dir /opt/import-media
```

Перед импортом с `--replace` обязательно сделайте резервную копию базы и
`uploads` по инструкции ниже и остановите основной контейнер CMS. Затем
импортируйте обе локали и опубликуйте записи:

```bash
docker compose stop cms
docker compose run --rm --no-deps \
  -v /tmp/nonna-parquet-media:/opt/import-media:ro \
  cms node scripts/import-parquets.js \
  --import --replace --publish --media-dir /opt/import-media
docker compose up -d cms frontend nginx
```

Флаг `--replace` удаляет только лишние русские и английские записи паркета.
Общие справочники (`country`, `wood`, `color`, `coating`) и другие типы контента
он не удаляет. Без `--publish` новые записи остаются черновиками. Повторный
запуск обновляет существующие позиции и не создаёт копии.

Проверка результата:

```bash
curl -fsS 'http://localhost:8080/api/parquets?locale=ru&populate=*'
curl -fsS 'http://localhost:8080/api/parquets?locale=en&populate=*'
```

В каждой локали должно быть 33 опубликованные записи, у каждой — основное фото
и два дополнительных. В разделе «Все» сайт показывает 31 уникальный дизайн:
две позиции входят сразу в две коллекции и поэтому представлены в CMS дважды.

На VPS используются те же команды с production compose-файлом и
`--env-file .env.production`. После успешного импорта сразу сделайте новую
внешнюю резервную копию базы и `uploads`: ссылка Яндекс Диска не является
долговременным резервным хранилищем.

## Видео страницы «О фабрике»

Файлы находятся в сабмодуле:

```text
nonna.ru/public/IMG_0821.mp4  # русский
nonna.ru/public/IMG_0819.mp4  # английский
```

На странице `/about` выбирается русский файл, на `/en/about` — английский.
Перед добавлением в Git видео нужно подготовить для веба: MP4, H.264/AAC,
`faststart`, размер меньше 100 МБ.

## Обычное обновление VPS

```bash
cd /srv/nonna/app
git pull --ff-only
git submodule sync --recursive
git submodule update --init --recursive
docker compose --env-file .env.production \
  -f prod-config/docker-compose.yml up --build -d
docker compose --env-file .env.production \
  -f prod-config/docker-compose.yml ps
```

Не используйте `docker compose down -v`: параметр `-v` удалит базу и uploads.

## Что обязательно резервировать

Git хранит только код и структуру CMS. Для восстановления контента нужны
отдельные резервные копии:

- SQLite: `/opt/app/.tmp/data.db` из volume `strapi_database`;
- медиатека: `/opt/app/public/uploads` из volume `strapi_uploads`;
- `/etc/nonna/secrets`;
- `.env.production`;
- при необходимости `/srv/nonna/certbot/state` — сертификат также можно
  перевыпустить.

Перед копированием SQLite остановите запись в CMS:

```bash
cd /srv/nonna/app
docker compose --env-file .env.production \
  -f prod-config/docker-compose.yml stop frontend cms
```

Скопируйте `data.db` и весь каталог uploads из остановленного CMS-контейнера в
датированный backup-каталог:

```bash
backup_dir=/srv/nonna/backups/YYYY-MM-DD-HHMM
mkdir -p "$backup_dir"
cms_container=$(docker compose --env-file .env.production \
  -f prod-config/docker-compose.yml ps -aq cms)
docker cp "$cms_container:/opt/app/.tmp/data.db" "$backup_dir/data.db"
docker cp "$cms_container:/opt/app/public/uploads" "$backup_dir/uploads"
cp .env.production "$backup_dir/env.production"
```

Затем снова запустите сервисы:

```bash
docker compose --env-file .env.production \
  -f prod-config/docker-compose.yml up -d cms frontend
```

Резервная копия должна храниться вне VPS. Снимок только на том же сервере не
поможет при повторном удалении VPS. Secrets копируйте отдельно в зашифрованное
хранилище, а не в Git и не в незашифрованный общий архив.

Для восстановления сохранённой базы на новой VPS сначала создайте контейнеры,
не запуская их, затем скопируйте данные обратно:

```bash
docker compose --env-file .env.production \
  -f prod-config/docker-compose.yml build cms
docker compose --env-file .env.production \
  -f prod-config/docker-compose.yml create cms
cms_container=$(docker compose --env-file .env.production \
  -f prod-config/docker-compose.yml ps -aq cms)
docker cp /path/to/backup/data.db "$cms_container:/opt/app/.tmp/data.db"
docker cp /path/to/backup/uploads/. "$cms_container:/opt/app/public/uploads/"
docker compose --env-file .env.production \
  -f prod-config/docker-compose.yml run --rm --no-deps --entrypoint sh cms \
  -c 'chown -R node:node /opt/app/.tmp /opt/app/public/uploads'
docker compose --env-file .env.production \
  -f prod-config/docker-compose.yml up -d
```

При восстановлении базы обязательно используйте сохранённые Strapi secrets,
особенно `API_TOKEN_SALT`. После восстановления проверьте read-only токен; если
он утерян, создайте новый и пересоздайте frontend.

## Проверки

Локальная проверка конфигурации:

```bash
./scripts/test-deployment-smoke.sh configuration
```

Production smoke после наполнения базы:

```bash
SMOKE_BASE_URL=https://nonna.design \
SMOKE_ADMIN_URL=https://admin.nonna.design \
./scripts/test-deployment-smoke.sh production
```

Полезные команды:

```bash
docker compose --env-file .env.production \
  -f prod-config/docker-compose.yml ps
docker compose --env-file .env.production \
  -f prod-config/docker-compose.yml logs --tail=200 cms frontend nginx
```
