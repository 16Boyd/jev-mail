const JEV_CONFIG_HEAD_PROPERTY_ = 'JEV_CONFIG_HEAD';
const JEV_CONFIG_CHUNK_BYTES_ = 8192;
const JEV_CONFIG_MAX_BYTES_ = 65536;
const JEV_DEFAULT_PROPERTIES_ = {
  JEV_API_KEY: '', JEV_ENABLED: 'false', JEV_SCOPE: 'INBOX',
  JEV_INTERVAL_MINUTES: '5', JEV_MODEL: 'jev-latest',
  JEV_API_URL: 'https://api.typesafe.ai/v1/systemone',
};
const JEV_SUPPORTED_INTERVALS_ = [1, 5, 10, 15, 30];
const JEV_CONFIG_ADVANCED_DEFAULTS_ = {
  maxThreadsToFetch: 100, maxThreadsToClassify: 20,
  batchTargetTokens: 16000, maxRequestTokens: 32000,
  maxStateQuestionTokens: 20000, providerAttempts: 3,
  initialRetryDelayMs: 1000, gmailSpacingMs: 1000,
  cooldownMinutes: [15, 30, 60],
};

function createDefaultJevConfig_() {
  return {
    schemaVersion: 1, revision: 0, apiKey: '', enabled: false, scope: 'INBOX',
    intervalMinutes: 5, model: 'jev-latest', apiUrl: 'https://api.typesafe.ai/v1/systemone',
    providers: [{ id: 'provider-1', apiUrl: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', apiKey: '' }],
    schedule: { weekdays: [1, 2, 3, 4, 5, 6, 7], startTime: '00:00', endTime: '00:00', timeZone: 'America/New_York' },
    defaultThreshold: 0.75, fallbackLabel: 'Jev-Uncategoried',
    categories: JEV_CATEGORIES.map(function (item) {
      return { key: item.key, label: item.label, description: item.description, enabled: true, threshold: null };
    }),
    advanced: JSON.parse(JSON.stringify(JEV_CONFIG_ADVANCED_DEFAULTS_)),
  };
}

function utf8BytesJev_(value) {
  return Utilities.newBlob(String(value), 'text/plain').getBytes().length;
}

function splitJevUtf8_(value) {
  const chunks = [];
  let chunk = '';
  for (let i = 0; i < value.length; i += 1) {
    let point = value.charAt(i);
    const first = value.charCodeAt(i);
    if (first >= 0xD800 && first <= 0xDBFF && i + 1 < value.length) point += value.charAt(++i);
    if (chunk && utf8BytesJev_(chunk + point) > JEV_CONFIG_CHUNK_BYTES_) {
      chunks.push(chunk); chunk = '';
    }
    chunk += point;
  }
  if (chunk || !chunks.length) chunks.push(chunk);
  return chunks;
}

function validateJevConfig_(input, options) {
  const opts = options || {};
  let config;
  try { config = JSON.parse(JSON.stringify(input)); } catch (ignoredCloneError) { config = null; }
  const errors = [];
  function fail(path, message) { errors.push({ path: path, message: message }); }
  function integer(path, value, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) fail(path, 'Must be an integer from ' + min + ' to ' + max + '.');
  }
  function isReservedGmailLabel_(name) {
    return ['INBOX', 'STARRED', 'IMPORTANT', 'UNREAD', 'SENT', 'DRAFT', 'SPAM', 'TRASH'].indexOf(String(name).toUpperCase()) >= 0 || /^CATEGORY_/.test(String(name).toUpperCase());
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    fail('settings', 'Settings must be an object.');
    const invalid = new Error('Settings validation failed.');
    invalid.validationErrors = errors;
    throw invalid;
  }
  if (config.schemaVersion !== 1) fail('schemaVersion', 'Unsupported settings version.');
  if (!Number.isInteger(config.revision) || config.revision < 0) fail('revision', 'Revision must be a nonnegative integer.');
  if (typeof config.enabled !== 'boolean') fail('enabled', 'Choose whether processing is enabled.');
  if (['INBOX', 'ALL'].indexOf(config.scope) < 0) fail('scope', 'Choose INBOX or ALL.');
  if (JEV_SUPPORTED_INTERVALS_.indexOf(config.intervalMinutes) < 0) fail('intervalMinutes', 'Choose a supported polling interval.');
  if (typeof config.model !== 'string' || !config.model.trim()) fail('model', 'Model must not be empty.');
  if (typeof config.model === 'string') config.model = config.model.trim();
  if (!isValidJevApiUrl_(config.apiUrl)) fail('apiUrl', 'Enter a complete HTTPS endpoint.');
  if (typeof config.apiKey !== 'string') fail('apiKey', 'API key is invalid.');
  if (typeof config.apiKey === 'string') config.apiKey = config.apiKey.trim();
  if (!Array.isArray(config.providers)) {
    config.providers = [{ id: 'provider-1', apiUrl: config.apiUrl, model: config.model, apiKey: config.apiKey }];
  }
  if (config.providers.length < 1 || config.providers.length > 5) fail('providers', 'Use one to five provider profiles.');
  const providerIds = Object.create(null);
  config.providers.forEach(function (provider, i) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) { fail('providers.' + i, 'Provider profile is invalid.'); return; }
    if (Object.keys(provider).some(function (key) { return ['id', 'apiUrl', 'model', 'apiKey'].indexOf(key) < 0; })) fail('providers.' + i, 'Provider profile includes unsupported fields.');
    if (typeof provider.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(provider.id) || ['__proto__', 'constructor', 'prototype'].indexOf(provider.id) >= 0) fail('providers.' + i + '.id', 'Provider ID is invalid.');
    if (providerIds[provider.id]) fail('providers.' + i + '.id', 'Provider IDs must be unique.'); providerIds[provider.id] = true;
    if (!isValidJevApiUrl_(provider.apiUrl)) fail('providers.' + i + '.apiUrl', 'Enter a complete HTTPS endpoint.');
    if (typeof provider.model !== 'string' || !provider.model.trim()) fail('providers.' + i + '.model', 'Model must not be empty.');
    if (typeof provider.apiKey !== 'string') fail('providers.' + i + '.apiKey', 'API key is invalid.');
    provider.apiUrl = String(provider.apiUrl || '').trim(); provider.model = String(provider.model || '').trim(); provider.apiKey = String(provider.apiKey || '').trim();
  });
  if (config.providers[0]) { config.apiUrl = config.providers[0].apiUrl; config.model = config.providers[0].model; config.apiKey = config.providers[0].apiKey; }
  if (opts.apiKeyAction === 'replace' && !config.apiKey) fail('apiKey', 'Enter a nonempty API key or choose Clear key.');
  if (typeof config.defaultThreshold !== 'number' || !Number.isFinite(config.defaultThreshold) || config.defaultThreshold < 0 || config.defaultThreshold > 1) fail('defaultThreshold', 'Threshold must be from 0 to 1.');
  const schedule = config.schedule || {};
  if (!Array.isArray(schedule.weekdays) || !schedule.weekdays.length || schedule.weekdays.some(function (d) { return !Number.isInteger(d) || d < 1 || d > 7; })) fail('schedule.weekdays', 'Choose at least one weekday.');
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.startTime || '') === false) fail('schedule.startTime', 'Enter a time from 00:00 to 23:59.');
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.endTime || '') === false) fail('schedule.endTime', 'Enter a time from 00:00 to 23:59.');
  try { Utilities.formatDate(new Date(), schedule.timeZone, 'yyyy-MM-dd'); } catch (e) { fail('schedule.timeZone', 'Choose a valid time zone.'); }
  if (typeof config.fallbackLabel !== 'string' || !config.fallbackLabel.trim()) fail('fallbackLabel', 'Fallback label must not be empty.');
  if (typeof config.fallbackLabel === 'string') config.fallbackLabel = config.fallbackLabel.trim();
  if (typeof config.fallbackLabel === 'string' && isReservedGmailLabel_(config.fallbackLabel)) fail('fallbackLabel', 'Choose a label name that is not reserved by Gmail.');
  if (config.fallbackLabel === 'JEV') fail('fallbackLabel', 'Fallback label must differ from JEV.');
  const categoriesAreList = Array.isArray(config.categories);
  if (!categoriesAreList) fail('categories', 'Categories must be a list.');
  let categoriesAreObjects = categoriesAreList;
  const keys = Object.create(null), labels = Object.create(null);
  (Array.isArray(config.categories) ? config.categories : []).forEach(function (cat, i) {
    if (!cat || typeof cat !== 'object' || Array.isArray(cat)) { fail('categories.' + i, 'Category is invalid.'); categoriesAreObjects = false; return; }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cat.key || '') || ['__proto__', 'constructor', 'prototype'].indexOf(cat.key) >= 0) fail('categories.' + i + '.key', 'Category key is invalid.');
    if (keys[cat.key]) fail('categories.' + i + '.key', 'Category keys must be unique.'); keys[cat.key] = true;
    if (typeof cat.label !== 'string' || !cat.label.trim()) fail('categories.' + i + '.label', 'Label must not be empty.');
    if (typeof cat.label === 'string') cat.label = cat.label.trim();
    if (typeof cat.label === 'string' && isReservedGmailLabel_(cat.label)) fail('categories.' + i + '.label', 'Choose a label name that is not reserved by Gmail.');
    if (cat.label === 'JEV' || cat.label === config.fallbackLabel || labels[cat.label]) fail('categories.' + i + '.label', 'Labels must be unique and differ from JEV and fallback.'); labels[cat.label] = true;
    if (typeof cat.description !== 'string' || !cat.description.trim()) fail('categories.' + i + '.description', 'Description must not be empty.');
    if (typeof cat.description === 'string') cat.description = cat.description.trim();
    if (typeof cat.enabled !== 'boolean') fail('categories.' + i + '.enabled', 'Choose whether the category is enabled.');
    if (cat.threshold !== null && (typeof cat.threshold !== 'number' || !Number.isFinite(cat.threshold) || cat.threshold < 0 || cat.threshold > 1)) fail('categories.' + i + '.threshold', 'Threshold must be blank or from 0 to 1.');
  });
  if (categoriesAreObjects) config.categories = config.categories.map(function (c) {
    return { key: c.key, label: c.label, description: c.description, enabled: c.enabled, threshold: c.threshold === undefined ? null : c.threshold };
  });
  const a = config.advanced || {};
  integer('advanced.maxThreadsToFetch', a.maxThreadsToFetch, 1, 100);
  integer('advanced.maxThreadsToClassify', a.maxThreadsToClassify, 1, a.maxThreadsToFetch);
  integer('advanced.batchTargetTokens', a.batchTargetTokens, 1000, a.maxRequestTokens);
  integer('advanced.maxRequestTokens', a.maxRequestTokens, 1000, 32000);
  integer('advanced.maxStateQuestionTokens', a.maxStateQuestionTokens, 1000, Math.min(20000, a.maxRequestTokens));
  integer('advanced.providerAttempts', a.providerAttempts, 1, 5);
  integer('advanced.initialRetryDelayMs', a.initialRetryDelayMs, 250, 5000);
  integer('advanced.gmailSpacingMs', a.gmailSpacingMs, 1000, 10000);
  if (!Array.isArray(a.cooldownMinutes) || a.cooldownMinutes.length !== 3 || a.cooldownMinutes.some(function (v, i) { return !Number.isInteger(v) || v < 15 || v > 1440 || (i && v < a.cooldownMinutes[i - 1]); })) fail('advanced.cooldownMinutes', 'Use three nondecreasing cooldowns from 15 to 1,440 minutes.');
  if (config.enabled && (!config.providers.some(function (p) { return p && p.apiKey; }) || !categoriesAreObjects || !config.categories.some(function (c) { return c && c.enabled === true; }))) fail('enabled', 'Enable requires an API key and at least one enabled category.');
  if (opts.apiKeyAction === 'clear' && config.enabled) fail('apiKeyAction', 'Pause processing before clearing the API key.');
  if (errors.length) { const error = new Error('Settings validation failed.'); error.validationErrors = errors; throw error; }
  config.schedule = { weekdays: config.schedule.weekdays.slice(), startTime: config.schedule.startTime, endTime: config.schedule.endTime, timeZone: config.schedule.timeZone };
  config.advanced = {
    maxThreadsToFetch: a.maxThreadsToFetch, maxThreadsToClassify: a.maxThreadsToClassify,
    batchTargetTokens: a.batchTargetTokens, maxRequestTokens: a.maxRequestTokens,
    maxStateQuestionTokens: a.maxStateQuestionTokens, providerAttempts: a.providerAttempts,
    initialRetryDelayMs: a.initialRetryDelayMs, gmailSpacingMs: a.gmailSpacingMs,
    cooldownMinutes: a.cooldownMinutes.slice(),
  };
  return config;
}

function readJevConfigFromProperties_(snapshot) {
  const props = snapshot || PropertiesService.getScriptProperties().getProperties();
  const headText = props[JEV_CONFIG_HEAD_PROPERTY_];
  if (headText !== undefined) {
    let head;
    try { head = JSON.parse(headText); } catch (e) { throw new Error('Saved JEV settings are corrupt. Open Settings and restore from an export.'); }
      if (!head || head.schemaVersion !== 1 || !/^[a-zA-Z0-9_-]{8,80}$/.test(head.generation) || !Number.isInteger(head.chunks) || head.chunks < 1 || head.chunks > 16 || !Number.isInteger(head.byteLength) || head.byteLength < 1 || !Number.isInteger(head.revision) || head.revision < 0) throw new Error('Saved JEV settings are corrupt. Open Settings and restore from an export.');
    let json = '';
    for (let i = 0; i < head.chunks; i += 1) {
      const part = props['JEV_CONFIG_' + head.generation + '_' + i];
      if (typeof part !== 'string' || utf8BytesJev_(part) > JEV_CONFIG_CHUNK_BYTES_) throw new Error('Saved JEV settings are corrupt. Open Settings and restore from an export.');
      json += part;
    }
    if (utf8BytesJev_(json) !== head.byteLength || head.byteLength > JEV_CONFIG_MAX_BYTES_) throw new Error('Saved JEV settings are corrupt. Open Settings and restore from an export.');
    try {
      const parsed = JSON.parse(json);
      const allowed = ['schemaVersion', 'revision', 'apiKey', 'enabled', 'scope', 'intervalMinutes', 'model', 'apiUrl', 'providers', 'schedule', 'defaultThreshold', 'fallbackLabel', 'categories', 'advanced'];
      if (!parsed || Object.keys(parsed).some(function (k) { return allowed.indexOf(k) < 0; })) throw new Error('fields');
      const config = validateJevConfig_(parsed);
      if (config.revision !== head.revision) throw new Error('revision');
      return config;
    } catch (e) { throw new Error('Saved JEV settings are corrupt. Open Settings and restore from an export.'); }
  }
  const raw = {};
  Object.keys(JEV_DEFAULT_PROPERTIES_).forEach(function (key) { raw[key] = props[key] === undefined ? JEV_DEFAULT_PROPERTIES_[key] : props[key]; });
  const config = createDefaultJevConfig_();
  config.apiKey = String(raw.JEV_API_KEY || '').trim();
  config.enabled = parseBooleanProperty_(raw.JEV_ENABLED, 'JEV_ENABLED');
  config.scope = String(raw.JEV_SCOPE).trim().toUpperCase();
  config.intervalMinutes = Number(String(raw.JEV_INTERVAL_MINUTES).trim());
  config.model = String(raw.JEV_MODEL).trim(); config.apiUrl = String(raw.JEV_API_URL).trim();
  config.providers = [{ id: 'provider-1', apiUrl: config.apiUrl, model: config.model, apiKey: config.apiKey }];
  return validateJevConfig_(config);
}

function commitJevConfig_(config) {
  const json = JSON.stringify(config);
  if (utf8BytesJev_(json) > JEV_CONFIG_MAX_BYTES_) throw new Error('Settings exceed the 64 KB storage limit.');
  const chunks = splitJevUtf8_(json);
  const props = PropertiesService.getScriptProperties();
  const generation = String(Date.now()) + '_' + Math.random().toString(36).slice(2, 10);
  chunks.forEach(function (chunk, i) { props.setProperty('JEV_CONFIG_' + generation + '_' + i, chunk); });
  const check = chunks.map(function (_, i) { return props.getProperty('JEV_CONFIG_' + generation + '_' + i); }).join('');
  if (check !== json) throw new Error('Could not verify saved settings.');
  props.setProperty(JEV_CONFIG_HEAD_PROPERTY_, JSON.stringify({ schemaVersion: 1, generation: generation, revision: config.revision, chunks: chunks.length, byteLength: utf8BytesJev_(json) }));
  try {
    const existing = props.getProperties();
    Object.keys(existing).forEach(function (key) {
      if (/^JEV_CONFIG_[a-zA-Z0-9_-]+_\d+$/.test(key) && key.indexOf('JEV_CONFIG_' + generation + '_') !== 0) props.deleteProperty(key);
    });
    Object.keys(JEV_DEFAULT_PROPERTIES_).forEach(function (key) { props.deleteProperty(key); });
  } catch (ignored) {}
}

function getJevConfig_() { return readJevConfigFromProperties_(); }
function getEnabledJevCategories_(config) { return config.categories.filter(function (category) { return category.enabled; }); }

function isJevScheduleEligible_(config, date) {
  const now = date || new Date();
  const day = Number(Utilities.formatDate(now, config.schedule.timeZone, 'u'));
  const time = Utilities.formatDate(now, config.schedule.timeZone, 'HH:mm');
  const start = config.schedule.startTime, end = config.schedule.endTime;
  if (start === end) return config.schedule.weekdays.indexOf(day) >= 0;
  if (start < end) return config.schedule.weekdays.indexOf(day) >= 0 && time >= start && time < end;
  if (time >= start) return config.schedule.weekdays.indexOf(day) >= 0;
  const previous = day === 1 ? 7 : day - 1;
  return time < end && config.schedule.weekdays.indexOf(previous) >= 0;
}

function parseBooleanProperty_(value, propertyName) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(propertyName + ' must be true or false.');
}
function isValidJevApiUrl_(url) {
  if (typeof url !== 'string' || !url || /\s/.test(url) || url.indexOf('#') >= 0 || !/^https:\/\/[^/?#]+(?:\/[^?#]*)?(?:\?[^#]*)?$/i.test(url)) return false;
  const authority = url.substring(8).split(/[/?#]/)[0];
  return authority.length > 0 && authority.indexOf('@') < 0 && authority.indexOf('\\') < 0;
}
