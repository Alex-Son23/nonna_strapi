#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const ENUM_SORT_STEP = 10
const API_PAGE_SIZE = 250
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const MAX_RETRY_DELAY_MS = 30_000
const REQUEST_ATTEMPTS = 4
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504])

export const PIPELINES = [
  {
    name: 'Поддержка сайтов',
    sort: 200,
    successName: 'Выполнено',
    failureName: 'Отменено',
    requiredStatusNames: ['В очереди', 'В работе'],
    statuses: [
      { name: 'Новая заявка', sort: 10, color: '#98cbff' },
      { name: 'Уточнение задачи', sort: 20, color: '#fffeb2' },
      { name: 'Оценка и согласование', sort: 30, color: '#ffce5a' },
      { name: 'В очереди', sort: 40, color: '#deff81' },
      { name: 'В работе', sort: 50, color: '#87f2c0' },
      { name: 'Ожидаем клиента', sort: 60, color: '#eb93ff' },
      { name: 'Проверка', sort: 70, color: '#f2f3f4' },
      { name: 'Ожидаем подтверждения', sort: 80, color: '#d6eaff' },
    ],
  },
  {
    name: 'Сайты на сопровождении',
    sort: 210,
    successName: 'Сопровождение завершено',
    failureName: 'Договор расторгнут',
    statuses: [
      { name: 'Подключение', sort: 10, color: '#98cbff' },
      { name: 'Активное сопровождение', sort: 20, color: '#87f2c0' },
      { name: 'Ожидается оплата', sort: 30, color: '#fffeb2' },
      { name: 'Продление договора', sort: 40, color: '#ffce5a' },
      { name: 'Приостановлено', sort: 50, color: '#ff8f92' },
    ],
  },
]

export const LEAD_FIELDS = [
  field('Сайт / домен', 'SUPPORT_SITE_DOMAIN', 'text', { required: true }),
  enumField(
    'Тип задачи',
    'SUPPORT_REQUEST_TYPE',
    [
      'Сайт недоступен',
      'Техническая ошибка',
      'Сервер или Docker',
      'Домен или SSL',
      'Резервное копирование',
      'Обновление CMS',
      'Размещение контента',
      'Небольшая доработка',
      'Консультация',
      'Новая функция',
    ],
    { required: true },
  ),
  enumField(
    'Приоритет',
    'SUPPORT_PRIORITY',
    ['P1 — критический', 'P2 — высокий', 'P3 — обычный', 'P4 — плановый'],
    { required: true },
  ),
  enumField('Тариф сопровождения', 'SUPPORT_PLAN', [
    'Минимальный',
    'Стандартный',
    'Индивидуальный',
  ]),
  enumField('Оплата задачи', 'SUPPORT_BILLING', [
    'Входит в тариф',
    'Сверх тарифа',
    'Требует согласования',
  ]),
  field('Предварительная оценка, ч', 'SUPPORT_ESTIMATE_HOURS', 'numeric'),
  field('Срок первой реакции', 'SUPPORT_RESPONSE_DEADLINE', 'date_time'),
  field('Срок выполнения', 'SUPPORT_DUE_AT', 'date_time'),
  field('Фактические трудозатраты, ч', 'SUPPORT_ACTUAL_HOURS', 'numeric'),
  field('Причина задержки', 'SUPPORT_BLOCK_REASON', 'textarea'),
  field('Результат работы', 'SUPPORT_RESULT', 'textarea'),
  field('Материалы по задаче', 'SUPPORT_MATERIALS_URL', 'url'),
  field('Хранилище доступов', 'SUPPORT_VAULT_URL', 'url'),
]

export const COMPANY_FIELDS = [
  field('Сайты / домены', 'SUPPORT_SITES', 'textarea'),
  enumField('Тариф сопровождения', 'SUPPORT_COMPANY_PLAN', [
    'Минимальный',
    'Стандартный',
    'Индивидуальный',
  ]),
  field('Включено часов в месяц', 'SUPPORT_INCLUDED_HOURS', 'numeric'),
  field('Стоимость дополнительного часа', 'SUPPORT_EXTRA_HOUR_PRICE', 'numeric'),
  field('Начало договора', 'SUPPORT_CONTRACT_START', 'date'),
  field('Окончание договора', 'SUPPORT_CONTRACT_END', 'date'),
  field('Следующая оплата', 'SUPPORT_NEXT_PAYMENT', 'date'),
  field('VPS оплачен до', 'SUPPORT_VPS_PAID_UNTIL', 'date'),
  field('Домен оплачен до', 'SUPPORT_DOMAIN_PAID_UNTIL', 'date'),
  field('Хранилище резервных копий', 'SUPPORT_BACKUP_URL', 'url'),
  field('Последняя проверка восстановления', 'SUPPORT_RESTORE_CHECKED_AT', 'date'),
  field('Экстренный контакт', 'SUPPORT_EMERGENCY_CONTACT', 'text'),
]

const MANUAL_CHECKLIST = [
  'Подключить почту, формы и рабочие мессенджеры как источники заявок.',
  'Назначить сотрудников и проверить их права доступа к воронкам.',
  'Создать типы задач: ответ клиенту, выполнение, проверка, напоминание.',
  'Настроить Digital Pipeline: задачи и уведомления на переходах этапов.',
  'Настроить циклические задачи по резервным копиям, оплатам и отчётам.',
  'Не хранить пароли в amoCRM — оставить ссылки на менеджер паролей.',
]

function field(name, code, type, options = {}) {
  return { name, code, type, ...options }
}

function enumField(name, code, values, options = {}) {
  return {
    ...field(name, code, 'select', options),
    enums: values.map((value, index) => ({
      value,
      sort: (index + 1) * ENUM_SORT_STEP,
    })),
  }
}

function normalizeName(value) {
  return value.trim().toLocaleLowerCase('ru-RU')
}

function collection(response, key) {
  return response?._embedded?.[key] ?? []
}

function pipelineStatusKey({ pipeline_id: pipelineId, status_id: statusId }) {
  return `${pipelineId}:${statusId}`
}

function samePipelineStatuses(left, right) {
  const leftStatuses = Array.isArray(left) ? left : []
  const rightStatuses = Array.isArray(right) ? right : []
  if (leftStatuses.length !== rightStatuses.length) return false

  const leftKeys = new Set(leftStatuses.map(pipelineStatusKey))
  return rightStatuses.every((status) =>
    leftKeys.has(pipelineStatusKey(status)),
  )
}

export function hiddenStatusesOutsidePipeline(pipelines, visiblePipelineId) {
  if (!visiblePipelineId) return []

  const hiddenStatuses = new Map()
  for (const pipeline of pipelines) {
    if (!pipeline?.id || pipeline.id === visiblePipelineId) continue

    for (const status of collection(pipeline, 'statuses')) {
      if (!status?.id) continue

      const hiddenStatus = {
        pipeline_id: pipeline.id,
        status_id: status.id,
      }
      hiddenStatuses.set(pipelineStatusKey(hiddenStatus), hiddenStatus)
    }
  }

  return [...hiddenStatuses.values()]
}

export function normalizeBaseUrl(value) {
  let url

  try {
    url = new URL(value)
  } catch {
    throw new Error('AMOCRM_BASE_URL должен быть корректным URL аккаунта amoCRM.')
  }

  if (url.protocol !== 'https:') {
    throw new Error('AMOCRM_BASE_URL должен использовать HTTPS.')
  }

  if (!/^[a-z0-9-]+\.amocrm\.(ru|com)$/i.test(url.hostname)) {
    throw new Error('AMOCRM_BASE_URL должен указывать на домен аккаунта amoCRM.')
  }

  return url.origin
}

export class AmoCrmApi {
  constructor({
    baseUrl,
    accessToken,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  }) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.accessToken = accessToken
    this.fetchImpl = fetchImpl
    this.requestTimeoutMs = requestTimeoutMs
    this.sleep = sleep

    if (!accessToken) {
      throw new Error('Не задан AMOCRM_ACCESS_TOKEN.')
    }

    if (typeof fetchImpl !== 'function') {
      throw new Error('Для запуска требуется Node.js 18 или новее.')
    }

    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error('Тайм-аут запроса должен быть положительным числом.')
    }

    if (typeof sleep !== 'function') {
      throw new Error('Функция ожидания между запросами должна быть функцией.')
    }
  }

  async request(method, path, body) {
    const safeToRetry = method === 'GET'

    for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
      const controller = new AbortController()
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, this.requestTimeoutMs)
      let response
      let transportError

      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Accept: 'application/hal+json',
            Authorization: `Bearer ${this.accessToken}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          signal: controller.signal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      } catch (error) {
        transportError = error
      } finally {
        clearTimeout(timeout)
      }

      if (transportError) {
        const reason = timedOut
          ? `превысил тайм-аут ${this.requestTimeoutMs} мс`
          : `завершился сетевой ошибкой: ${transportError.message}`

        if (!safeToRetry) {
          throw mutationRetryError(method, path, reason, transportError)
        }

        if (attempt < REQUEST_ATTEMPTS) {
          await this.sleep(fallbackRetryDelayMs(attempt))
          continue
        }

        throw new Error(
          `amoCRM API: ${method} ${path} ${reason} после ${REQUEST_ATTEMPTS} попыток.`,
          { cause: transportError },
        )
      }

      if (response.ok) {
        if (response.status === 204) return null
        return response.json()
      }

      if (RETRYABLE_STATUS_CODES.has(response.status)) {
        if (!safeToRetry) {
          const details = await readErrorBody(response)
          throw mutationRetryError(
            method,
            path,
            `вернул ${response.status}${details ? ` — ${details}` : ''}`,
          )
        }

        if (attempt < REQUEST_ATTEMPTS) {
          await this.sleep(retryDelayMs(response, attempt))
          continue
        }
      }

      const details = await readErrorBody(response)
      throw new Error(
        `amoCRM API: ${method} ${path} вернул ${response.status}${details ? ` — ${details}` : ''}`,
      )
    }

    throw new Error(`amoCRM API: исчерпаны попытки запроса ${method} ${path}.`)
  }
}

function fallbackRetryDelayMs(attempt) {
  return attempt * 750
}

function retryDelayMs(response, attempt) {
  const value = response.headers.get('retry-after')
  if (typeof value !== 'string' || value.trim() === '') {
    return fallbackRetryDelayMs(attempt)
  }

  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) {
    return fallbackRetryDelayMs(attempt)
  }

  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS)
}

function mutationRetryError(method, path, reason, cause) {
  return new Error(
    `amoCRM API: ${method} ${path} ${reason}. Изменение могло быть применено; повторите запуск скрипта, чтобы перечитать состояние без риска дублирования.`,
    cause ? { cause } : undefined,
  )
}

async function readErrorBody(response) {
  const contentType = response.headers.get('content-type') ?? ''

  try {
    if (contentType.includes('json')) {
      const payload = await response.json()
      return payload.detail ?? payload.title ?? JSON.stringify(payload)
    }

    return (await response.text()).trim()
  } catch {
    return ''
  }
}

async function listAll(api, path, embeddedKey) {
  const items = []

  for (let page = 1; ; page += 1) {
    const separator = path.includes('?') ? '&' : '?'
    const response = await api.request(
      'GET',
      `${path}${separator}limit=${API_PAGE_SIZE}&page=${page}`,
    )
    const pageItems = collection(response, embeddedKey)
    items.push(...pageItems)

    if (pageItems.length < API_PAGE_SIZE || !response?._links?.next) break
  }

  return items
}

export async function ensurePipeline(
  api,
  definition,
  { apply, log, existingPipelines },
) {
  const pipelines =
    existingPipelines ??
    collection(await api.request('GET', '/api/v4/leads/pipelines'), 'pipelines')
  const matches = pipelines.filter(
    ({ name }) => normalizeName(name) === normalizeName(definition.name),
  )

  if (matches.length > 1) {
    throw new Error(`Найдено несколько воронок с именем «${definition.name}».`)
  }

  let pipeline = matches[0]

  if (!pipeline) {
    log(`${apply ? 'Создаю' : 'Будет создана'} воронка «${definition.name}».`)

    if (!apply) {
      return {
        id: null,
        name: definition.name,
        _embedded: { statuses: definition.statuses },
        planned: true,
        plannedStatuses: definition.statuses.map(({ name }) => name),
      }
    }

    const createResponse = await api.request('POST', '/api/v4/leads/pipelines', [
      {
        name: definition.name,
        sort: definition.sort,
        is_main: false,
        is_unsorted_on: false,
        _embedded: {
          statuses: [
            ...definition.statuses,
            { id: 142, name: definition.successName },
            { id: 143, name: definition.failureName },
          ],
        },
      },
    ])
    pipeline = collection(createResponse, 'pipelines')[0]

    if (!pipeline) {
      throw new Error(`amoCRM не вернула созданную воронку «${definition.name}».`)
    }

    return pipeline
  }

  const existingNames = new Set(
    collection(pipeline, 'statuses').map(({ name }) => normalizeName(name)),
  )
  const missingStatuses = definition.statuses.filter(
    ({ name }) => !existingNames.has(normalizeName(name)),
  )

  if (missingStatuses.length === 0) {
    log(`Воронка «${definition.name}» уже настроена.`)
    return pipeline
  }

  log(
    `${apply ? 'Добавляю' : 'Будут добавлены'} этапы в «${definition.name}»: ${missingStatuses
      .map(({ name }) => name)
      .join(', ')}.`,
  )

  if (!apply) {
    return {
      ...pipeline,
      plannedStatuses: missingStatuses.map(({ name }) => name),
    }
  }

  const createResponse = await api.request(
    'POST',
    `/api/v4/leads/pipelines/${pipeline.id}/statuses`,
    missingStatuses,
  )
  const createdStatuses = collection(createResponse, 'statuses')

  if (createdStatuses.length !== missingStatuses.length) {
    throw new Error(
      `amoCRM вернула ${createdStatuses.length} из ${missingStatuses.length} созданных этапов для «${definition.name}».`,
    )
  }

  return {
    ...pipeline,
    _embedded: {
      ...pipeline._embedded,
      statuses: [...collection(pipeline, 'statuses'), ...createdStatuses],
    },
  }
}

async function ensureFieldGroup(api, entity, name, { apply, log }) {
  const path = `/api/v4/${entity}/custom_fields/groups`
  const response = await api.request('GET', path)
  const groups = collection(response, 'custom_field_groups')
  const matches = groups.filter(
    (group) => normalizeName(group.name) === normalizeName(name),
  )

  if (matches.length > 1) {
    throw new Error(`Найдено несколько групп полей «${name}» для ${entity}.`)
  }

  if (matches[0]) {
    log(`Группа полей «${name}» уже существует.`)
    return matches[0]
  }

  log(`${apply ? 'Создаю' : 'Будет создана'} группа полей «${name}».`)
  if (!apply) return null

  await api.request('POST', path, [{ name, sort: 500 }])
  const refreshed = await api.request('GET', path)
  const created = collection(refreshed, 'custom_field_groups').find(
    (group) => normalizeName(group.name) === normalizeName(name),
  )

  if (!created) {
    throw new Error(`amoCRM не вернула созданную группу полей «${name}».`)
  }

  return created
}

export async function ensureCustomFields(
  api,
  entity,
  definitions,
  {
    apply,
    groupId,
    requiredStatuses,
    hiddenStatuses,
    visibilityPending = false,
    log,
  },
) {
  const path = `/api/v4/${entity}/custom_fields`
  const existingFields = await listAll(api, path, 'custom_fields')
  const fieldsByCode = new Map()
  const fieldsByName = new Map()
  for (const existing of existingFields) {
    if (existing.code && !fieldsByCode.has(existing.code)) {
      fieldsByCode.set(existing.code, existing)
    }
    const normalizedName = normalizeName(existing.name)
    if (!fieldsByName.has(normalizedName)) {
      fieldsByName.set(normalizedName, existing)
    }
  }
  const missing = []
  const updates = []

  for (const definition of definitions) {
    const existing = fieldsByCode.get(definition.code)
    const nameMatch = fieldsByName.get(normalizeName(definition.name))

    if (!existing && nameMatch) {
      const actualCode = nameMatch.code
        ? `имеет код "${nameMatch.code}"`
        : 'не имеет кода'
      throw new Error(
        `Поле с именем «${definition.name}» уже существует и ${actualCode}. Ожидался код "${definition.code}"; поле не принадлежит этой настройке.`,
      )
    }

    if (existing) {
      if (existing.type !== definition.type) {
        throw new Error(
          `Поле «${definition.name}» уже существует с типом "${existing.type}" вместо "${definition.type}".`,
        )
      }

      if (
        hiddenStatuses !== undefined &&
        !samePipelineStatuses(existing.hidden_statuses, hiddenStatuses)
      ) {
        updates.push({
          id: existing.id,
          name: existing.name,
          hidden_statuses: hiddenStatuses,
        })
      }
      continue
    }

    missing.push({
      name: definition.name,
      code: definition.code,
      type: definition.type,
      sort: 500 + missing.length * 10,
      ...(groupId ? { group_id: groupId } : {}),
      ...(definition.enums ? { enums: definition.enums } : {}),
      ...(definition.required && requiredStatuses.length > 0
        ? { required_statuses: requiredStatuses }
        : {}),
      ...(hiddenStatuses === undefined
        ? {}
        : { hidden_statuses: hiddenStatuses }),
    })
  }

  if (missing.length === 0 && updates.length === 0) {
    if (!visibilityPending) log(`Поля ${entity} уже настроены.`)
    return {
      created: 0,
      updated: 0,
      existing: definitions.length,
      ...(visibilityPending ? { visibilityPending: true } : {}),
    }
  }

  if (missing.length > 0) {
    log(
      `${apply ? 'Создаю' : 'Будут созданы'} поля ${entity}: ${missing
        .map(({ name }) => name)
        .join(', ')}.`,
    )
  }

  if (updates.length > 0) {
    log(
      `${apply ? 'Обновляю' : 'Будет обновлена'} видимость ${updates.length} полей ${entity}.`,
    )
  }

  if (apply && missing.length > 0) await api.request('POST', path, missing)
  if (apply && updates.length > 0) await api.request('PATCH', path, updates)

  return {
    created: missing.length,
    updated: updates.length,
    existing: definitions.length - missing.length,
    ...(visibilityPending ? { visibilityPending: true } : {}),
  }
}

function requiredSupportStatuses(pipeline, definition) {
  if (!pipeline?.id) return []

  const requiredNames = new Set(definition.requiredStatusNames.map(normalizeName))
  return collection(pipeline, 'statuses')
    .filter(({ name }) => requiredNames.has(normalizeName(name)))
    .map(({ id }) => ({ pipeline_id: pipeline.id, status_id: id }))
}

function mergePipelines(...pipelineCollections) {
  const pipelinesById = new Map()
  for (const pipelines of pipelineCollections) {
    for (const pipeline of pipelines) {
      if (pipeline?.id) pipelinesById.set(pipeline.id, pipeline)
    }
  }
  return [...pipelinesById.values()]
}

export async function configureSupportDepartment(
  api,
  { apply = false, log = console.log } = {},
) {
  log(apply ? 'Режим применения изменений.' : 'Режим проверки: изменений не будет.')

  const pipelinesResponse = await api.request('GET', '/api/v4/leads/pipelines')
  const existingPipelines = collection(pipelinesResponse, 'pipelines')
  const configuredPipelines = []
  for (const definition of PIPELINES) {
    configuredPipelines.push(
      await ensurePipeline(api, definition, { apply, log, existingPipelines }),
    )
  }

  const leadGroup = await ensureFieldGroup(api, 'leads', 'Поддержка сайтов', {
    apply,
    log,
  })
  const companyGroup = await ensureFieldGroup(
    api,
    'companies',
    'Сопровождение сайтов',
    { apply, log },
  )

  const supportPipeline = configuredPipelines[0]
  const allPipelines = mergePipelines(existingPipelines, configuredPipelines)
  const hiddenLeadStatuses = supportPipeline?.id
    ? hiddenStatusesOutsidePipeline(allPipelines, supportPipeline.id)
    : undefined
  const leadVisibilityPending =
    !apply &&
    configuredPipelines.some(
      (pipeline) =>
        pipeline?.planned || (pipeline?.plannedStatuses?.length ?? 0) > 0,
    )
  if (leadVisibilityPending) {
    log(
      'Видимость полей сделок будет синхронизирована после создания запланированных воронок и этапов.',
    )
  }
  const fieldResults = {
    leads: await ensureCustomFields(api, 'leads', LEAD_FIELDS, {
      apply,
      groupId: leadGroup?.id,
      requiredStatuses: requiredSupportStatuses(supportPipeline, PIPELINES[0]),
      hiddenStatuses: hiddenLeadStatuses,
      visibilityPending: leadVisibilityPending,
      log,
    }),
    companies: await ensureCustomFields(api, 'companies', COMPANY_FIELDS, {
      apply,
      groupId: companyGroup?.id,
      requiredStatuses: [],
      log,
    }),
  }

  log('\nОстаётся настроить вручную:')
  MANUAL_CHECKLIST.forEach((item, index) => log(`${index + 1}. ${item}`))

  return {
    apply,
    pipelines: configuredPipelines.map(
      ({ id, name, planned = false, plannedStatuses = [] }) => ({
        id,
        name,
        planned,
        plannedStatuses,
      }),
    ),
    fields: fieldResults,
    manualChecklist: MANUAL_CHECKLIST,
  }
}

function baseUrlFromEnvironment(env) {
  if (env.AMOCRM_BASE_URL) return env.AMOCRM_BASE_URL
  if (!env.AMOCRM_SUBDOMAIN) {
    throw new Error('Задайте AMOCRM_BASE_URL или AMOCRM_SUBDOMAIN.')
  }

  const tld = env.AMOCRM_TLD || 'ru'
  return `https://${env.AMOCRM_SUBDOMAIN}.amocrm.${tld}`
}

function printUsage() {
  console.log(`Использование:
  node scripts/amocrm/setup-support.mjs          # только показать изменения
  node scripts/amocrm/setup-support.mjs --apply  # применить изменения

Переменные окружения:
  AMOCRM_BASE_URL=https://example.amocrm.ru
  AMOCRM_ACCESS_TOKEN=<долгосрочный токен администратора>

Вместо AMOCRM_BASE_URL можно указать AMOCRM_SUBDOMAIN и AMOCRM_TLD=ru|com.`)
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const allowed = new Set(['--apply', '--dry-run', '--help', '-h'])
  const unknown = [...args].filter((argument) => !allowed.has(argument))

  if (unknown.length > 0) {
    throw new Error(`Неизвестные аргументы: ${unknown.join(', ')}`)
  }

  if (args.has('--help') || args.has('-h')) {
    printUsage()
    return
  }

  if (args.has('--apply') && args.has('--dry-run')) {
    throw new Error('Используйте либо --apply, либо --dry-run.')
  }

  const api = new AmoCrmApi({
    baseUrl: baseUrlFromEnvironment(process.env),
    accessToken: process.env.AMOCRM_ACCESS_TOKEN,
  })

  await configureSupportDepartment(api, { apply: args.has('--apply') })
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  main().catch((error) => {
    console.error(`Ошибка: ${error.message}`)
    process.exitCode = 1
  })
}
