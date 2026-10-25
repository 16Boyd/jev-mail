const JEV_RUN_HISTORY_PROPERTY_ = 'JEV_INTERNAL_RUN_HISTORY';
const JEV_RUNNING_PROPERTY_ = 'JEV_INTERNAL_RUNNING';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('JEV Settings').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function publicJevSettings_(config) {
  return {
    enabled: config.enabled, scope: config.scope, intervalMinutes: config.intervalMinutes,
    providers: config.providers.map(function (p) { return { id: p.id, apiUrl: p.apiUrl, model: p.model, apiKeyConfigured: Boolean(p.apiKey) }; }),
    model: config.model, apiUrl: config.apiUrl, schedule: {
      weekdays: config.schedule.weekdays.slice(), startTime: config.schedule.startTime,
      endTime: config.schedule.endTime, timeZone: config.schedule.timeZone,
    },
    defaultThreshold: config.defaultThreshold, fallbackLabel: config.fallbackLabel,
    categories: config.categories.map(function (c) { return { key: c.key, label: c.label, description: c.description, enabled: c.enabled, threshold: c.threshold }; }),
    advanced: {
      maxThreadsToFetch: config.advanced.maxThreadsToFetch, maxThreadsToClassify: config.advanced.maxThreadsToClassify,
      batchTargetTokens: config.advanced.batchTargetTokens, maxRequestTokens: config.advanced.maxRequestTokens,
      maxStateQuestionTokens: config.advanced.maxStateQuestionTokens, providerAttempts: config.advanced.providerAttempts,
      initialRetryDelayMs: config.advanced.initialRetryDelayMs, gmailSpacingMs: config.advanced.gmailSpacingMs,
      cooldownMinutes: config.advanced.cooldownMinutes.slice(),
    },
  };
}

function getJevUiState() {
  try {
    const properties = PropertiesService.getScriptProperties().getProperties();
    const config = readJevConfigFromProperties_(properties);
    const history = readJevHistory_(properties);
    let running = null;
    try { running = properties[JEV_RUNNING_PROPERTY_] ? JSON.parse(properties[JEV_RUNNING_PROPERTY_]) : null; } catch (ignored) {}
    if (running && Date.now() - Number(running.startedAt) > 7 * 60 * 1000) running = Object.assign({}, running, { outcome: 'interrupted', expired: true });
    return {
      ok: true, revision: config.revision, settings: publicJevSettings_(config), apiKeyConfigured: config.providers.some(function (p) { return Boolean(p.apiKey); }),
      triggerHealth: getJevTriggerHealth_(config), cooldown: getJevCooldownState_(), running: running,
      lastRuns: history.slice(-20).reverse(), bounds: {
        intervals: JEV_SUPPORTED_INTERVALS_, fetch: [1, 100], classify: [1, 100], threshold: [0, 1],
      },
    };
  } catch (error) { return { ok: false, code: 'CONFIG_ERROR', message: safeWebError_(error) }; }
}

function readJevHistory_(properties) {
  try { const value = properties[JEV_RUN_HISTORY_PROPERTY_]; const parsed = value ? JSON.parse(value) : []; return Array.isArray(parsed) ? parsed.slice(-20) : []; } catch (ignored) { return []; }
}
function getJevTriggerHealth_(config) {
  try {
    const props = PropertiesService.getScriptProperties();
    const triggers = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === JEV_TRIGGER_HANDLER_; });
    let record = null;
    try { record = JSON.parse(props.getProperty(JEV_TRIGGER_RECORD_PROPERTY_) || 'null'); } catch (ignored) {}
    if (!record || record.schemaVersion !== 1) {
      const legacyId = props.getProperty(JEV_TRIGGER_ID_PROPERTY_);
      const legacyInterval = Number(props.getProperty(JEV_TRIGGER_INTERVAL_PROPERTY_));
      const possible = triggers.filter(function (t) { return typeof t.getUniqueId === 'function' && t.getUniqueId() === legacyId; })[0];
      if (possible && JEV_SUPPORTED_INTERVALS_.indexOf(legacyInterval) >= 0) record = { triggerId: legacyId, intervalMinutes: legacyInterval, legacy: true };
    }
    const match = triggers.filter(function (t) {
      return typeof t.getUniqueId === 'function' && t.getUniqueId() === (record && record.triggerId) &&
        typeof t.getEventType === 'function' && t.getEventType() === ScriptApp.EventType.CLOCK;
    })[0];
    const interval = record ? record.intervalMinutes : null;
    return { healthy: Boolean(match && triggers.length === 1 && config && interval === config.intervalMinutes), count: triggers.length, intervalMinutes: interval };
  } catch (ignored) { return { healthy: false, count: 0, intervalMinutes: null }; }
}
function getJevCooldownState_() {
  const until = Number(PropertiesService.getScriptProperties().getProperty(JEV_COOLDOWN_UNTIL_PROPERTY_));
  return { active: Number.isFinite(until) && until > Date.now(), until: Number.isFinite(until) && until > Date.now() ? until : null };
}
function safeWebError_(error) {
  const raw = error && error.message;
  return raw === 'Settings exceed the 64 KB storage limit.' ? raw : 'Could not load or save JEV settings.';
}
function webResultError_(error) {
  if (error && Array.isArray(error.validationErrors)) return { ok: false, code: 'VALIDATION', errors: error.validationErrors, message: 'Fix the highlighted settings.' };
  return { ok: false, code: 'ERROR', message: safeWebError_(error) };
}

function saveJevSettings(request) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return { ok: false, code: 'BUSY', message: 'JEV is processing. Your draft is unchanged.' };
  try {
    const properties = PropertiesService.getScriptProperties();
    const snapshot = properties.getProperties();
    let current;
    try { current = readJevConfigFromProperties_(snapshot); } catch (e) { return webResultError_(e); }
    if (!request || request.expectedRevision !== current.revision) return { ok: false, code: 'CONFLICT', revision: current.revision, message: 'Settings changed in another tab. Reload or copy your draft before saving.' };
    const action = request.apiKeyAction || 'keep';
    if (['keep', 'replace', 'clear'].indexOf(action) < 0) return { ok: false, code: 'VALIDATION', errors: [{ path: 'apiKeyAction', message: 'Choose keep, replace, or clear.' }] };
    const rawSettings = request.settings || {};
    const allowedTop = ['enabled', 'scope', 'intervalMinutes', 'model', 'apiUrl', 'providers', 'schedule', 'defaultThreshold', 'fallbackLabel', 'categories', 'advanced'];
    const forbidden = ['apiKey', 'apiKeyConfigured', 'revision', 'schemaVersion', 'running', 'triggerHealth', 'cooldown', 'lastRuns'];
    if (Object.keys(rawSettings).some(function (k) { return allowedTop.indexOf(k) < 0 || forbidden.indexOf(k) >= 0; })) return { ok: false, code: 'VALIDATION', errors: [{ path: 'settings', message: 'Settings include unsupported or secret fields.' }] };
    const next = Object.assign({}, rawSettings, { schemaVersion: 1, revision: current.revision + 1 });
    if (rawSettings.providers !== undefined) {
      if (!Array.isArray(rawSettings.providers) || rawSettings.providers.some(function (p) { return !p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(function (k) { return ['id','apiUrl','model','apiKeyConfigured'].indexOf(k) < 0; }); })) return { ok: false, code: 'VALIDATION', errors: [{ path: 'providers', message: 'Provider profiles include unsupported fields.' }] };
      const actions = request.providerKeyActions || {};
      if (!actions || typeof actions !== 'object' || Array.isArray(actions) || Object.keys(actions).some(function (id) { return !rawSettings.providers.some(function (p) { return p.id === id; }); })) return { ok: false, code: 'VALIDATION', errors: [{ path: 'providerKeyActions', message: 'Provider key actions are invalid.' }] };
      const suppliedKeys = request.providerKeys || {};
      if (!suppliedKeys || typeof suppliedKeys !== 'object' || Array.isArray(suppliedKeys) || Object.keys(suppliedKeys).some(function (id) { return !rawSettings.providers.some(function (p) { return p.id === id; }); }) || Object.keys(suppliedKeys).some(function (id) { return typeof suppliedKeys[id] !== 'string'; })) return { ok: false, code: 'VALIDATION', errors: [{ path: 'providerKeys', message: 'Provider keys are invalid.' }] };
      next.providers = rawSettings.providers.map(function (p) {
        const actionForProvider = Object.prototype.hasOwnProperty.call(actions, p.id) ? actions[p.id] : 'keep';
        if (['keep','replace','clear'].indexOf(actionForProvider) < 0) throw new Error('Provider key action is invalid.');
        const currentProvider = current.providers.filter(function (x) { return x.id === p.id; })[0];
        const suppliedKey = Object.prototype.hasOwnProperty.call(suppliedKeys, p.id) ? suppliedKeys[p.id] : '';
        const key = actionForProvider === 'replace' ? String(suppliedKey || '').trim() : actionForProvider === 'clear' ? '' : (currentProvider ? currentProvider.apiKey : '');
        if (actionForProvider === 'replace' && !key) throw new Error('Provider API key replacement must not be empty.');
        return { id: p.id, apiUrl: p.apiUrl, model: p.model, apiKey: key };
      });
      if (!Object.keys(actions).length && action !== 'keep') {
        const legacyKey = action === 'clear' ? '' : String(request.apiKey || '').trim();
        if (action === 'replace' && !legacyKey) throw new Error('Provider API key replacement must not be empty.');
        next.providers[0].apiKey = legacyKey;
      }
      next.apiKey = ''; next.apiUrl = next.providers[0] && next.providers[0].apiUrl; next.model = next.providers[0] && next.providers[0].model;
    } else {
      next.providers = current.providers.map(function (p, i) { return { id:p.id, apiUrl:i===0?rawSettings.apiUrl:p.apiUrl, model:i===0?rawSettings.model:p.model, apiKey:p.apiKey }; });
      if (action !== 'keep') next.providers[0].apiKey = action === 'clear' ? '' : String(request.apiKey || '').trim();
      next.apiKey = next.providers[0].apiKey;
    }
    next.schedule = Object.assign({}, rawSettings.schedule);
    next.categories = Array.isArray(rawSettings.categories) && rawSettings.categories.every(function (c) { return c && typeof c === 'object' && !Array.isArray(c); }) ? rawSettings.categories.map(function (c) {
      if (Object.keys(c).some(function (k) { return ['key', 'label', 'description', 'enabled', 'threshold'].indexOf(k) < 0; })) throw new Error('Settings include unsupported category fields.');
      return { key: c.key, label: c.label, description: c.description, enabled: c.enabled, threshold: c.threshold === undefined ? null : c.threshold };
    }) : rawSettings.categories;
    if (!rawSettings.schedule || Object.keys(rawSettings.schedule).some(function (k) { return ['weekdays', 'startTime', 'endTime', 'timeZone'].indexOf(k) < 0; })) return { ok: false, code: 'VALIDATION', errors: [{ path: 'schedule', message: 'Schedule includes unsupported fields.' }] };
    if (!rawSettings.advanced || Object.keys(rawSettings.advanced).some(function (k) { return ['maxThreadsToFetch', 'maxThreadsToClassify', 'batchTargetTokens', 'maxRequestTokens', 'maxStateQuestionTokens', 'providerAttempts', 'initialRetryDelayMs', 'gmailSpacingMs', 'cooldownMinutes'].indexOf(k) < 0; })) return { ok: false, code: 'VALIDATION', errors: [{ path: 'advanced', message: 'Advanced settings include unsupported fields.' }] };
    next.advanced = rawSettings.advanced;
    if (!next.providers) next.apiKey = action === 'replace' ? String(request.apiKey || '').trim() : action === 'clear' ? '' : current.apiKey;
    const validated = validateJevConfig_(next, { apiKeyAction: action });
    commitJevConfig_(validated);
    let schedulePending = false;
    try { reconcileJevTrigger_(validated.intervalMinutes, false); } catch (ignoredScheduleError) { schedulePending = true; }
    return { ok: true, saved: true, revision: validated.revision, settings: publicJevSettings_(validated), apiKeyConfigured: validated.providers.some(function (p) { return Boolean(p.apiKey); }), schedulePending: schedulePending };
  } catch (error) { return webResultError_(error); }
  finally { try { lock.releaseLock(); } catch (ignoredReleaseError) {} }
}

function runJevNow() { return executeJevRun_('manual'); }
function repairJevSchedule() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return { ok: false, code: 'BUSY', message: 'JEV is processing. Try again after it finishes.' };
  try {
    const config = getJevConfig_();
    reconcileJevTrigger_(config.intervalMinutes, false);
    return { ok: true, triggerHealth: getJevTriggerHealth_(config) };
  } catch (error) { return webResultError_(error); }
  finally { try { lock.releaseLock(); } catch (ignored) {} }
}

function appendJevRunHistory_(summary) {
  try {
    const props = PropertiesService.getScriptProperties();
    const history = readJevHistory_(props.getProperties());
    history.push(summary); props.setProperty(JEV_RUN_HISTORY_PROPERTY_, JSON.stringify(history.slice(-20)));
  } catch (ignored) {}
}
