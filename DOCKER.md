# Локальный запуск Nonna в Docker

Стек состоит из Strapi, Nuxt и nginx. Основная точка входа — `http://localhost:8080`.

Файлы `dev-config/docker-compose.yml` и `prod-config/docker-compose.yml` оставлены
только как совместимые входы в этот же локальный стек. Они не являются готовой
production-конфигурацией с доменом, TLS и firewall.

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
