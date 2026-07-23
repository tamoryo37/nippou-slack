'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Readable } = require('node:stream');
const {
  DEFAULT_NOTION_MAPPING,
  NOTION_VERSION,
  exchangeNotionCode,
  fetchTaskItems,
  generateNotionAuthUrl,
  normalizeTaskSource,
  refreshNotionConnection,
  resolveNotionDatabase,
  revokeNotionConnection,
} = require('../services/tasks');

const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status || 200,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

function notionProperties(values) {
  return {
    タスク名: {
      type: 'title',
      title: [{ type: 'text', plain_text: values.title }],
    },
    ステータス: {
      type: 'status',
      status: { name: values.done ? '完了' : '次にやる' },
    },
    予定日時: {
      type: 'date',
      date: values.scheduledDate ? { start: values.scheduledDate } : null,
    },
    期限: {
      type: 'date',
      date: values.dueDate ? { start: values.dueDate } : null,
    },
    完了日時: {
      type: 'date',
      date: values.completedAt ? { start: values.completedAt } : null,
    },
    区分: {
      type: 'select',
      select: { name: values.work === false ? '個人・家族' : '仕事' },
    },
    日報出力: {
      type: 'checkbox',
      checkbox: values.reportable !== false,
    },
    機密区分: {
      type: 'select',
      select: values.confidentiality ? { name: values.confidentiality } : null,
    },
  };
}

test('normalizes the default Notion mapping and database URL', () => {
  const source = normalizeTaskSource({
    provider: 'notion',
    connection: { accessToken: 'secret-access' },
    databaseUrl: 'https://www.notion.so/team/Tasks-ee60ae1d24b6488b820bb58c4666c1ae?v=1234567890abcdef1234567890abcdef',
  });

  assert.equal(source.databaseId, 'ee60ae1d-24b6-488b-820b-b58c4666c1ae');
  assert.deepEqual(source.mapping, DEFAULT_NOTION_MAPPING);
  assert.equal(source.connection.accessToken, 'secret-access');
});

test('prefers a hyphenated Notion database ID in the path over the view ID', () => {
  const source = normalizeTaskSource({
    provider: 'notion',
    connection: { accessToken: 'secret-access' },
    databaseUrl: 'https://www.notion.so/team/Tasks-ee60ae1d-24b6-488b-820b-b58c4666c1ae?v=1234567890abcdef1234567890abcdef',
  });

  assert.equal(source.databaseId, 'ee60ae1d-24b6-488b-820b-b58c4666c1ae');
});

test('generic JSON feed returns only reportable work tasks on the requested dates', async () => {
  const document = {
    version: 1,
    tasks: [
      {
        title: '提案書を提出',
        done: true,
        completedAt: '2026-07-16T15:30:00.000Z',
        category: 'work',
        reportable: true,
      },
      {
        title: '顧客定例',
        done: false,
        scheduledDate: '2026-07-20',
        category: 'work',
        reportable: true,
      },
      {
        title: '請求書',
        completed: false,
        dueDate: '2026-07-20',
        category: 'work',
        reportable: true,
      },
      {
        title: '過去日報時点では未完了',
        status: 'done',
        completedAt: '2026-07-20T18:00:00+09:00',
        scheduledDate: '2026-07-20',
        category: 'work',
        reportable: true,
      },
      {
        title: '期限切れ',
        done: false,
        dueDate: '2026-07-19',
        category: 'work',
        reportable: true,
      },
      {
        title: '個人の用事',
        done: false,
        scheduledDate: '2026-07-20',
        category: 'personal',
        reportable: true,
      },
      {
        title: '秘密の作業',
        done: true,
        completedAt: '2026-07-17',
        category: 'work',
        reportable: true,
        confidentiality: 'vault参照のみ',
      },
    ],
  };

  let requested;
  const result = await fetchTaskItems(
    { provider: 'json', url: 'https://tasks.example.com/nippou.json', bearerToken: 'private' },
    '2026-07-17',
    '2026-07-20',
    {
      dnsLookup: PUBLIC_DNS,
      fetchImpl: async (url, init) => {
        requested = { url, init };
        return jsonResponse(document);
      },
    },
  );

  assert.equal(requested.url, 'https://tasks.example.com/nippou.json');
  assert.equal(requested.init.redirect, 'manual');
  assert.equal(requested.init.headers.Authorization, 'Bearer private');
  assert.deepEqual(result, {
    done: ['・提案書を提出'],
    will: ['・顧客定例', '・請求書', '・過去日報時点では未完了'],
  });
});

test('generic feed includes overdue due dates only when explicitly enabled', async () => {
  const fetchImpl = async () => jsonResponse({
    version: 1,
    tasks: [{
      title: '期限切れ',
      done: false,
      dueDate: '2026-07-19',
      category: 'work',
      reportable: true,
    }],
  });

  const result = await fetchTaskItems(
    { provider: 'json', url: 'https://tasks.example.com/feed' },
    '2026-07-17',
    '2026-07-20',
    { dnsLookup: PUBLIC_DNS, fetchImpl, includeOverdueDueDates: true },
  );
  assert.deepEqual(result.will, ['・期限切れ']);
});

test('generic feed blocks unsafe URLs and private DNS results before fetching', async () => {
  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    return jsonResponse({ version: 1, tasks: [] });
  };

  await assert.rejects(
    fetchTaskItems(
      { provider: 'json', url: 'http://tasks.example.com/feed' },
      '2026-07-17',
      '2026-07-20',
      { fetchImpl, dnsLookup: PUBLIC_DNS },
    ),
    /must use HTTPS/,
  );
  await assert.rejects(
    fetchTaskItems(
      { provider: 'json', url: 'https://127.0.0.1/feed' },
      '2026-07-17',
      '2026-07-20',
      { fetchImpl, dnsLookup: PUBLIC_DNS },
    ),
    /must use a hostname/,
  );
  await assert.rejects(
    fetchTaskItems(
      { provider: 'json', url: 'https://tasks.example.com/feed' },
      '2026-07-17',
      '2026-07-20',
      {
        fetchImpl,
        dnsLookup: async () => [{ address: '169.254.169.254', family: 4 }],
      },
    ),
    /non-public address/,
  );
  assert.equal(fetchCalled, false);
});

test('generic feed pins the HTTPS connection to the public address already inspected', async () => {
  const publicAddress = '93.184.216.34';
  let dnsCalls = 0;
  let requestDetails;

  const result = await fetchTaskItems(
    { provider: 'json', url: 'https://tasks.example.com/feed' },
    '2026-07-17',
    '2026-07-20',
    {
      dnsLookup: async () => {
        dnsCalls += 1;
        return dnsCalls === 1
          ? [{ address: publicAddress, family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }];
      },
      httpsRequestImpl: (url, requestOptions, onResponse) => {
        const request = new EventEmitter();
        request.destroy = () => {};
        request.end = () => {
          requestOptions.lookup(url.hostname, {}, (error, address, family) => {
            assert.ifError(error);
            requestDetails = {
              hostname: url.hostname,
              address,
              family,
              servername: requestOptions.servername,
              agent: requestOptions.agent,
              hostHeader: requestOptions.headers.Host,
            };
          });

          const response = Readable.from([
            Buffer.from(JSON.stringify({ version: 1, tasks: [] })),
          ]);
          response.statusCode = 200;
          response.headers = { 'content-type': 'application/json' };
          process.nextTick(() => onResponse(response));
        };
        return request;
      },
    },
  );

  assert.deepEqual(result, { done: [], will: [] });
  assert.equal(dnsCalls, 1);
  assert.deepEqual(requestDetails, {
    hostname: 'tasks.example.com',
    address: publicAddress,
    family: 4,
    servername: 'tasks.example.com',
    agent: false,
    hostHeader: undefined,
  });
});

test('generic feed timeout remains active until the HTTPS response body completes', async () => {
  await assert.rejects(
    fetchTaskItems(
      { provider: 'json', url: 'https://tasks.example.com/feed' },
      '2026-07-17',
      '2026-07-20',
      {
        dnsLookup: PUBLIC_DNS,
        timeoutMs: 20,
        httpsRequestImpl: (_url, _requestOptions, onResponse) => {
          const request = new EventEmitter();
          request.destroy = () => {};
          request.end = () => {
            const response = new PassThrough();
            response.statusCode = 200;
            response.headers = { 'content-type': 'application/json' };
            response.write('{"version":1,"tasks":[');
            process.nextTick(() => onResponse(response));
          };
          return request;
        },
      },
    ),
    /Task feed request failed/,
  );
});

test('generic feed validates redirects and never forwards a token to another origin', async () => {
  const requests = [];
  const result = await fetchTaskItems(
    { provider: 'json', url: 'https://start.example.com/feed', bearerToken: 'do-not-leak' },
    '2026-07-17',
    '2026-07-20',
    {
      dnsLookup: PUBLIC_DNS,
      fetchImpl: async (url, init) => {
        requests.push({ url, authorization: init.headers.Authorization });
        if (requests.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.example.com/feed.json' },
          });
        }
        return jsonResponse({ version: 1, tasks: [] });
      },
    },
  );

  assert.deepEqual(result, { done: [], will: [] });
  assert.deepEqual(requests, [
    { url: 'https://start.example.com/feed', authorization: 'Bearer do-not-leak' },
    { url: 'https://cdn.example.com/feed.json', authorization: undefined },
  ]);
});

test('generic feed enforces the response size limit', async () => {
  await assert.rejects(
    fetchTaskItems(
      { provider: 'json', url: 'https://tasks.example.com/feed' },
      '2026-07-17',
      '2026-07-20',
      {
        dnsLookup: PUBLIC_DNS,
        maxResponseBytes: 20,
        fetchImpl: async () => new Response('{"version":1,"tasks":[]}', {
          headers: { 'content-length': '999' },
        }),
      },
    ),
    /too large/,
  );
});

test('Notion task provider queries data sources with the pinned API version', async () => {
  const requests = [];
  const donePage = {
    id: 'done-page',
    properties: notionProperties({
      title: '提案書を完成',
      done: true,
      completedAt: '2026-07-17',
    }),
  };
  const privatePage = {
    id: 'private-page',
    properties: notionProperties({
      title: '私用',
      done: true,
      completedAt: '2026-07-17',
      work: false,
    }),
  };
  const willPage = {
    id: 'will-page',
    properties: notionProperties({
      title: '次回提案の準備',
      done: false,
      scheduledDate: '2026-07-20',
    }),
  };
  const completedLaterPage = {
    id: 'completed-later-page',
    properties: notionProperties({
      title: '過去日報時点では未完了',
      done: true,
      scheduledDate: '2026-07-20',
      completedAt: '2026-07-20',
    }),
  };
  const vaultPage = {
    id: 'vault-page',
    properties: notionProperties({
      title: '秘密',
      done: false,
      dueDate: '2026-07-20',
      confidentiality: 'vault参照のみ',
    }),
  };

  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, init, body });
    const isDoneQuery = body.filter.property === '完了日時';
    return jsonResponse({
      results: isDoneQuery
        ? [donePage, privatePage]
        : [willPage, completedLaterPage, vaultPage],
      has_more: false,
      next_cursor: null,
    });
  };

  const result = await fetchTaskItems(
    {
      provider: 'notion',
      connection: { accessToken: 'notion-secret' },
      dataSourceId: '880fb84d-db0f-4a30-bdf8-7f77d5bcbbd7',
    },
    '2026-07-17',
    '2026-07-20',
    { fetchImpl },
  );

  assert.deepEqual(result, {
    done: ['・提案書を完成'],
    will: ['・次回提案の準備', '・過去日報時点では未完了'],
  });
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(
      request.url,
      'https://api.notion.com/v1/data_sources/880fb84d-db0f-4a30-bdf8-7f77d5bcbbd7/query',
    );
    assert.equal(request.init.headers.Authorization, 'Bearer notion-secret');
    assert.equal(request.init.headers['Notion-Version'], NOTION_VERSION);
    assert.equal(request.init.redirect, 'manual');
  }
  assert.deepEqual(requests[1].body.filter, {
    or: [
      { property: '予定日時', date: { equals: '2026-07-20' } },
      { property: '期限', date: { equals: '2026-07-20' } },
    ],
  });
});

test('Notion OAuth exchange, refresh, and revoke keep secrets out of URLs', async () => {
  const options = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://nippou.example.com/notion/callback',
  };
  const authUrl = new URL(generateNotionAuthUrl('signed-state', options));
  assert.equal(authUrl.searchParams.get('client_id'), 'client-id');
  assert.equal(authUrl.searchParams.get('state'), 'signed-state');
  assert.equal(authUrl.searchParams.get('redirect_uri'), options.redirectUri);
  assert.equal(authUrl.toString().includes('client-secret'), false);

  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    if (url.endsWith('/oauth/revoke')) return jsonResponse({});
    if (requests.length === 1) {
      return jsonResponse({
        access_token: 'access-one',
        refresh_token: 'refresh-one',
        token_type: 'bearer',
        workspace_id: 'workspace',
      });
    }
    return jsonResponse({
      access_token: 'access-two',
      refresh_token: 'refresh-two',
      token_type: 'bearer',
    });
  };

  const connection = await exchangeNotionCode('authorization-code', { ...options, fetchImpl });
  assert.equal(connection.accessToken, 'access-one');
  assert.equal(connection.refreshToken, 'refresh-one');

  const refreshed = await refreshNotionConnection(connection, { ...options, fetchImpl });
  assert.equal(refreshed.accessToken, 'access-two');
  assert.equal(refreshed.refreshToken, 'refresh-two');

  assert.equal(await revokeNotionConnection(refreshed, { ...options, fetchImpl }), true);
  assert.deepEqual(requests.map((entry) => entry.body.grant_type || 'revoke'), [
    'authorization_code',
    'refresh_token',
    'revoke',
  ]);
  assert.equal(requests.every((entry) => !entry.url.includes('access-')), true);
  assert.equal(requests[0].init.headers['Notion-Version'], NOTION_VERSION);
});

test('resolveNotionDatabase returns its first accessible data source and property types', async () => {
  const calls = [];
  const result = await resolveNotionDatabase(
    'notion-token',
    'https://www.notion.so/Tasks-ee60ae1d24b6488b820bb58c4666c1ae',
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (url.includes('/databases/')) {
          return jsonResponse({
            title: [{ plain_text: 'マスタータスク' }],
            data_sources: [{
              id: '880fb84d-db0f-4a30-bdf8-7f77d5bcbbd7',
              name: 'マスタータスク',
            }],
          });
        }
        return jsonResponse({
          properties: {
            タスク名: { type: 'title' },
            ステータス: { type: 'status' },
          },
        });
      },
    },
  );

  assert.deepEqual(result, {
    databaseId: 'ee60ae1d-24b6-488b-820b-b58c4666c1ae',
    dataSourceId: '880fb84d-db0f-4a30-bdf8-7f77d5bcbbd7',
    title: 'マスタータスク',
    properties: [
      { name: 'タスク名', type: 'title' },
      { name: 'ステータス', type: 'status' },
    ],
  });
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.init.headers.Authorization === 'Bearer notion-token'), true);
});
