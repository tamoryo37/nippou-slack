'use strict';

const { lookup: defaultDnsLookup } = require('node:dns/promises');
const { request: defaultHttpsRequest } = require('node:https');
const { isIP } = require('node:net');

const NOTION_API_BASE_URL = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';
const TASK_FEED_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_NOTION_QUERY_PAGES = 10;

const DEFAULT_NOTION_MAPPING = Object.freeze({
  title: 'タスク名',
  status: 'ステータス',
  completedStatus: '完了',
  scheduledDate: '予定日時',
  dueDate: '期限',
  completedAt: '完了日時',
  category: '区分',
  workCategory: '仕事',
  reportable: '日報出力',
  confidentiality: '機密区分',
  excludedConfidentiality: 'vault参照のみ',
});

class TaskSourceHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TaskSourceHttpError';
    this.status = status;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function optionalTrimmedString(value, label) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} must not be empty`);
  return normalized;
}

function requiredTrimmedString(value, label) {
  const normalized = optionalTrimmedString(value, label);
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeNotionId(value, label) {
  if (value === undefined || value === null || value === '') return '';
  const raw = requiredTrimmedString(value, label).replace(/-/g, '');
  if (!/^[a-f0-9]{32}$/i.test(raw)) {
    throw new TypeError(`${label} must be a valid Notion ID`);
  }
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    raw.slice(12, 16),
    raw.slice(16, 20),
    raw.slice(20),
  ].join('-').toLowerCase();
}

function extractNotionId(databaseUrl) {
  const raw = requiredTrimmedString(databaseUrl, 'Notion database URL');
  if (/^[a-f0-9-]{32,36}$/i.test(raw)) {
    return normalizeNotionId(raw, 'Notion database ID');
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError('Notion database URL is invalid');
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new TypeError('Notion database URL must be an HTTPS URL without credentials or a fragment');
  }

  // Notionの `?v=` はビューIDなので、DB IDを含むパスを必ず優先する。
  const notionIdPattern = /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-f0-9]{32}/ig;
  const pathMatches = parsed.pathname.match(notionIdPattern);
  const matches = pathMatches && pathMatches.length > 0
    ? pathMatches
    : parsed.search.match(notionIdPattern);
  if (!matches || matches.length === 0) {
    throw new TypeError('Notion database URL does not contain a database ID');
  }
  return normalizeNotionId(matches[matches.length - 1], 'Notion database ID');
}

function normalizeNotionMapping(mapping) {
  if (mapping !== undefined && !isPlainObject(mapping)) {
    throw new TypeError('Notion property mapping must be an object');
  }

  const input = mapping || {};
  const normalized = {};
  for (const key of Object.keys(DEFAULT_NOTION_MAPPING)) {
    normalized[key] = requiredTrimmedString(
      input[key] === undefined ? DEFAULT_NOTION_MAPPING[key] : input[key],
      `Notion mapping.${key}`,
    );
  }
  return normalized;
}

function validateFeedUrlStructure(value) {
  const raw = requiredTrimmedString(value, 'Task feed URL');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError('Task feed URL is invalid');
  }

  if (parsed.protocol !== 'https:') {
    throw new TypeError('Task feed URL must use HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('Task feed URL must not contain credentials');
  }
  if (parsed.hash) {
    throw new TypeError('Task feed URL must not contain a fragment');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    throw new TypeError('Task feed URL must use a hostname, not an IP address');
  }
  if (hostname.toLowerCase() === 'localhost' || hostname.toLowerCase().endsWith('.localhost')) {
    throw new TypeError('Task feed URL hostname is not allowed');
  }
  return parsed;
}

function normalizeTaskSource(source) {
  if (source === undefined || source === null || source === false) {
    return { provider: 'none', enabled: false };
  }
  if (!isPlainObject(source)) throw new TypeError('Task source must be an object');

  if (source.enabled === false) return { provider: 'none', enabled: false };
  const providerValue = firstString(source.provider, source.type).toLowerCase();
  const provider = providerValue === 'generic'
    || providerValue === 'json_feed'
    || providerValue === 'json-feed'
    ? 'json'
    : providerValue;

  if (!provider || provider === 'none') return { provider: 'none', enabled: false };

  if (provider === 'notion') {
    const connection = isPlainObject(source.connection) ? source.connection : {};
    const accessToken = firstString(
      connection.accessToken,
      connection.access_token,
      source.accessToken,
      source.access_token,
    );
    const refreshToken = firstString(
      connection.refreshToken,
      connection.refresh_token,
      source.refreshToken,
      source.refresh_token,
    );
    const databaseUrl = firstString(source.databaseUrl, source.database_url);
    const databaseId = source.databaseId || source.database_id
      ? normalizeNotionId(source.databaseId || source.database_id, 'Notion database ID')
      : databaseUrl
        ? extractNotionId(databaseUrl)
        : '';
    const dataSourceId = source.dataSourceId || source.data_source_id
      ? normalizeNotionId(source.dataSourceId || source.data_source_id, 'Notion data source ID')
      : '';

    if (!accessToken) throw new TypeError('Notion access token is required');
    if (!databaseId && !dataSourceId) {
      throw new TypeError('Notion database URL or data source ID is required');
    }

    return {
      provider: 'notion',
      enabled: true,
      connection: {
        ...connection,
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
      },
      databaseUrl,
      databaseId,
      dataSourceId,
      mapping: normalizeNotionMapping(source.mapping),
    };
  }

  if (provider === 'json') {
    const credentials = isPlainObject(source.credentials) ? source.credentials : {};
    const bearerToken = firstString(
      source.bearerToken,
      source.bearer_token,
      credentials.bearerToken,
      credentials.bearer_token,
      credentials.token,
    );
    const url = validateFeedUrlStructure(source.url).toString();

    return {
      provider: 'json',
      enabled: true,
      url,
      ...(bearerToken ? { bearerToken } : {}),
    };
  }

  throw new TypeError(`Unsupported task source provider: ${provider}`);
}

function validateTaskSource(source) {
  return normalizeTaskSource(source);
}

function notionClientConfig(options = {}) {
  const clientId = firstString(options.clientId, process.env.NOTION_CLIENT_ID);
  const clientSecret = firstString(options.clientSecret, process.env.NOTION_CLIENT_SECRET);
  const appUrl = firstString(options.appUrl, process.env.APP_URL).replace(/\/$/, '');
  const redirectUri = firstString(
    options.redirectUri,
    process.env.NOTION_REDIRECT_URI,
    appUrl ? `${appUrl}/notion/callback` : '',
  );
  return { clientId, clientSecret, redirectUri };
}

function isNotionConfigured(options = {}) {
  const { clientId, clientSecret, redirectUri } = notionClientConfig(options);
  return Boolean(clientId && clientSecret && redirectUri);
}

function generateNotionAuthUrl(state, options = {}) {
  const normalizedState = requiredTrimmedString(state, 'Notion OAuth state');
  const { clientId, clientSecret, redirectUri } = notionClientConfig(options);
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Notion OAuth is not configured');
  }

  const url = new URL('https://api.notion.com/v1/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('owner', 'user');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', normalizedState);
  return url.toString();
}

function requestOptions(options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(options.timeoutMs);
  const maxResponseBytes = options.maxResponseBytes === undefined
    ? DEFAULT_MAX_RESPONSE_BYTES
    : Number(options.maxResponseBytes);

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
    throw new TypeError('timeoutMs must be between 1 and 30000');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError('maxResponseBytes must be a positive integer');
  }

  return {
    fetchImpl: options.fetchImpl || options.fetch || global.fetch,
    dnsLookup: options.dnsLookup || defaultDnsLookup,
    timeoutMs,
    maxResponseBytes,
  };
}

async function fetchWithTimeout(url, init, options, errorLabel) {
  const { fetchImpl, timeoutMs } = requestOptions(options);
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    // Do not retain the fetch error as a cause: runtimes may include a feed
    // URL (and a query-string credential) in transport error objects.
    throw new Error(`${errorLabel} request failed`);
  } finally {
    clearTimeout(timer);
  }
}

async function closeResponseBody(response, error) {
  const body = response && response.body;
  if (!body) return;
  if (typeof body.cancel === 'function') {
    await body.cancel(error).catch(() => {});
    return;
  }
  if (typeof body.destroy === 'function') body.destroy(error);
}

async function readResponseTextLimited(response, options = {}) {
  const { maxResponseBytes } = requestOptions(options);
  const contentLength = response.headers && typeof response.headers.get === 'function'
    ? Number(response.headers.get('content-length'))
    : NaN;
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    await closeResponseBody(response);
    throw new Error('Task source response is too large');
  }

  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maxResponseBytes) {
        await closeResponseBody(response);
        throw new Error('Task source response is too large');
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }

  if (typeof response.arrayBuffer === 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxResponseBytes) throw new Error('Task source response is too large');
    return buffer.toString('utf8');
  }

  if (typeof response.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
      throw new Error('Task source response is too large');
    }
    return text;
  }

  throw new Error('Task source response could not be read');
}

async function readJsonResponse(response, options, errorLabel) {
  const text = await readResponseTextLimited(response, options);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${errorLabel} returned invalid JSON`);
  }
}

function responseOk(response) {
  if (typeof response.ok === 'boolean') return response.ok;
  return Number(response.status) >= 200 && Number(response.status) < 300;
}

async function notionRequest(path, init, options = {}) {
  const response = await fetchWithTimeout(
    `${NOTION_API_BASE_URL}${path}`,
    {
      redirect: 'manual',
      ...init,
      headers: {
        Accept: 'application/json',
        'Notion-Version': NOTION_VERSION,
        ...(init && init.headers ? init.headers : {}),
      },
    },
    options,
    'Notion',
  );

  if (Number(response.status) >= 300 && Number(response.status) < 400) {
    throw new TaskSourceHttpError('Notion request returned an unexpected redirect', response.status);
  }
  if (!responseOk(response)) {
    throw new TaskSourceHttpError(`Notion request failed (${response.status})`, response.status);
  }
  if (Number(response.status) === 204) return {};
  return readJsonResponse(response, options, 'Notion');
}

async function notionOAuthRequest(body, options = {}) {
  const { clientId, clientSecret } = notionClientConfig(options);
  if (!clientId || !clientSecret) throw new Error('Notion OAuth is not configured');

  return notionRequest(
    '/oauth/token',
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    options,
  );
}

function normalizeNotionConnection(payload, previous = {}) {
  if (!isPlainObject(payload)) throw new Error('Notion OAuth returned an invalid response');
  const accessToken = firstString(payload.access_token, payload.accessToken, previous.accessToken);
  const refreshToken = firstString(payload.refresh_token, payload.refreshToken, previous.refreshToken);
  if (!accessToken) throw new Error('Notion OAuth did not return an access token');

  const expiresIn = Number(payload.expires_in || payload.expiresIn);
  return {
    ...previous,
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0
      ? { expiresAt: Date.now() + expiresIn * 1000 }
      : {}),
    tokenType: firstString(payload.token_type, payload.tokenType, previous.tokenType) || 'bearer',
    botId: firstString(payload.bot_id, payload.botId, previous.botId),
    workspaceId: firstString(payload.workspace_id, payload.workspaceId, previous.workspaceId),
    workspaceName: firstString(payload.workspace_name, payload.workspaceName, previous.workspaceName),
    workspaceIcon: firstString(payload.workspace_icon, payload.workspaceIcon, previous.workspaceIcon),
    owner: payload.owner === undefined ? previous.owner : payload.owner,
  };
}

async function exchangeNotionCode(code, options = {}) {
  const normalizedCode = requiredTrimmedString(code, 'Notion authorization code');
  const { redirectUri } = notionClientConfig(options);
  if (!redirectUri) throw new Error('Notion OAuth is not configured');
  const response = await notionOAuthRequest({
    grant_type: 'authorization_code',
    code: normalizedCode,
    redirect_uri: redirectUri,
  }, options);
  return normalizeNotionConnection(response);
}

async function refreshNotionConnection(connection, options = {}) {
  const existing = typeof connection === 'string'
    ? { refreshToken: connection }
    : connection;
  if (!isPlainObject(existing)) throw new TypeError('Notion connection must be an object');
  const refreshToken = requiredTrimmedString(
    firstString(existing.refreshToken, existing.refresh_token),
    'Notion refresh token',
  );
  const response = await notionOAuthRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }, options);
  return normalizeNotionConnection(response, existing);
}

async function revokeNotionConnection(connection, options = {}) {
  const value = typeof connection === 'string' ? connection : firstString(
    connection && connection.accessToken,
    connection && connection.access_token,
    connection && connection.refreshToken,
    connection && connection.refresh_token,
  );
  const token = requiredTrimmedString(value, 'Notion token');
  const { clientId, clientSecret } = notionClientConfig(options);
  if (!clientId || !clientSecret) throw new Error('Notion OAuth is not configured');

  await notionRequest(
    '/oauth/revoke',
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    },
    options,
  );
  return true;
}

function notionAuthHeaders(accessToken) {
  return {
    Authorization: `Bearer ${requiredTrimmedString(accessToken, 'Notion access token')}`,
  };
}

function richTextValue(value) {
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (part && typeof part.plain_text === 'string') return part.plain_text;
    if (part && part.text && typeof part.text.content === 'string') return part.text.content;
    return '';
  }).join('');
}

function notionObjectTitle(value) {
  if (!value || typeof value !== 'object') return '';
  return richTextValue(value.title);
}

async function resolveNotionDatabase(accessToken, databaseUrl, options = {}) {
  const databaseId = extractNotionId(databaseUrl);
  const headers = notionAuthHeaders(accessToken);
  const database = await notionRequest(`/databases/${databaseId}`, { headers }, options);
  const dataSources = Array.isArray(database.data_sources) ? database.data_sources : [];
  const firstDataSource = dataSources.find((entry) => entry && entry.id);
  if (!firstDataSource) throw new Error('Notion database has no accessible data source');

  const dataSourceId = normalizeNotionId(firstDataSource.id, 'Notion data source ID');
  const dataSource = await notionRequest(`/data_sources/${dataSourceId}`, { headers }, options);
  const properties = isPlainObject(dataSource.properties)
    ? Object.entries(dataSource.properties).map(([name, property]) => ({
      name,
      type: property && typeof property.type === 'string' ? property.type : '',
    }))
    : [];

  return {
    databaseId,
    dataSourceId,
    title: notionObjectTitle(database) || notionObjectTitle(dataSource)
      || firstString(firstDataSource.name),
    properties,
  };
}

function isPrivateIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function ipv6Parts(address) {
  let value = address.toLowerCase().split('%')[0];
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const ipv4 = value.slice(lastColon + 1);
    const octets = ipv4.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    value = `${value.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const sides = value.split('::');
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((sides.length === 1 && missing !== 0) || missing < 0) return null;
  const parts = [...left, ...Array(missing).fill('0'), ...right].map((part) => Number.parseInt(part, 16));
  if (parts.length !== 8 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) {
    return null;
  }
  return parts;
}

function isPrivateIpv6(address) {
  const parts = ipv6Parts(address);
  if (!parts) return true;

  const allZero = parts.every((part) => part === 0);
  const loopback = parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1;
  const uniqueLocal = (parts[0] & 0xfe00) === 0xfc00;
  const linkLocal = (parts[0] & 0xffc0) === 0xfe80;
  const multicast = (parts[0] & 0xff00) === 0xff00;
  const documentation = parts[0] === 0x2001 && parts[1] === 0x0db8;
  const ipv4Mapped = parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;

  if (ipv4Mapped) {
    const mapped = `${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`;
    return isPrivateIpv4(mapped);
  }
  return allZero || loopback || uniqueLocal || linkLocal || multicast || documentation;
}

function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

async function assertPublicHostname(url, options = {}) {
  const { dnsLookup } = requestOptions(options);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) throw new Error('Task feed IP addresses are not allowed');

  let records;
  try {
    records = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Task feed hostname could not be resolved');
  }
  if (!Array.isArray(records)) records = records ? [records] : [];

  const resolved = records
    .map((record) => typeof record === 'string' ? record : record && record.address)
    .filter(Boolean)
    .map((address) => ({ address, family: isIP(address) }));
  if (resolved.length === 0) throw new Error('Task feed hostname could not be resolved');
  if (resolved.some((record) => !record.family || isPrivateAddress(record.address))) {
    throw new Error('Task feed hostname resolves to a non-public address');
  }
  return resolved;
}

function nodeResponseHeaders(headers) {
  return {
    get(name) {
      const value = headers && headers[String(name).toLowerCase()];
      if (Array.isArray(value)) return value.join(', ');
      return value === undefined || value === null ? null : String(value);
    },
  };
}

async function fetchPinnedHttps(url, init, resolvedAddresses, options = {}, errorLabel) {
  const { timeoutMs } = requestOptions(options);
  const httpsRequestImpl = options.httpsRequestImpl || defaultHttpsRequest;
  if (typeof httpsRequestImpl !== 'function') throw new Error('HTTPS request is unavailable');
  if (!Array.isArray(resolvedAddresses) || resolvedAddresses.length === 0) {
    throw new Error(`${errorLabel} request failed`);
  }

  const parsed = url instanceof URL ? url : new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const pinnedAddresses = resolvedAddresses.map((record) => ({
    address: record.address,
    family: record.family,
  }));

  return new Promise((resolve, reject) => {
    let request;
    let responseStream;
    let timer;
    let settled = false;

    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Transport errors can include a URL containing a query-string
      // credential, so expose only a stable, sanitized error.
      reject(new Error(`${errorLabel} request failed`));
    };

    const lookup = (_lookupHostname, lookupOptions, callback) => {
      if (lookupOptions && lookupOptions.all) {
        callback(null, pinnedAddresses.map((record) => ({ ...record })));
        return;
      }
      const [record] = pinnedAddresses;
      callback(null, record.address, record.family);
    };

    try {
      request = httpsRequestImpl(parsed, {
        method: init && init.method ? init.method : 'GET',
        headers: init && init.headers ? init.headers : {},
        // Never reuse a socket opened outside this pinned request. The URL
        // hostname remains intact for Host and TLS SNI, while lookup returns
        // only addresses that passed the public-address check above.
        agent: false,
        servername: hostname,
        lookup,
      }, (response) => {
        if (settled) {
          if (response && typeof response.destroy === 'function') response.destroy();
          return;
        }
        settled = true;
        responseStream = response;
        const clearResponseTimer = () => clearTimeout(timer);
        if (response && typeof response.once === 'function') {
          response.once('end', clearResponseTimer);
          response.once('close', clearResponseTimer);
        }
        const status = Number(response.statusCode);
        resolve({
          status,
          ok: status >= 200 && status < 300,
          headers: nodeResponseHeaders(response.headers),
          body: response,
        });
      });
    } catch {
      fail();
      return;
    }

    if (!settled) {
      request.once('error', fail);
      timer = setTimeout(() => {
        if (responseStream) {
          if (typeof responseStream.destroy === 'function') {
            responseStream.destroy(new Error(`${errorLabel} request failed`));
          }
          return;
        }
        if (!settled) {
          if (typeof request.destroy === 'function') request.destroy();
          fail();
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }

    try {
      request.end(init && init.body);
    } catch {
      fail();
    }
  });
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

async function fetchTaskFeed(source, options = {}) {
  const initialUrl = validateFeedUrlStructure(source.url);
  let currentUrl = initialUrl;
  let maySendToken = true;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const resolvedAddresses = await assertPublicHostname(currentUrl, options);
    const headers = { Accept: 'application/json' };
    if (source.bearerToken && maySendToken) {
      headers.Authorization = `Bearer ${source.bearerToken}`;
    }

    const init = { method: 'GET', headers, redirect: 'manual' };
    const response = options.fetchImpl || options.fetch
      ? await fetchWithTimeout(
        currentUrl.toString(),
        init,
        options,
        'Task feed',
      )
      : await fetchPinnedHttps(
        currentUrl,
        init,
        resolvedAddresses,
        options,
        'Task feed',
      );

    if (!isRedirectStatus(response.status)) {
      if (!responseOk(response)) {
        await closeResponseBody(response);
        throw new TaskSourceHttpError(`Task feed request failed (${response.status})`, response.status);
      }
      return readJsonResponse(response, options, 'Task feed');
    }

    await closeResponseBody(response);
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error('Task feed returned too many redirects');
    }
    const location = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('location')
      : null;
    if (!location) throw new Error('Task feed returned an invalid redirect');

    let nextUrl;
    try {
      nextUrl = validateFeedUrlStructure(new URL(location, currentUrl).toString());
    } catch {
      throw new Error('Task feed returned an unsafe redirect');
    }
    if (nextUrl.origin !== initialUrl.origin) maySendToken = false;
    currentUrl = nextUrl;
  }

  throw new Error('Task feed returned too many redirects');
}

function isValidDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function requireDateKey(value, label) {
  if (!isValidDateKey(value)) throw new TypeError(`${label} must be YYYY-MM-DD`);
  return value;
}

function dateKeyFromValue(value, timeZone) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const normalized = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return isValidDateKey(normalized) ? normalized : '';
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function cleanTaskTitle(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\0/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function uniqueTaskLines(titles) {
  const seen = new Set();
  const lines = [];
  for (const value of titles) {
    const title = cleanTaskTitle(value);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    lines.push(`・${title}`);
  }
  return lines;
}

function genericTaskDone(task) {
  if (typeof task.done === 'boolean') return task.done;
  if (typeof task.completed === 'boolean') return task.completed;
  if (typeof task.status === 'string') {
    return ['done', 'completed', 'complete'].includes(task.status.trim().toLowerCase());
  }
  return false;
}

function filterGenericTasks(document, reportDateKey, nextBusinessDateKey, options = {}) {
  if (!isPlainObject(document)
    || document.version !== TASK_FEED_VERSION
    || !Array.isArray(document.tasks)) {
    throw new Error('Task feed must use schema version 1 with a tasks array');
  }

  const timeZone = firstString(
    options.timeZone,
    process.env.NIPPOU_TIMEZONE,
    'Asia/Tokyo',
  );
  const done = [];
  const will = [];

  document.tasks.forEach((task, index) => {
    if (!isPlainObject(task)) throw new Error(`Task feed tasks[${index}] must be an object`);
    if (typeof task.title !== 'string') {
      throw new Error(`Task feed tasks[${index}].title must be a string`);
    }
    if (task.reportable !== true || task.category !== 'work') return;
    if (task.confidentiality === 'vault参照のみ' || task.confidentiality === 'vault') return;

    const isDone = genericTaskDone(task);
    const completedAt = dateKeyFromValue(task.completedAt, timeZone);
    if (isDone && completedAt === reportDateKey) {
      done.push(task.title);
      return;
    }
    // 過去日報では、その日より後に完了したタスクは当時まだ未完了として扱える。
    if (isDone && (!completedAt || completedAt <= reportDateKey)) return;

    const scheduledDate = dateKeyFromValue(task.scheduledDate, timeZone);
    const dueDate = dateKeyFromValue(task.dueDate, timeZone);
    const dueMatches = options.includeOverdueDueDates
      ? Boolean(dueDate && dueDate <= nextBusinessDateKey)
      : dueDate === nextBusinessDateKey;
    if (scheduledDate === nextBusinessDateKey || dueMatches) will.push(task.title);
  });

  return { done: uniqueTaskLines(done), will: uniqueTaskLines(will) };
}

function notionProperty(page, name) {
  return page && isPlainObject(page.properties) ? page.properties[name] : undefined;
}

function notionPropertyText(property) {
  if (!property || typeof property !== 'object') return '';
  if (Array.isArray(property.title)) return richTextValue(property.title);
  if (Array.isArray(property.rich_text)) return richTextValue(property.rich_text);
  if (property.status && typeof property.status.name === 'string') return property.status.name;
  if (property.select && typeof property.select.name === 'string') return property.select.name;
  if (Array.isArray(property.multi_select)) {
    return property.multi_select
      .map((entry) => entry && entry.name)
      .filter((entry) => typeof entry === 'string')
      .join(',');
  }
  if (typeof property.checkbox === 'boolean') return property.checkbox ? 'true' : 'false';
  return '';
}

function notionPropertyMatches(property, expected) {
  if (!property || typeof property !== 'object') return false;
  if (property.status) return property.status.name === expected;
  if (property.select) return property.select.name === expected;
  if (Array.isArray(property.multi_select)) {
    return property.multi_select.some((entry) => entry && entry.name === expected);
  }
  return notionPropertyText(property) === expected;
}

function notionPropertyDate(property) {
  return property && property.date && typeof property.date.start === 'string'
    ? property.date.start
    : '';
}

function notionPropertyCheckbox(property) {
  return Boolean(property && property.checkbox === true);
}

function notionTaskFromPage(page, mapping, timeZone) {
  return {
    title: notionPropertyText(notionProperty(page, mapping.title)),
    done: notionPropertyMatches(notionProperty(page, mapping.status), mapping.completedStatus),
    scheduledDate: dateKeyFromValue(
      notionPropertyDate(notionProperty(page, mapping.scheduledDate)),
      timeZone,
    ),
    dueDate: dateKeyFromValue(notionPropertyDate(notionProperty(page, mapping.dueDate)), timeZone),
    completedAt: dateKeyFromValue(
      notionPropertyDate(notionProperty(page, mapping.completedAt)),
      timeZone,
    ),
    reportable: notionPropertyCheckbox(notionProperty(page, mapping.reportable)),
    work: notionPropertyMatches(notionProperty(page, mapping.category), mapping.workCategory),
    excluded: notionPropertyMatches(
      notionProperty(page, mapping.confidentiality),
      mapping.excludedConfidentiality,
    ),
  };
}

function notionDateFilter(property, operation, dateKey) {
  return { property, date: { [operation]: dateKey } };
}

async function queryNotionDataSource(accessToken, dataSourceId, filter, options = {}) {
  const results = [];
  let cursor;

  for (let page = 0; page < MAX_NOTION_QUERY_PAGES; page += 1) {
    const response = await notionRequest(
      `/data_sources/${dataSourceId}/query`,
      {
        method: 'POST',
        headers: {
          ...notionAuthHeaders(accessToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          page_size: 100,
          filter,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      },
      options,
    );

    if (!Array.isArray(response.results)) {
      throw new Error('Notion returned an invalid task query response');
    }
    results.push(...response.results);
    if (!response.has_more) return results;
    cursor = response.next_cursor;
    if (typeof cursor !== 'string' || !cursor) {
      throw new Error('Notion returned invalid task query pagination');
    }
  }

  throw new Error('Notion task query exceeded the safety page limit');
}

async function notionDataSourceId(source, accessToken, options) {
  if (source.dataSourceId) return source.dataSourceId;
  const database = await notionRequest(
    `/databases/${source.databaseId}`,
    { headers: notionAuthHeaders(accessToken) },
    options,
  );
  const dataSources = Array.isArray(database.data_sources) ? database.data_sources : [];
  const entry = dataSources.find((candidate) => candidate && candidate.id);
  if (!entry) throw new Error('Notion database has no accessible data source');
  return normalizeNotionId(entry.id, 'Notion data source ID');
}

async function fetchNotionTasksOnce(source, reportDateKey, nextBusinessDateKey, options = {}) {
  const { mapping } = source;
  const accessToken = source.connection.accessToken;
  const dataSourceId = await notionDataSourceId(source, accessToken, options);
  const dueOperation = options.includeOverdueDueDates ? 'on_or_before' : 'equals';
  const willFilters = [
    notionDateFilter(mapping.scheduledDate, 'equals', nextBusinessDateKey),
    notionDateFilter(mapping.dueDate, dueOperation, nextBusinessDateKey),
  ];

  const [donePages, willPages] = await Promise.all([
    queryNotionDataSource(
      accessToken,
      dataSourceId,
      notionDateFilter(mapping.completedAt, 'equals', reportDateKey),
      options,
    ),
    queryNotionDataSource(
      accessToken,
      dataSourceId,
      { or: willFilters },
      options,
    ),
  ]);

  const timeZone = firstString(
    options.timeZone,
    process.env.NIPPOU_TIMEZONE,
    'Asia/Tokyo',
  );
  const done = donePages
    .map((page) => notionTaskFromPage(page, mapping, timeZone))
    .filter((task) => task.reportable
      && task.work
      && !task.excluded
      && task.done
      && task.completedAt === reportDateKey)
    .map((task) => task.title);

  const will = willPages
    .map((page) => notionTaskFromPage(page, mapping, timeZone))
    .filter((task) => {
      if (!task.reportable || !task.work || task.excluded) return false;
      if (task.done && (!task.completedAt || task.completedAt <= reportDateKey)) return false;
      const dueMatches = options.includeOverdueDueDates
        ? Boolean(task.dueDate && task.dueDate <= nextBusinessDateKey)
        : task.dueDate === nextBusinessDateKey;
      return task.scheduledDate === nextBusinessDateKey || dueMatches;
    })
    .map((task) => task.title);

  return { done: uniqueTaskLines(done), will: uniqueTaskLines(will) };
}

async function fetchNotionTasks(source, reportDateKey, nextBusinessDateKey, options = {}) {
  try {
    return await fetchNotionTasksOnce(source, reportDateKey, nextBusinessDateKey, options);
  } catch (error) {
    if (error.status !== 401 || !source.connection.refreshToken) throw error;

    const refreshed = await refreshNotionConnection(source.connection, options);
    if (typeof options.onConnectionRefresh === 'function') {
      await options.onConnectionRefresh(refreshed);
    }
    return fetchNotionTasksOnce(
      { ...source, connection: refreshed },
      reportDateKey,
      nextBusinessDateKey,
      options,
    );
  }
}

async function fetchTaskItems(taskSource, reportDateKey, nextBusinessDateKey, options = {}) {
  const reportDate = requireDateKey(reportDateKey, 'reportDateKey');
  const nextBusinessDate = requireDateKey(nextBusinessDateKey, 'nextBusinessDateKey');
  const source = normalizeTaskSource(taskSource);
  if (!source.enabled || source.provider === 'none') return { done: [], will: [] };

  if (source.provider === 'json') {
    const document = await fetchTaskFeed(source, options);
    return filterGenericTasks(document, reportDate, nextBusinessDate, options);
  }
  if (source.provider === 'notion') {
    return fetchNotionTasks(source, reportDate, nextBusinessDate, options);
  }
  throw new TypeError('Unsupported task source provider');
}

module.exports = {
  DEFAULT_NOTION_MAPPING,
  NOTION_VERSION,
  TASK_FEED_VERSION,
  exchangeNotionCode,
  fetchTaskItems,
  generateNotionAuthUrl,
  isNotionConfigured,
  normalizeTaskSource,
  refreshNotionConnection,
  resolveNotionDatabase,
  revokeNotionConnection,
  validateTaskSource,
};
