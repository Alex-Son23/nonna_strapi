import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AmoCrmApi,
  COMPANY_FIELDS,
  LEAD_FIELDS,
  PIPELINES,
  configureSupportDepartment,
  ensureCustomFields,
  ensurePipeline,
  hiddenStatusesOutsidePipeline,
  normalizeBaseUrl,
} from './setup-support.mjs'

function createHttpApi({ fetchImpl, requestTimeoutMs = 100, sleep }) {
  return new AmoCrmApi({
    baseUrl: 'https://example.amocrm.ru',
    accessToken: 'test-token',
    fetchImpl,
    requestTimeoutMs,
    sleep: sleep ?? (() => Promise.resolve()),
  })
}

function jsonResponse(status, payload = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function createApi(handler) {
  const calls = []

  return {
    calls,
    async request(method, path, body) {
      calls.push({ method, path, body })
      return handler({ method, path, body, calls })
    },
  }
}

function existingPipeline(definition, id, firstStatusId) {
  return {
    id,
    name: definition.name,
    _embedded: {
      statuses: [
        ...definition.statuses.map((status, index) => ({
          ...status,
          id: firstStatusId + index,
        })),
        { id: 142, name: definition.successName },
        { id: 143, name: definition.failureName },
      ],
    },
  }
}

function existingFields(definitions, options = {}) {
  return definitions.map((definition, index) => ({
    id: index + 1,
    code: definition.code,
    name: definition.name,
    type: definition.type,
    ...options,
  }))
}

test('configuration uses unique field codes and pipeline names', () => {
  assert.equal(new Set(PIPELINES.map(({ name }) => name)).size, PIPELINES.length)

  for (const fields of [LEAD_FIELDS, COMPANY_FIELDS]) {
    assert.equal(new Set(fields.map(({ code }) => code)).size, fields.length)
  }

  const allowedColors = new Set([
    '#fffeb2',
    '#fffd7f',
    '#fff000',
    '#ffeab2',
    '#ffdc7f',
    '#ffce5a',
    '#ffdbdb',
    '#ffc8c8',
    '#ff8f92',
    '#d6eaff',
    '#c1e0ff',
    '#98cbff',
    '#ebffb1',
    '#deff81',
    '#87f2c0',
    '#f9deff',
    '#f3beff',
    '#ccc8f9',
    '#eb93ff',
    '#f2f3f4',
    '#e6e8ea',
  ])
  for (const pipeline of PIPELINES) {
    for (const status of pipeline.statuses) {
      assert.equal(allowedColors.has(status.color), true, status.color)
    }
  }

  const supportPipeline = PIPELINES[0]
  const supportStatusNames = new Set(
    supportPipeline.statuses.map(({ name }) => name),
  )
  assert.equal(supportPipeline.requiredStatusNames.length > 0, true)
  for (const name of supportPipeline.requiredStatusNames) {
    assert.equal(supportStatusNames.has(name), true, name)
  }
})

test('normalizeBaseUrl accepts only an amoCRM HTTPS account URL', () => {
  assert.equal(
    normalizeBaseUrl('https://example.amocrm.ru/'),
    'https://example.amocrm.ru',
  )
  assert.equal(
    normalizeBaseUrl('https://example.amocrm.com'),
    'https://example.amocrm.com',
  )

  assert.throws(() => normalizeBaseUrl('http://example.amocrm.ru'), /HTTPS/)
  assert.throws(() => normalizeBaseUrl('https://example.org'), /amoCRM/)
})

test('AmoCrmApi aborts a mutating request after its deadline', async () => {
  let calls = 0
  const api = createHttpApi({
    requestTimeoutMs: 5,
    fetchImpl: (_url, { signal }) => {
      calls += 1
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    },
  })

  await assert.rejects(
    api.request('POST', '/api/v4/leads/pipelines', [{}]),
    /превысил тайм-аут 5 мс.*повторите запуск скрипта/,
  )
  assert.equal(calls, 1)
})

test('AmoCrmApi retries GET after 503 but never retries POST', async () => {
  let getCalls = 0
  const getApi = createHttpApi({
    fetchImpl: async () => {
      getCalls += 1
      return getCalls === 1
        ? jsonResponse(503, { detail: 'temporarily unavailable' })
        : jsonResponse(200, { ok: true })
    },
  })

  assert.deepEqual(await getApi.request('GET', '/api/v4/leads/pipelines'), {
    ok: true,
  })
  assert.equal(getCalls, 2)

  let postCalls = 0
  const postApi = createHttpApi({
    fetchImpl: async () => {
      postCalls += 1
      return jsonResponse(503, { detail: 'temporarily unavailable' })
    },
  })

  await assert.rejects(
    postApi.request('POST', '/api/v4/leads/pipelines', [{}]),
    /вернул 503.*повторите запуск скрипта/,
  )
  assert.equal(postCalls, 1)
})

test('AmoCrmApi retries a rejected GET but never retries a rejected POST', async () => {
  let getCalls = 0
  const getApi = createHttpApi({
    fetchImpl: async () => {
      getCalls += 1
      if (getCalls === 1) throw new Error('socket closed')
      return jsonResponse(200, { ok: true })
    },
  })

  assert.deepEqual(await getApi.request('GET', '/api/v4/leads/pipelines'), {
    ok: true,
  })
  assert.equal(getCalls, 2)

  let postCalls = 0
  const postApi = createHttpApi({
    fetchImpl: async () => {
      postCalls += 1
      throw new Error('socket closed')
    },
  })

  await assert.rejects(
    postApi.request('POST', '/api/v4/leads/pipelines', [{}]),
    /сетевой ошибкой: socket closed.*повторите запуск скрипта/,
  )
  assert.equal(postCalls, 1)
})

test('AmoCrmApi uses fallback delay when 429 has no Retry-After header', async () => {
  let calls = 0
  const delays = []
  const api = createHttpApi({
    fetchImpl: async () => {
      calls += 1
      return calls === 1
        ? jsonResponse(429, { detail: 'rate limited' })
        : jsonResponse(200, { ok: true })
    },
    sleep: async (delayMs) => delays.push(delayMs),
  })

  assert.deepEqual(await api.request('GET', '/api/v4/leads/pipelines'), {
    ok: true,
  })
  assert.deepEqual(delays, [750])
})

test('ensurePipeline creates a missing pipeline with all configured statuses', async () => {
  const api = createApi(({ method, path, body }) => {
    if (method === 'GET' && path === '/api/v4/leads/pipelines') {
      return { _embedded: { pipelines: [] } }
    }

    if (method === 'POST' && path === '/api/v4/leads/pipelines') {
      return {
        _embedded: {
          pipelines: [
            {
              ...body[0],
              id: 501,
              _embedded: {
                statuses: body[0]._embedded.statuses.map((status, index) => ({
                  ...status,
                  id: status.id ?? 1000 + index,
                })),
              },
            },
          ],
        },
      }
    }

    throw new Error(`Unexpected request: ${method} ${path}`)
  })

  const pipeline = await ensurePipeline(api, PIPELINES[0], {
    apply: true,
    log: () => {},
  })

  assert.equal(pipeline.id, 501)
  const createCall = api.calls.find(({ method }) => method === 'POST')
  assert.equal(createCall.body[0].name, 'Поддержка сайтов')
  assert.equal(
    createCall.body[0]._embedded.statuses.length,
    PIPELINES[0].statuses.length + 2,
  )
})

test('ensurePipeline adds only missing editable statuses', async () => {
  const definition = PIPELINES[0]
  const existingStatus = {
    id: 701,
    name: definition.statuses[0].name,
    sort: definition.statuses[0].sort,
    color: definition.statuses[0].color,
  }
  let statuses = [existingStatus]

  const api = createApi(({ method, path, body }) => {
    if (method === 'GET' && path === '/api/v4/leads/pipelines') {
      return {
        _embedded: {
          pipelines: [
            {
              id: 601,
              name: definition.name,
              _embedded: { statuses },
            },
          ],
        },
      }
    }

    if (
      method === 'POST' &&
      path === '/api/v4/leads/pipelines/601/statuses'
    ) {
      const created = body.map((status, index) => ({ ...status, id: 800 + index }))
      statuses = [...statuses, ...created]
      return { _embedded: { statuses: created } }
    }

    throw new Error(`Unexpected request: ${method} ${path}`)
  })

  const pipeline = await ensurePipeline(api, definition, {
    apply: true,
    log: () => {},
  })

  const createCall = api.calls.find(({ method }) => method === 'POST')
  assert.equal(createCall.body.length, definition.statuses.length - 1)
  assert.equal(pipeline._embedded.statuses.length, definition.statuses.length)
})

test('ensureCustomFields is idempotent and rejects a type conflict', async () => {
  const existingFields = LEAD_FIELDS.map((field, index) => ({
    id: index + 1,
    code: field.code,
    name: field.name,
    type: field.type,
  }))
  const api = createApi(({ method, path }) => {
    if (method === 'GET' && path.startsWith('/api/v4/leads/custom_fields')) {
      return { _embedded: { custom_fields: existingFields } }
    }

    throw new Error(`Unexpected request: ${method} ${path}`)
  })

  const result = await ensureCustomFields(api, 'leads', LEAD_FIELDS, {
    apply: true,
    groupId: 'leads_support',
    requiredStatuses: [],
    log: () => {},
  })

  assert.equal(result.created, 0)
  assert.equal(api.calls.filter(({ method }) => method === 'POST').length, 0)

  const conflicting = createApi(({ method, path }) => {
    if (method === 'GET' && path.startsWith('/api/v4/leads/custom_fields')) {
      return {
        _embedded: {
          custom_fields: [
            {
              id: 99,
              code: LEAD_FIELDS[0].code,
              name: LEAD_FIELDS[0].name,
              type: 'numeric',
            },
          ],
        },
      }
    }

    throw new Error(`Unexpected request: ${method} ${path}`)
  })

  await assert.rejects(
    ensureCustomFields(conflicting, 'leads', [LEAD_FIELDS[0]], {
      apply: true,
      groupId: 'leads_support',
      requiredStatuses: [],
      log: () => {},
    }),
    /с типом "numeric"/,
  )
})

test('ensureCustomFields rejects same-name fields it does not own', async () => {
  for (const code of ['SALES_PRIORITY', undefined]) {
    const api = createApi(({ method, path }) => {
      if (method === 'GET' && path.startsWith('/api/v4/leads/custom_fields')) {
        return {
          _embedded: {
            custom_fields: [
              {
                id: 99,
                code,
                name: LEAD_FIELDS[0].name,
                type: LEAD_FIELDS[0].type,
              },
            ],
          },
        }
      }

      throw new Error(`Unexpected request: ${method} ${path}`)
    })

    await assert.rejects(
      ensureCustomFields(api, 'leads', [LEAD_FIELDS[0]], {
        apply: true,
        groupId: 'leads_support',
        requiredStatuses: [],
        hiddenStatuses: [{ pipeline_id: 200, status_id: 201 }],
        log: () => {},
      }),
      /не принадлежит этой настройке/,
    )
    assert.equal(api.calls.some(({ method }) => method !== 'GET'), false)
  }
})

test('hiddenStatusesOutsidePipeline hides every status outside the target pipeline', () => {
  const pipelines = [
    {
      id: 100,
      _embedded: {
        statuses: [
          { id: 101, name: 'В очереди' },
          { id: 102, name: 'В работе' },
        ],
      },
    },
    {
      id: 200,
      _embedded: {
        statuses: [
          { id: 201, name: 'Новая заявка' },
          { id: 202, name: 'Закрыто' },
        ],
      },
    },
  ]

  assert.deepEqual(hiddenStatusesOutsidePipeline(pipelines, 100), [
    { pipeline_id: 200, status_id: 201 },
    { pipeline_id: 200, status_id: 202 },
  ])
})

test('ensureCustomFields creates and updates pipeline visibility', async () => {
  const hiddenStatuses = [
    { pipeline_id: 200, status_id: 201 },
    { pipeline_id: 200, status_id: 202 },
  ]
  let existingFields = []
  const api = createApi(({ method, path, body }) => {
    if (method === 'GET' && path.startsWith('/api/v4/leads/custom_fields')) {
      return { _embedded: { custom_fields: existingFields } }
    }

    if (method === 'POST' && path === '/api/v4/leads/custom_fields') {
      assert.deepEqual(body[0].hidden_statuses, hiddenStatuses)
      existingFields = [
        {
          id: 501,
          code: LEAD_FIELDS[0].code,
          name: LEAD_FIELDS[0].name,
          type: LEAD_FIELDS[0].type,
          hidden_statuses: body[0].hidden_statuses,
        },
      ]
      return { _embedded: { custom_fields: existingFields } }
    }

    if (method === 'PATCH' && path === '/api/v4/leads/custom_fields') {
      assert.equal(
        body.every(({ name }) => typeof name === 'string' && name.length > 0),
        true,
      )
      assert.deepEqual(body, [
        {
          id: 501,
          name: LEAD_FIELDS[0].name,
          hidden_statuses: hiddenStatuses,
        },
      ])
      existingFields[0].hidden_statuses = body[0].hidden_statuses
      return { _embedded: { custom_fields: existingFields } }
    }

    throw new Error(`Unexpected request: ${method} ${path}`)
  })

  const created = await ensureCustomFields(api, 'leads', [LEAD_FIELDS[0]], {
    apply: true,
    groupId: 'leads_support',
    requiredStatuses: [],
    hiddenStatuses,
    log: () => {},
  })
  assert.deepEqual(created, { created: 1, updated: 0, existing: 0 })

  existingFields[0].hidden_statuses = null
  const updated = await ensureCustomFields(api, 'leads', [LEAD_FIELDS[0]], {
    apply: true,
    groupId: 'leads_support',
    requiredStatuses: [],
    hiddenStatuses,
    log: () => {},
  })
  assert.deepEqual(updated, { created: 0, updated: 1, existing: 1 })

  const unchanged = await ensureCustomFields(api, 'leads', [LEAD_FIELDS[0]], {
    apply: true,
    groupId: 'leads_support',
    requiredStatuses: [],
    hiddenStatuses,
    log: () => {},
  })
  assert.deepEqual(unchanged, { created: 0, updated: 0, existing: 1 })
  assert.equal(api.calls.filter(({ method }) => method === 'PATCH').length, 1)
})

test('configureSupportDepartment dry-run performs reads without writes', async () => {
  const api = createApi(({ method, path }) => {
    assert.equal(method, 'GET')

    if (path === '/api/v4/leads/pipelines') {
      return { _embedded: { pipelines: [] } }
    }
    if (path.endsWith('/custom_fields/groups')) {
      return { _embedded: { custom_field_groups: [] } }
    }
    if (path.includes('/custom_fields?')) {
      return { _embedded: { custom_fields: [] } }
    }

    throw new Error(`Unexpected request: ${method} ${path}`)
  })

  const result = await configureSupportDepartment(api, {
    apply: false,
    log: () => {},
  })

  assert.equal(result.apply, false)
  assert.equal(result.pipelines.every(({ planned }) => planned), true)
  assert.equal(api.calls.some(({ method }) => method !== 'GET'), false)
})

test('configureSupportDepartment reports pending visibility for a planned status', async () => {
  const supportPipeline = existingPipeline(PIPELINES[0], 100, 1000)
  const managedPipeline = existingPipeline(PIPELINES[1], 200, 2000)
  const missingStatus = managedPipeline._embedded.statuses.splice(
    PIPELINES[1].statuses.length - 1,
    1,
  )[0]
  const hiddenStatuses = managedPipeline._embedded.statuses.map(({ id }) => ({
    pipeline_id: managedPipeline.id,
    status_id: id,
  }))
  const logs = []
  const api = createApi(({ method, path }) => {
    assert.equal(method, 'GET')

    if (path === '/api/v4/leads/pipelines') {
      return {
        _embedded: { pipelines: [supportPipeline, managedPipeline] },
      }
    }
    if (path === '/api/v4/leads/custom_fields/groups') {
      return {
        _embedded: {
          custom_field_groups: [{ id: 'leads_support', name: 'Поддержка сайтов' }],
        },
      }
    }
    if (path === '/api/v4/companies/custom_fields/groups') {
      return {
        _embedded: {
          custom_field_groups: [
            { id: 'companies_support', name: 'Сопровождение сайтов' },
          ],
        },
      }
    }
    if (path.startsWith('/api/v4/leads/custom_fields?')) {
      return {
        _embedded: {
          custom_fields: existingFields(LEAD_FIELDS, {
            hidden_statuses: hiddenStatuses,
          }),
        },
      }
    }
    if (path.startsWith('/api/v4/companies/custom_fields?')) {
      return {
        _embedded: { custom_fields: existingFields(COMPANY_FIELDS) },
      }
    }

    throw new Error(`Unexpected request: ${method} ${path}`)
  })

  const result = await configureSupportDepartment(api, {
    apply: false,
    log: (message) => logs.push(message),
  })

  assert.deepEqual(result.pipelines[1].plannedStatuses, [missingStatus.name])
  assert.equal(result.fields.leads.visibilityPending, true)
  assert.equal(
    logs.some((message) => message.includes('будет синхронизирована')),
    true,
  )
  assert.equal(logs.includes('Поля leads уже настроены.'), false)
  assert.equal(api.calls.some(({ method }) => method !== 'GET'), false)
})

test('configureSupportDepartment applies lead-only pipeline visibility', async () => {
  const supportPipeline = existingPipeline(PIPELINES[0], 100, 1000)
  const managedPipeline = existingPipeline(PIPELINES[1], 200, 2000)
  const pipelines = [supportPipeline, managedPipeline]
  const api = createApi(({ method, path, body }) => {
    if (method === 'GET' && path === '/api/v4/leads/pipelines') {
      return { _embedded: { pipelines } }
    }
    if (method === 'GET' && path === '/api/v4/leads/custom_fields/groups') {
      return {
        _embedded: {
          custom_field_groups: [{ id: 'leads_support', name: 'Поддержка сайтов' }],
        },
      }
    }
    if (
      method === 'GET' &&
      path === '/api/v4/companies/custom_fields/groups'
    ) {
      return {
        _embedded: {
          custom_field_groups: [
            { id: 'companies_support', name: 'Сопровождение сайтов' },
          ],
        },
      }
    }
    if (method === 'GET' && path.includes('/custom_fields?')) {
      return { _embedded: { custom_fields: [] } }
    }
    if (method === 'POST' && path.endsWith('/custom_fields')) {
      return { _embedded: { custom_fields: body } }
    }

    throw new Error(`Unexpected request: ${method} ${path}`)
  })

  await configureSupportDepartment(api, { apply: true, log: () => {} })

  const expectedHiddenStatuses = managedPipeline._embedded.statuses.map(
    ({ id }) => ({ pipeline_id: managedPipeline.id, status_id: id }),
  )
  const leadCreate = api.calls.find(
    ({ method, path }) =>
      method === 'POST' && path === '/api/v4/leads/custom_fields',
  )
  const companyCreate = api.calls.find(
    ({ method, path }) =>
      method === 'POST' && path === '/api/v4/companies/custom_fields',
  )

  assert.equal(leadCreate.body.length, LEAD_FIELDS.length)
  for (const { hidden_statuses: statuses } of leadCreate.body) {
    assert.deepEqual(statuses, expectedHiddenStatuses)
  }
  assert.equal(companyCreate.body.length, COMPANY_FIELDS.length)
  assert.equal(
    companyCreate.body.every(
      (field) => !Object.hasOwn(field, 'hidden_statuses'),
    ),
    true,
  )
})
