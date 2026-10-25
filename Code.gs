const JEV_CLASSIFY_TOKEN_CHARS_PER_TOKEN_ = 4;
const JEV_BODY_TRUNCATION_MARKER_ = '\n\n[truncated]';
const JEV_PROCESSED_LABEL_ = 'JEV';
const JEV_TRIGGER_HANDLER_ = 'runJevBatch';
const JEV_TRIGGER_INTERVAL_PROPERTY_ = 'JEV_INTERNAL_TRIGGER_INTERVAL_MINUTES';
const JEV_TRIGGER_ID_PROPERTY_ = 'JEV_INTERNAL_TRIGGER_ID';
const JEV_TRIGGER_RECORD_PROPERTY_ = 'JEV_INTERNAL_TRIGGER_RECORD';
const JEV_COOLDOWN_UNTIL_PROPERTY_ = 'JEV_INTERNAL_GMAIL_COOLDOWN_UNTIL';
const JEV_COOLDOWN_STEP_PROPERTY_ = 'JEV_INTERNAL_GMAIL_COOLDOWN_STEP';
const JEV_GMAIL_COOLDOWN_MINUTES_ = [15, 30, 60];
const JEV_HTTP_ERROR_BODY_MAX_LENGTH_ = 2000;
const JEV_HTTP_ERROR_BODY_UNAVAILABLE_ = '[response body unavailable]';
const JEV_GMAIL_QUOTA_COSTS_ = {
  'threads.list': 10,
  'threads.get': 40,
  'labels.list': 1,
  'labels.create': 5,
  'messages.batchModify': 50,
};
const JEV_GMAIL_PROJECT_LIMIT_PER_MINUTE_ = 1200000;
const JEV_GMAIL_USER_LIMIT_PER_MINUTE_ = 6000;
let JEV_LAST_GMAIL_REQUEST_AT_ = 0;
let JEV_ACTIVE_RUN_CONTEXT_ = null;

/**
 * Seeds missing configuration properties and installs the scheduled trigger.
 * Existing property values are preserved.
 */
function initializeJevProperties() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;
  try {
    const config = getJevConfig_();
    if (!PropertiesService.getScriptProperties().getProperty(JEV_CONFIG_HEAD_PROPERTY_)) {
      config.revision = 1;
      commitJevConfig_(config);
    }
    reconcileJevTrigger_(config.intervalMinutes, false);
  } finally { lock.releaseLock(); }
}

/** Installs or repairs the single scheduled JEV batch trigger. */
function installJevTrigger() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return { ok: false, code: 'BUSY' };
  try {
    const config = getJevConfig_();
    reconcileJevTrigger_(config.intervalMinutes, false);
    console.log('[JEV] Trigger configured for every ' + config.intervalMinutes + ' minute(s).');
    return { ok: true };
  } finally { lock.releaseLock(); }
}

/** Scheduled entry point. */
function runJevBatch() { return executeJevRun_('scheduled'); }

function executeJevRun_(source) {
  const metrics = createJevRunMetrics_();
  const startedAt = Date.now();
  let lock = null;
  let lockAcquired = false;
  try {
    lock = typeof LockService !== 'undefined' ? LockService.getScriptLock() : null;
    if (lock) {
      lockAcquired = lock.tryLock(0);
      if (!lockAcquired) {
        console.log('[JEV] Another batch is running; this invocation was skipped.');
        return { ok: false, code: 'BUSY', message: 'JEV is already processing.' };
      }
    }
    const config = getJevConfig_();
    try { ensureJevTrigger_(config.intervalMinutes); } catch (ignoredTriggerRepair) {}
    const runContext = { source: source, startedAt: startedAt, deadlineAt: startedAt + 4 * 60 * 1000, revision: config.revision, config: config, providerCursor: 0 };
    JEV_ACTIVE_RUN_CONTEXT_ = runContext;
    if (source === 'scheduled' && (!config.enabled || !isJevScheduleEligible_(config, new Date()))) return { ok: true, skipped: true, reason: 'schedule_ineligible' };
    if (!config.providers.some(function (p) { return p.apiKey; }) || !getEnabledJevCategories_(config).length) return { ok: true, skipped: true, reason: 'configuration_incomplete' };
    if (isJevCooldownActive_()) return { ok: true, skipped: true, reason: 'cooldown' };
    try { PropertiesService.getScriptProperties().setProperty(JEV_RUNNING_PROPERTY_, JSON.stringify({ startedAt: startedAt, source: source, revision: config.revision })); } catch (ignored) {}
    const summary = runJevBatchLocked_(config, metrics, runContext) || { succeeded: 0, failed: 0, deferred: 0 };
    const endedAt = Date.now();
    appendJevRunHistory_({ startedAt: startedAt, endedAt: endedAt, source: source, revision: config.revision,
      outcome: summary.failed ? 'partial' : (summary.deferred || summary.reason === 'deadline') ? 'deferred' : 'complete',
      succeeded: summary.succeeded || 0, failed: summary.failed || 0, deferred: summary.deferred || 0,
      durationMs: endedAt - startedAt, metrics: { classifierFetchAttempts: metrics.classifierFetchAttempts } });
    return { ok: true, summary: summary };
  } catch (error) {
    return { ok: false, code: 'RUN_ERROR', message: getSafeErrorMessage_(error) };
  } finally {
    try {
      if (lockAcquired) { try { PropertiesService.getScriptProperties().deleteProperty(JEV_RUNNING_PROPERTY_); } catch (ignored) {} }
      if (lock && lockAcquired) lock.releaseLock();
    } finally {
      JEV_ACTIVE_RUN_CONTEXT_ = null;
      logJevRunMetrics_(metrics, Date.now() - startedAt);
    }
  }
}

function createJevRunMetrics_() {
  const gmailAttempts = {};
  Object.keys(JEV_GMAIL_QUOTA_COSTS_).forEach(function (method) { gmailAttempts[method] = 0; });
  return { gmailAttempts: gmailAttempts, classifierFetchAttempts: 0 };
}

function logJevRunMetrics_(metrics, durationMs) {
  const methods = {};
  let totalEstimatedUnits = 0;
  Object.keys(JEV_GMAIL_QUOTA_COSTS_).forEach(function (method) {
    const attempts = metrics.gmailAttempts[method];
    const cost = JEV_GMAIL_QUOTA_COSTS_[method];
    const estimatedUnits = attempts * cost;
    totalEstimatedUnits += estimatedUnits;
    methods[method] = { attempts: attempts, quotaUnitsPerAttempt: cost, estimatedUnits: estimatedUnits };
  });
  console.log('[JEV] Run metrics: ' + JSON.stringify({
    durationMs: durationMs,
    gmail: {
      methods: methods,
      totalEstimatedUnits: totalEstimatedUnits,
      publishedReferenceLimitsPerMinute: {
        project: JEV_GMAIL_PROJECT_LIMIT_PER_MINUTE_,
        userPerProject: JEV_GMAIL_USER_LIMIT_PER_MINUTE_,
      },
    },
    classifierUrlFetchAttempts: metrics.classifierFetchAttempts,
  }));
}

function runJevBatchLocked_(config, metrics, runContext) {
  if (runContext.source === 'scheduled' && !config.enabled) {
    console.log('[JEV] Disabled; no Gmail search or API request made.');
    return { succeeded: 0, failed: 0, deferred: 0 };
  }
  if (!config.providers.some(function (p) { return p.apiKey; })) {
    console.error('[JEV] Enabled but JEV_API_KEY is empty; batch skipped.');
    return { succeeded: 0, failed: 0, deferred: 0 };
  }

  if (isJevCooldownActive_()) {
    console.log('[JEV] Gmail quota cooldown is active; batch skipped.');
    return { succeeded: 0, failed: 0, deferred: 0 };
  }

  let threadRefs;
  try {
    threadRefs = findUncategorizedThreads_(config, metrics, runContext);
  } catch (error) {
    if (isJevDeadlineError_(error)) return { succeeded: 0, failed: 0, deferred: 0, stopped: true, reason: 'deadline' };
    recordJevRateLimitIfNeeded_(error, true, config);
    console.error('[JEV] Gmail search failed; batch skipped: ' + getSafeErrorMessage_(error, config.apiKey));
    return { succeeded: 0, failed: 1, deferred: 0 };
  }

  const batch = threadRefs.slice(0, config.advanced.maxThreadsToClassify);
  console.log('[JEV] Found ' + threadRefs.length + ' candidate thread(s); classifying ' + batch.length + '.');
  if (!batch.length) {
    clearJevCooldown_();
    return { succeeded: 0, failed: 0, deferred: 0 };
  }

  let labelIdsByName;
  try {
    labelIdsByName = getLabelIdsByName_(metrics);
    getOrCreateLabelId_(JEV_PROCESSED_LABEL_, labelIdsByName, metrics);
  } catch (error) {
    if (isJevDeadlineError_(error)) return { succeeded: 0, failed: 0, deferred: batch.length, stopped: true, reason: 'deadline' };
    recordJevRateLimitIfNeeded_(error, true, config);
    console.error('[JEV] Could not read or create Gmail labels; batch skipped: ' + getSafeErrorMessage_(error, config.apiKey));
    return { succeeded: 0, failed: 1, deferred: 0, reason: 'label_setup' };
  }

  const summary = { succeeded: 0, failed: 0, deferred: 0, stopped: false };
  let pendingItems = [];
  for (let i = 0; i < batch.length; i += 1) {
    if (Date.now() >= runContext.deadlineAt) { summary.stopped = true; summary.deferred += batch.length - i; break; }
    if (summary.stopped) break;
    const threadRef = batch[i];
    let threadData;
    try {
      threadData = threadToJevState_(threadRef.id, metrics);
    } catch (error) {
      if (isJevDeadlineError_(error)) { summary.stopped = true; summary.deferred += batch.length - i; break; }
      error = addJevDiagnosticContextSafely_(error, { processingPhase: 'thread_read' });
      summary.failed += 1;
      logThreadProcessingError_(threadRef.id, error, config);
      if (isJevRateLimitError_(error)) {
        recordJevRateLimitIfNeeded_(error, true, config);
        summary.stopped = true;
        summary.deferred = Math.max(0, batch.length - summary.succeeded - summary.failed);
        console.error('[JEV] Stopping this batch after a rate-limit error; remaining thread(s) will be retried on a later trigger.');
        break;
      }
      continue;
    }

    const item = { threadId: threadRef.id, threadData: threadData, candidateIndex: i };
    truncateJevThreadToFit_(item, config.model, config);
    let proposedItems = pendingItems.concat([item]);
    let assessment = getJevBatchAssessment_(proposedItems, config.model, config);
    let violation = getJevBatchTokenViolation_(assessment, config);
    if (violation) {
      if (pendingItems.length) {
        flushJevThreadBatch_(pendingItems, config, labelIdsByName, metrics, summary, batch.length, runContext);
        pendingItems = [];
      }
      if (summary.stopped) break;

      proposedItems = [item];
      assessment = getJevBatchAssessment_(proposedItems, config.model, config);
      violation = getJevBatchTokenViolation_(assessment, config);
      if (violation) {
        const sizeError = new Error('JEV request exceeds supported token limits.');
        addJevDiagnosticContextSafely_(sizeError, {
          processingPhase: 'classification',
          estimatedTokens: violation.estimatedTokens,
          tokenLimit: violation.tokenLimit,
        });
        summary.failed += 1;
        logThreadProcessingError_(threadRef.id, sizeError, config);
        continue;
      }
    }

    pendingItems = proposedItems;
    if (assessment.estimatedRequestTokens >= config.advanced.batchTargetTokens) {
      flushJevThreadBatch_(pendingItems, config, labelIdsByName, metrics, summary, batch.length, runContext);
      pendingItems = [];
    }
  }

  if (!summary.stopped && pendingItems.length) {
    flushJevThreadBatch_(pendingItems, config, labelIdsByName, metrics, summary, batch.length, runContext);
  }
  if (summary.stopped) summary.deferred = Math.max(summary.deferred, batch.length - summary.succeeded - summary.failed);
  if (!summary.failed && !summary.deferred) clearJevCooldown_();
  console.log('[JEV] Batch complete: ' + summary.succeeded + ' succeeded, ' + summary.failed + ' failed, ' + summary.deferred + ' deferred.');
  return summary;
}

function isJevCooldownActive_() {
  const properties = PropertiesService.getScriptProperties();
  const until = Number(properties.getProperty(JEV_COOLDOWN_UNTIL_PROPERTY_));
  return Number.isFinite(until) && until > Date.now();
}

function recordJevRateLimitIfNeeded_(error, gmailOperation, config) {
  if (!isJevRateLimitError_(error)) return;
  if (!gmailOperation) return;
  const properties = PropertiesService.getScriptProperties();
  const priorStep = Number(properties.getProperty(JEV_COOLDOWN_STEP_PROPERTY_)) || 0;
  const durations = config && config.advanced ? config.advanced.cooldownMinutes : JEV_GMAIL_COOLDOWN_MINUTES_;
  const step = Math.min(priorStep, durations.length - 1);
  const duration = durations[step];
  properties.setProperty(JEV_COOLDOWN_STEP_PROPERTY_, String(Math.min(step + 1, durations.length - 1)));
  properties.setProperty(JEV_COOLDOWN_UNTIL_PROPERTY_, String(Date.now() + duration * 60 * 1000));
}

function clearJevCooldown_() {
  const properties = PropertiesService.getScriptProperties();
  deleteJevProperty_(properties, JEV_COOLDOWN_UNTIL_PROPERTY_);
  deleteJevProperty_(properties, JEV_COOLDOWN_STEP_PROPERTY_);
}

function deleteJevProperty_(properties, key) {
  if (typeof properties.deleteProperty === 'function') {
    properties.deleteProperty(key);
  } else {
    properties.setProperty(key, '');
  }
}

function assertJevRunTime_(context) {
  const active = context || JEV_ACTIVE_RUN_CONTEXT_;
  if (active && Date.now() >= active.deadlineAt) {
    const error = new Error('JEV execution time budget reached.');
    error.jevDeadlineReached = true;
    throw error;
  }
}
function isJevDeadlineError_(error) {
  return getJevPropertySafely_(error, 'jevDeadlineReached') === true;
}

function beforeJevGmailRequest_(context) {
  assertJevRunTime_(context);
  const now = Date.now();
  const active = context || JEV_ACTIVE_RUN_CONTEXT_;
  const config = active && active.config;
  const spacing = config ? config.advanced.gmailSpacingMs : 1000;
  const wait = spacing - (now - JEV_LAST_GMAIL_REQUEST_AT_);
  if (JEV_LAST_GMAIL_REQUEST_AT_ && wait > 0) {
    if (active && Date.now() + wait >= active.deadlineAt) {
      const expired = new Error('JEV execution time budget reached.'); expired.jevDeadlineReached = true; throw expired;
    }
    Utilities.sleep(wait);
    assertJevRunTime_(active);
  }
  JEV_LAST_GMAIL_REQUEST_AT_ = Date.now();
}

function getJevPropertySafely_(object, key) {
  try {
    return object == null ? undefined : object[key];
  } catch (ignoredPropertyReadError) {
    return undefined;
  }
}

function getSafeErrorMessage_(error, apiKey) {
  const diagnosticContext = getJevPropertySafely_(error, 'jevDiagnosticContext');
  if (diagnosticContext && getJevPropertySafely_(diagnosticContext, 'bodyDecode')) {
    return getJevPropertySafely_(error, 'message') === 'Could not decode string.' ? 'Could not decode string.' : 'Body decoding failed.';
  }
  const status = getSafeHttpStatus_(error);
  if (status !== null) return 'Request failed with HTTP ' + status + '.';
  if (isJevRateLimitError_(error)) return 'Gmail rate limit exceeded.';
  const knownMessages = [
    'JEV API returned invalid JSON.', 'JEV API response is missing answers.',
    'JEV API response has an invalid category answer.', 'Thread contains no eligible messages.',
    'Thread exceeds the Gmail batch label limit.', 'Gmail did not return a label ID.',
    'JEV request exceeds supported token limits.',
    'JEV_SCOPE must be INBOX or ALL.',
    'JEV_INTERVAL_MINUTES must be 1, 5, 10, 15, or 30.',
    'JEV_MODEL must not be empty.',
    'JEV_API_URL must be a complete HTTPS endpoint, such as https://api.typesafe.ai/v1/systemone.',
    'JEV_ENABLED must be true or false.',
  ];
  const rawMessage = getJevPropertySafely_(error, 'message');
  const message = typeof rawMessage === 'string' ? rawMessage : '';
  return knownMessages.indexOf(message) >= 0 ? message : 'Processing failed.';
}

function getSafeErrorName_(error, apiKey) {
  const rawName = getJevPropertySafely_(error, 'name');
  const name = typeof rawName === 'string' ? rawName : 'Error';
  return ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'GoogleJsonResponseException'].indexOf(name) >= 0 ? name : 'Error';
}

function getSafeErrorStack_(error, apiKey) {
  const context = getJevPropertySafely_(error, 'jevDiagnosticContext');
  if (context && getJevPropertySafely_(context, 'bodyDecode')) {
    // A decoder can place fragments of the current body in its stack. That
    // body was not decoded, so it cannot be reliably redacted by value.
    return '[omitted for body decoding failure]';
  }
  return '[omitted]';
}

function getSafeHttpStatus_(error) {
  const status = getJevPropertySafely_(error, 'statusCode');
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function getJevErrorObject_(error) {
  if (error && typeof error === 'object') return error;
  return new Error(error === undefined || error === null ? 'Unknown error' : String(error));
}

function addJevDiagnosticContext_(error, context) {
  const diagnosticError = getJevErrorObject_(error);
  const current = diagnosticError.jevDiagnosticContext || {};
  diagnosticError.jevDiagnosticContext = Object.assign({}, current, context || {});
  return diagnosticError;
}

function addJevDiagnosticContextSafely_(error, context) {
  try {
    return addJevDiagnosticContext_(error, context);
  } catch (ignoredContextError) {
    return error;
  }
}

function logThreadProcessingError_(threadId, error, apiKey) {
  const diagnosticContext = getJevPropertySafely_(error, 'jevDiagnosticContext');
  const context = diagnosticContext && typeof diagnosticContext === 'object' ? diagnosticContext : {};
  const processingPhase = getJevPropertySafely_(context, 'processingPhase');
  const safeThreadId = typeof threadId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(threadId) ? threadId : '[invalid thread id]';
  const details = {
    threadId: safeThreadId,
    phase: ['thread_read', 'classification', 'label_resolution', 'gmail_labeling'].indexOf(processingPhase) >= 0 ? processingPhase : 'unknown',
    errorName: getSafeErrorName_(error, apiKey),
    message: getSafeErrorMessage_(error, apiKey),
    stack: getSafeErrorStack_(error, apiKey),
  };
  const bodyDecode = getJevPropertySafely_(context, 'bodyDecode');
  if (bodyDecode && typeof bodyDecode === 'object') {
    const bodyDecodeFields = [
      'messageOrdinal',
      'mimePartPath',
      'mimeType',
      'encodedDataLength',
      'decodeStage',
      'encodedInputType',
      'encodedObjectCategory',
      'encodedDataLengthModulo4',
      'base64UrlAlphabetValid',
      'invalidCharacterCount',
      'paddingCharacterCount',
      'trailingPaddingCount',
      'paddingPlacementValid',
      'paddingShapeValid',
      'base64ShapeValid',
      'byteArrayValidationValid',
      'byteArrayInvalidElementCount',
      'byteArrayNormalizationCount',
      'expectedBodySize',
      'bodySizeMatches',
    ];
    bodyDecodeFields.forEach(function (field) {
      const value = getJevPropertySafely_(bodyDecode, field);
      if (field === 'mimeType') {
        details[field] = value === 'text/plain' || value === 'text/html' ? value : 'other';
      } else if (field === 'mimePartPath') {
        if (typeof value === 'string' && value.length <= 100 && /^(?:0|[0-9]{1,6})(?:\.[0-9]{1,6}){0,20}$/.test(value)) details[field] = value;
      } else if (field === 'decodeStage') {
        if (['base64_decode', 'byte_array_validation', 'input_validation', 'blob_utf8_conversion'].indexOf(value) >= 0) details[field] = value;
      } else if (field === 'encodedInputType') {
        if (['string', 'object', 'number', 'undefined', 'boolean', 'function', 'symbol', 'bigint'].indexOf(value) >= 0) details[field] = value;
      } else if (field === 'encodedObjectCategory') {
        if (['primitive_string', 'array', 'other', 'unknown'].indexOf(value) >= 0) details[field] = value;
      } else if (typeof value === 'boolean') {
        details[field] = value;
      } else if (Number.isInteger(value) && value >= 0 && value <= 1000000000) {
        details[field] = value;
      }
    });
  }
  const estimatedTokens = getJevPropertySafely_(context, 'estimatedTokens');
  const tokenLimit = getJevPropertySafely_(context, 'tokenLimit');
  if (Number.isInteger(estimatedTokens) && estimatedTokens >= 0 && estimatedTokens <= 1000000) {
    details.estimatedTokens = estimatedTokens;
  }
  if (Number.isInteger(tokenLimit) && tokenLimit >= 0 && tokenLimit <= 1000000) {
    details.tokenLimit = tokenLimit;
  }
  const status = getSafeHttpStatus_(error);
  const responseBody = getJevPropertySafely_(context, 'responseBody');
  if (status !== null && status >= 400 && status <= 599 && typeof responseBody === 'string') {
    let safeResponseBody = responseBody;
    safeResponseBody = redactJevKeys_(safeResponseBody, typeof apiKey === 'object' ? apiKey : { apiKey: apiKey });
    if (safeResponseBody.length > JEV_HTTP_ERROR_BODY_MAX_LENGTH_) {
      details.responseBody = safeResponseBody.slice(0, JEV_HTTP_ERROR_BODY_MAX_LENGTH_);
      details.responseBodyTruncated = true;
    } else {
      details.responseBody = safeResponseBody;
    }
  }
  console.error('[JEV] Thread processing failed: ' + JSON.stringify(details));
}

function isJevRateLimitError_(error) {
  if (!error) return false;
  const statusCode = getJevPropertySafely_(error, 'statusCode');
  if (statusCode === 429 || statusCode === 529) return true;

  const rawName = getJevPropertySafely_(error, 'name');
  const rawMessage = getJevPropertySafely_(error, 'message');
  const errorName = typeof rawName === 'string' ? rawName.toLowerCase() : '';
  const message = typeof rawMessage === 'string' ? rawMessage.toLowerCase() : '';
  if (errorName !== 'googlejsonresponseexception') return false;
  return /user[\s-]?rate[\s-]?limit[\s-]?exceeded|rate[\s-]?limit[\s-]?exceeded|quota[\s-]?exceeded|daily[\s-]?limit[\s-]?exceeded/i.test(message);
}

/** Keeps one runJevBatch trigger and reconciles it after interval changes. */
function ensureJevTrigger_(intervalMinutes) {
  reconcileJevTrigger_(intervalMinutes, false);
}

function repairJevTrigger_(intervalMinutes) {
  reconcileJevTrigger_(intervalMinutes, true);
}

function reconcileJevTrigger_(intervalMinutes, forceRepair) {
  const properties = PropertiesService.getScriptProperties();
  const existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === JEV_TRIGGER_HANDLER_;
  });
  function isClock(trigger) { return typeof trigger.getEventType === 'function' && trigger.getEventType() === ScriptApp.EventType.CLOCK; }
  let record = null;
  try { record = JSON.parse(properties.getProperty(JEV_TRIGGER_RECORD_PROPERTY_) || 'null'); } catch (ignoredRecordParse) {}
  if (!record || record.schemaVersion !== 1 || JEV_SUPPORTED_INTERVALS_.indexOf(record.intervalMinutes) < 0 || typeof record.triggerId !== 'string') {
    const legacyId = properties.getProperty(JEV_TRIGGER_ID_PROPERTY_);
    const legacyInterval = Number(properties.getProperty(JEV_TRIGGER_INTERVAL_PROPERTY_));
    const legacyTrigger = existing.filter(function (t) { return isClock(t) && typeof t.getUniqueId === 'function' && t.getUniqueId() === legacyId; })[0];
    if (legacyTrigger && JEV_SUPPORTED_INTERVALS_.indexOf(legacyInterval) >= 0) {
      record = { schemaVersion: 1, intervalMinutes: legacyInterval, triggerId: String(legacyId) };
      properties.setProperty(JEV_TRIGGER_RECORD_PROPERTY_, JSON.stringify(record));
    }
  }
  const recorded = existing.filter(function (t) { return isClock(t) && typeof t.getUniqueId === 'function' && t.getUniqueId() === (record && record.triggerId); })[0];
  if (recorded && record.intervalMinutes === intervalMinutes) {
    existing.forEach(function (t) { if (t !== recorded) ScriptApp.deleteTrigger(t); });
    try { properties.deleteProperty(JEV_TRIGGER_INTERVAL_PROPERTY_); properties.deleteProperty(JEV_TRIGGER_ID_PROPERTY_); } catch (ignoredLegacyCleanup) {}
    return;
  }
  const created = ScriptApp.newTrigger(JEV_TRIGGER_HANDLER_).timeBased().everyMinutes(intervalMinutes).create();
  const triggerId = created && typeof created.getUniqueId === 'function' ? String(created.getUniqueId()) : '';
  if (!triggerId) throw new Error('Could not record replacement JEV trigger.');
  const replacementRecord = { schemaVersion: 1, intervalMinutes: intervalMinutes, triggerId: triggerId };
  try {
    properties.setProperty(JEV_TRIGGER_RECORD_PROPERTY_, JSON.stringify(replacementRecord));
  } catch (recordWriteError) {
    try { ScriptApp.deleteTrigger(created); } catch (ignoredReplacementCleanup) {}
    throw recordWriteError;
  }
  try { properties.deleteProperty(JEV_TRIGGER_INTERVAL_PROPERTY_); properties.deleteProperty(JEV_TRIGGER_ID_PROPERTY_); } catch (ignoredLegacyCleanup) {}
  // The newly recorded trigger is authoritative. If deletion fails, repair will
  // reuse it and remove the extras without creating another replacement.
  existing.forEach(function (trigger) { if (typeof trigger.getUniqueId === 'function' && trigger.getUniqueId() !== triggerId) ScriptApp.deleteTrigger(trigger); });
}

/** Returns at most maxThreads unprocessed Gmail threads for the chosen scope. */
function findUncategorizedThreads_(config, metrics, runContext) {
  const scopeQuery = config.scope === 'INBOX' ? 'in:inbox' : 'in:anywhere';
  const query = scopeQuery + ' -in:spam -in:trash -in:sent -in:drafts -label:' + JEV_PROCESSED_LABEL_;
  beforeJevGmailRequest_(runContext);
  metrics.gmailAttempts['threads.list'] += 1;
  const result = Gmail.Users.Threads.list('me', {
    q: query,
    maxResults: Math.min(config.advanced.maxThreadsToFetch, 100),
  });
  return result && result.threads ? result.threads.filter(function (thread) {
    return Boolean(thread && thread.id);
  }) : [];
}

/** Serializes incoming messages in the thread, excluding Spam, Trash, Sent, and Drafts. */
function threadToJevState_(threadId, metrics) {
  beforeJevGmailRequest_();
  metrics.gmailAttempts['threads.get'] += 1;
  const thread = Gmail.Users.Threads.get('me', threadId, { format: 'full' });
  const allMessages = thread && thread.messages ? thread.messages : [];
  const eligibleMessages = allMessages.filter(function (message) {
    const labels = message.labelIds || [];
    return labels.indexOf('SPAM') < 0 &&
      labels.indexOf('TRASH') < 0 &&
      labels.indexOf('SENT') < 0 &&
      labels.indexOf('DRAFT') < 0;
  });

  if (!eligibleMessages.length) {
    throw new Error('Thread contains no eligible messages.');
  }

  const messages = eligibleMessages.map(function (message, index) {
    const payload = message.payload || {};
    const sender = getHeaderValue_(payload.headers, 'From');
    const subject = getHeaderValue_(payload.headers, 'Subject');
    let body;
    try {
      body = getPlainTextBody_(payload, index + 1);
    } catch (error) {
      throw error;
    }
    return { sender: sender, subject: subject, body: body };
  });

  return {
    state: { messages: messages },
    messageIds: eligibleMessages.map(function (message) { return message.id; }),
  };
}

function getHeaderValue_(headers, name) {
  const target = String(name).toLowerCase();
  const match = (headers || []).filter(function (header) {
    return String(header.name || '').toLowerCase() === target;
  })[0];
  return match ? String(match.value || '') : '';
}

function getPlainTextBody_(payload, messageOrdinal) {
  const bodies = { plain: [], html: [] };
  collectBodyParts_(payload, bodies, false, {
    messageOrdinal: messageOrdinal,
    mimePartPath: '0',
  });
  if (bodies.plain.length) return bodies.plain.join('\n\n').trim();
  if (bodies.html.length) return htmlToPlainText_(bodies.html.join('\n\n'));
  return '';
}

function collectBodyParts_(part, bodies, isAttachment, context) {
  if (!part || isAttachment || part.filename) return;
  const mimeType = normalizeMimeType_(part.mimeType);
  const data = part.body && part.body.data;
  if (data !== undefined && data !== null) {
    let decoded;
    try {
      decoded = decodeBase64Url_(data, part.body.size);
    } catch (error) {
      const currentContext = getJevPropertySafely_(error, 'jevDiagnosticContext');
      const probe = getJevPropertySafely_(currentContext, 'bodyDecodeProbe');
      const bodyDecode = {
        messageOrdinal: context.messageOrdinal,
        mimePartPath: context.mimePartPath,
        mimeType: mimeType,
      };
      [
        'encodedDataLength', 'decodeStage', 'encodedInputType', 'encodedObjectCategory',
        'encodedDataLengthModulo4', 'base64UrlAlphabetValid', 'invalidCharacterCount',
        'paddingCharacterCount', 'trailingPaddingCount', 'paddingPlacementValid',
        'paddingShapeValid', 'base64ShapeValid', 'byteArrayValidationValid',
        'byteArrayInvalidElementCount', 'byteArrayNormalizationCount', 'expectedBodySize',
        'bodySizeMatches',
      ].forEach(function (field) {
        const value = getJevPropertySafely_(probe, field);
        if (value !== undefined) bodyDecode[field] = value;
      });
      if (bodyDecode.encodedDataLength === undefined) {
        bodyDecode.encodedDataLength = typeof data === 'string' ? data.length : null;
      }
      error = addJevDiagnosticContextSafely_(error, {
        bodyDecode: bodyDecode,
      });
      throw error;
    }
    if (mimeType === 'text/plain') bodies.plain.push(decoded);
    else if (mimeType === 'text/html') bodies.html.push(decoded);
  }
  (part.parts || []).forEach(function (child, index) {
    collectBodyParts_(child, bodies, Boolean(child && child.filename), {
      messageOrdinal: context.messageOrdinal,
      mimePartPath: context.mimePartPath + '.' + index,
    });
  });
}

function normalizeMimeType_(mimeType) {
  return String(mimeType || '').split(';')[0].trim().toLowerCase();
}

function decodeBase64Url_(encoded, optionalExpectedSize) {
  let decodedBytes;
  let decodeStage;
  let byteArrayMetadata = {};
  let encodedIsArray = false;
  try {
    encodedIsArray = Array.isArray(encoded);
  } catch (ignoredArrayInspectionError) {
    // Treat an uninspectable object as an unsupported input type.
  }
  if (typeof encoded === 'string') {
    decodeStage = 'base64_decode';
    try {
      decodedBytes = Utilities.base64DecodeWebSafe(encoded);
    } catch (error) {
      throw addBodyDecodeProbeSafely_(error, decodeStage, encoded, optionalExpectedSize);
    }
  } else if (encodedIsArray) {
    decodeStage = 'byte_array_validation';
    try {
      const validated = validateBodyByteArray_(encoded, optionalExpectedSize);
      decodedBytes = validated.bytes;
      byteArrayMetadata = validated.metadata;
    } catch (error) {
      throw addBodyDecodeProbeSafely_(error, decodeStage, encoded, optionalExpectedSize);
    }
  } else {
    decodeStage = 'input_validation';
    const error = new Error('Body data must be a Base64URL string or byte array.');
    throw addBodyDecodeProbeSafely_(error, decodeStage, encoded, optionalExpectedSize);
  }

  try {
    return Utilities.newBlob(decodedBytes).getDataAsString('UTF-8');
  } catch (error) {
    throw addBodyDecodeProbeSafely_(error, 'blob_utf8_conversion', encoded, optionalExpectedSize, byteArrayMetadata);
  }
}

function validateBodyByteArray_(encoded, optionalExpectedSize) {
  const bytes = [];
  let invalidElementCount = 0;
  let normalizationCount = 0;
  for (let i = 0; i < encoded.length; i += 1) {
    const value = encoded[i];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < -128 || value > 255) {
      invalidElementCount += 1;
      continue;
    }
    if (value > 127) {
      bytes.push(value - 256);
      normalizationCount += 1;
    } else {
      bytes.push(value);
    }
  }

  const hasExpectedSize = optionalExpectedSize !== undefined;
  const expectedSizeValid = !hasExpectedSize || isValidBodySize_(optionalExpectedSize);
  const sizeMatches = !hasExpectedSize || (expectedSizeValid && encoded.length === optionalExpectedSize);
  const metadata = {
    encodedInputType: typeof encoded,
    encodedObjectCategory: 'array',
    encodedDataLength: encoded.length,
    byteArrayValidationValid: invalidElementCount === 0,
    byteArrayInvalidElementCount: invalidElementCount,
    byteArrayNormalizationCount: normalizationCount,
    expectedBodySize: expectedSizeValid && hasExpectedSize ? optionalExpectedSize : null,
    bodySizeMatches: sizeMatches,
  };

  if (invalidElementCount > 0) throw addBodyByteArrayMetadata_(new Error('Body byte array contains invalid byte values.'), metadata);
  if (!expectedSizeValid) throw addBodyByteArrayMetadata_(new Error('Body byte array declared size is invalid.'), metadata);
  return { bytes: bytes, metadata: metadata };
}

function isValidBodySize_(size) {
  return typeof size === 'number' && Number.isInteger(size) && size >= 0;
}

function addBodyByteArrayMetadata_(error, metadata) {
  error.jevBodyByteArrayMetadata = metadata;
  return error;
}

function addBodyDecodeProbeSafely_(error, stage, encoded, optionalExpectedSize, byteArrayMetadata) {
  let probe = {};
  try {
    probe = getBase64UrlShapeMetadataSafely_(encoded, optionalExpectedSize);
  } catch (ignoredProbeError) {
    probe = { encodedInputType: typeof encoded, encodedObjectCategory: 'unknown' };
  }
  if (byteArrayMetadata) Object.assign(probe, byteArrayMetadata);
  const existingByteArrayMetadata = getJevPropertySafely_(error, 'jevBodyByteArrayMetadata');
  if (existingByteArrayMetadata && typeof existingByteArrayMetadata === 'object') {
    [
      'encodedInputType', 'encodedObjectCategory', 'encodedDataLength', 'byteArrayValidationValid',
      'byteArrayInvalidElementCount', 'byteArrayNormalizationCount', 'expectedBodySize', 'bodySizeMatches',
    ].forEach(function (field) {
      const value = getJevPropertySafely_(existingByteArrayMetadata, field);
      if (value !== undefined) probe[field] = value;
    });
  }
  return addJevDiagnosticContextSafely_(error, {
    bodyDecodeProbe: Object.assign({ decodeStage: stage }, probe),
  });
}

function getBase64UrlShapeMetadataSafely_(encoded, optionalExpectedSize) {
  const metadata = {
    encodedInputType: typeof encoded,
    encodedObjectCategory: 'other',
    encodedDataLength: null,
    encodedDataLengthModulo4: null,
    base64UrlAlphabetValid: null,
    invalidCharacterCount: null,
    paddingCharacterCount: null,
    trailingPaddingCount: null,
    paddingPlacementValid: null,
    paddingShapeValid: null,
    base64ShapeValid: null,
    byteArrayValidationValid: null,
    byteArrayInvalidElementCount: null,
    byteArrayNormalizationCount: null,
    expectedBodySize: isValidBodySize_(optionalExpectedSize) ? optionalExpectedSize : null,
    bodySizeMatches: null,
  };

  if (typeof encoded === 'string') {
    metadata.encodedObjectCategory = 'primitive_string';
    const length = encoded.length;
    const lengthModulo4 = length % 4;
    let invalidCharacterCount = 0;
    let paddingCharacterCount = 0;
    for (let i = 0; i < length; i += 1) {
      const character = encoded.charAt(i);
      if (character === '=') paddingCharacterCount += 1;
      else if (!/[A-Za-z0-9_-]/.test(character)) invalidCharacterCount += 1;
    }
    const trailingMatch = encoded.match(/={1,}$/);
    const trailingPaddingCount = trailingMatch ? trailingMatch[0].length : 0;
    const paddingPlacementValid = paddingCharacterCount === trailingPaddingCount;
    const paddingShapeValid = paddingPlacementValid &&
      (paddingCharacterCount === 0 || (paddingCharacterCount <= 2 && lengthModulo4 === 0));
    metadata.encodedDataLength = length;
    metadata.encodedDataLengthModulo4 = lengthModulo4;
    metadata.base64UrlAlphabetValid = invalidCharacterCount === 0;
    metadata.invalidCharacterCount = invalidCharacterCount;
    metadata.paddingCharacterCount = paddingCharacterCount;
    metadata.trailingPaddingCount = trailingPaddingCount;
    metadata.paddingPlacementValid = paddingPlacementValid;
    metadata.paddingShapeValid = paddingShapeValid;
    metadata.base64ShapeValid = metadata.base64UrlAlphabetValid && paddingShapeValid &&
      (trailingPaddingCount > 0 || lengthModulo4 !== 1);
    metadata.expectedBodySize = isValidBodySize_(optionalExpectedSize) ? optionalExpectedSize : null;
    metadata.bodySizeMatches = null;
    return metadata;
  }

  if (Array.isArray(encoded)) {
    metadata.encodedObjectCategory = 'array';
    metadata.encodedDataLength = encoded.length;
    let invalidElementCount = 0;
    let normalizationCount = 0;
    for (let i = 0; i < encoded.length; i += 1) {
      const value = encoded[i];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < -128 || value > 255) {
        invalidElementCount += 1;
      } else if (value > 127) {
        normalizationCount += 1;
      }
    }
    metadata.byteArrayValidationValid = invalidElementCount === 0;
    metadata.byteArrayInvalidElementCount = invalidElementCount;
    metadata.byteArrayNormalizationCount = normalizationCount;
    const hasExpectedSize = optionalExpectedSize !== undefined;
    const expectedSizeValid = !hasExpectedSize || isValidBodySize_(optionalExpectedSize);
    metadata.expectedBodySize = expectedSizeValid && hasExpectedSize ? optionalExpectedSize : null;
    metadata.bodySizeMatches = !hasExpectedSize || (expectedSizeValid && encoded.length === optionalExpectedSize);
  }
  return metadata;
}

function htmlToPlainText_(html) {
  return String(html)
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/** Estimates tokens as one token per four serialized JSON characters. */
function estimateJevTokenCount_(serializedJson) {
  return Math.ceil(String(serializedJson).length / JEV_CLASSIFY_TOKEN_CHARS_PER_TOKEN_);
}

/** Truncates only message bodies when a singleton thread exceeds either request limit. */
function truncateJevThreadToFit_(item, model, config) {
  const originalAssessment = getJevBatchAssessment_([item], model, config);
  if (!getJevBatchTokenViolation_(originalAssessment, config)) return;

  const messages = item.threadData.state.messages;
  const originalBodies = messages.map(function (message) { return message.body; });
  const longestBodyLength = originalBodies.reduce(function (longest, body) {
    return Math.max(longest, body ? body.length : 0);
  }, 0);
  if (!longestBodyLength) return;

  function applyBodyLengthCap(cap) {
    messages.forEach(function (message, index) {
      const body = originalBodies[index];
      if (!body || body.length <= cap) {
        message.body = body;
        return;
      }
      let prefixLength = cap;
      // Do not leave half of a UTF-16 surrogate pair at the truncation boundary.
      if (prefixLength > 0 && prefixLength < body.length) {
        const last = body.charCodeAt(prefixLength - 1);
        const next = body.charCodeAt(prefixLength);
        if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) prefixLength -= 1;
      }
      message.body = body.slice(0, prefixLength) + JEV_BODY_TRUNCATION_MARKER_;
    });
  }

  // A zero-length cap checks whether fixed metadata and marker overhead can fit.
  applyBodyLengthCap(0);
  if (getJevBatchTokenViolation_(getJevBatchAssessment_([item], model, config), config)) {
    originalBodies.forEach(function (body, index) { messages[index].body = body; });
    return;
  }

  // Cap the longest bodies first so short messages remain intact when possible.
  let low = 0;
  let high = longestBodyLength;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    applyBodyLengthCap(middle);
    if (getJevBatchTokenViolation_(getJevBatchAssessment_([item], model, config), config)) high = middle;
    else low = middle;
  }
  applyBodyLengthCap(low);
}

/** Builds a complete Jev request and estimates its documented token limits. */
function getJevBatchAssessment_(items, model, config) {
  const state = { threads: {} };
  const questions = {};
  const answerMappings = [];
  const categories = getEnabledJevCategories_(config || getJevConfig_());

  items.forEach(function (item, itemIndex) {
    const threadKey = 'item_' + ('000' + itemIndex).slice(-3);
    state.threads[threadKey] = item.threadData.state;
    categories.forEach(function (category) {
      const questionKey = threadKey + '__' + category.key;
      const question = {
        type: 'noul',
        instructions: 'Use only state.threads.' + threadKey + ' (this thread’s eligible messages). Does this email thread fit the ' + category.label + ' category?',
        criteria: {
          true: category.description,
          false: 'The thread does not fit this category.',
        },
      };
      questions[questionKey] = question;
      answerMappings.push({
        questionKey: questionKey,
        itemIndex: itemIndex,
        categoryKey: category.key,
        stateKey: threadKey,
      });
    });
  });

  const payload = { model: model, state: state, questions: questions };
  const serializedPayload = JSON.stringify(payload);
  let estimatedStateQuestionTokens = 0;
  answerMappings.forEach(function (mapping) {
    const questionScope = {
      state: state,
      question: questions[mapping.questionKey],
    };
    estimatedStateQuestionTokens = Math.max(
      estimatedStateQuestionTokens,
      estimateJevTokenCount_(JSON.stringify(questionScope))
    );
  });

  return {
    payload: payload,
    serializedPayload: serializedPayload,
    answerMappings: answerMappings,
    estimatedRequestTokens: estimateJevTokenCount_(serializedPayload),
    estimatedStateQuestionTokens: estimatedStateQuestionTokens,
  };
}

function getJevBatchTokenViolation_(assessment, config) {
  const advanced = (config || getJevConfig_()).advanced;
  if (assessment.estimatedRequestTokens > advanced.maxRequestTokens) {
    return {
      estimatedTokens: assessment.estimatedRequestTokens,
      tokenLimit: advanced.maxRequestTokens,
    };
  }
  if (assessment.estimatedStateQuestionTokens > advanced.maxStateQuestionTokens) {
    return {
      estimatedTokens: assessment.estimatedStateQuestionTokens,
      tokenLimit: advanced.maxStateQuestionTokens,
    };
  }
  return null;
}

/** Sends a batch with nine uniquely keyed questions for each Gmail thread. */
function classifyThreadBatch_(items, config, metrics) {
  const profiles = config.providers || [{ id:'provider-1', apiUrl:config.apiUrl, model:config.model, apiKey:config.apiKey }];
  const context = JEV_ACTIVE_RUN_CONTEXT_ || { providerCursor: 0 };
  let lastError = null;
  let rateLimitError = null;
  for (let offset = 0; offset < profiles.length; offset += 1) {
    const index = (context.providerCursor + offset) % profiles.length;
    const profile = profiles[index];
    if (!profile.apiKey) continue;
    try {
      const classifications = classifyThreadBatchWithProvider_(items, config, metrics, profile);
      context.providerCursor = index;
      return classifications;
    } catch (error) {
      if (isJevDeadlineError_(error)) throw error;
      lastError = error;
      if (isJevRateLimitError_(error)) rateLimitError = error;
    }
  }
  throw rateLimitError || lastError || new Error('No configured provider key is available.');
}

function classifyThreadBatchWithProvider_(items, config, metrics, profile) {
  const assessment = getJevBatchAssessment_(items, profile.model, config);
  const violation = getJevBatchTokenViolation_(assessment, config);
  if (violation) {
    const sizeError = new Error('JEV request exceeds supported token limits.');
    addJevDiagnosticContextSafely_(sizeError, {
      processingPhase: 'classification',
      estimatedTokens: violation.estimatedTokens,
      tokenLimit: violation.tokenLimit,
    });
    throw sizeError;
  }

  const requestOptions = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + profile.apiKey },
    payload: assessment.serializedPayload,
    followRedirects: false,
    muteHttpExceptions: true,
  };
  let response;
  for (let attempt = 0; attempt < config.advanced.providerAttempts; attempt += 1) {
    assertJevRunTime_();
    metrics.classifierFetchAttempts += 1;
    try { response = UrlFetchApp.fetch(profile.apiUrl, requestOptions); } catch (networkError) { throw new Error('JEV provider request failed.'); }
    const responseStatus = response.getResponseCode();
    if ((responseStatus === 429 || responseStatus === 529) && attempt + 1 < config.advanced.providerAttempts) {
      const delay = config.advanced.initialRetryDelayMs * Math.pow(2, attempt);
      if (JEV_ACTIVE_RUN_CONTEXT_ && Date.now() + delay >= JEV_ACTIVE_RUN_CONTEXT_.deadlineAt) { const expired = new Error('JEV execution time budget reached.'); expired.jevDeadlineReached = true; throw expired; }
      Utilities.sleep(delay);
      continue;
    }
    break;
  }

  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    const error = new Error('JEV API returned HTTP ' + status + '.');
    error.statusCode = status;
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      let responseBody = JEV_HTTP_ERROR_BODY_UNAVAILABLE_;
      try {
        const body = response.getContentText();
        if (typeof body === 'string') responseBody = body;
      } catch (ignoredBodyReadError) {
        // Provider body diagnostics are best effort and never replace the HTTP error.
      }
      addJevDiagnosticContextSafely_(error, { responseBody: redactJevKeys_(responseBody, config) });
    }
    throw error;
  }

  let result;
  try {
    result = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error('JEV API returned invalid JSON.');
  }
  if (!result || !result.answers || typeof result.answers !== 'object' || Array.isArray(result.answers)) {
    throw new Error('JEV API response is missing answers.');
  }

  const scoresByItem = items.map(function () { return Object.create(null); });
  assessment.answerMappings.forEach(function (mapping) {
    if (!Object.prototype.hasOwnProperty.call(result.answers, mapping.questionKey)) {
      throw new Error('JEV API response is missing answers.');
    }
    const answer = result.answers[mapping.questionKey];
    if (!answer || answer.type !== 'noul' || typeof answer.noul !== 'number' ||
        !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
      throw new Error('JEV API response has an invalid category answer.');
    }
    scoresByItem[mapping.itemIndex][mapping.categoryKey] = answer.noul;
  });

  return items.map(function (item, index) {
    return { item: item, scores: scoresByItem[index] };
  });
}

function redactJevKeys_(text, config) {
  let result = String(text || '');
  (config && config.providers || []).forEach(function (p) { if (p.apiKey) result = result.split(p.apiKey).join('[redacted API key]'); });
  if (config && config.apiKey) result = result.split(config.apiKey).join('[redacted API key]');
  return result;
}

function getLabelIdsByName_(metrics) {
  beforeJevGmailRequest_();
  metrics.gmailAttempts['labels.list'] += 1;
  const result = Gmail.Users.Labels.list('me');
  const labels = result && result.labels ? result.labels : [];
  const byName = Object.create(null);
  labels.forEach(function (label) {
    // Only USER labels can be added safely; Gmail system labels can move mail
    // (for example TRASH, SPAM, SENT, or INBOX) when applied.
    if (label && label.type === 'user' && label.name && label.id) byName[label.name] = label.id;
  });
  return byName;
}

function getOrCreateLabelId_(name, labelIdsByName, metrics) {
  if (Object.prototype.hasOwnProperty.call(labelIdsByName, name)) return labelIdsByName[name];
  let created;
  try {
    beforeJevGmailRequest_();
    metrics.gmailAttempts['labels.create'] += 1;
    created = Gmail.Users.Labels.create({
      name: name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    }, 'me');
  } catch (createError) {
    if (isJevRateLimitError_(createError)) throw createError;
    try {
      const refreshedLabelIdsByName = getLabelIdsByName_(metrics);
      if (refreshedLabelIdsByName[name]) {
        labelIdsByName[name] = refreshedLabelIdsByName[name];
        return refreshedLabelIdsByName[name];
      }
    } catch (refreshError) {
      if (isJevRateLimitError_(refreshError)) throw refreshError;
      // Keep the original create failure as the actionable error.
    }
    throw createError;
  }
  if (!created || !created.id) throw new Error('Gmail did not return a label ID.');
  labelIdsByName[name] = created.id;
  return created.id;
}

/** Applies one validated thread result to only that thread's eligible messages. */
function applyThreadLabels_(threadData, scores, labelIdsByName, metrics, config) {
  let phase = 'thread_read';
  try {
    const labelsToAdd = [];

    phase = 'label_resolution';
    const matched = [];
    getEnabledJevCategories_(config).forEach(function (category) {
      const threshold = category.threshold === null ? config.defaultThreshold : category.threshold;
      if (scores[category.key] > threshold) {
        matched.push(category);
      }
    });
    matched.forEach(function (category) {
        labelsToAdd.push(getOrCreateLabelId_(category.label, labelIdsByName, metrics));
    });
    if (!matched.length) labelsToAdd.push(getOrCreateLabelId_(config.fallbackLabel, labelIdsByName, metrics));
    labelsToAdd.push(getOrCreateLabelId_(JEV_PROCESSED_LABEL_, labelIdsByName, metrics));

    // Gmail's batch modify limit is 1,000 message IDs per request. Refuse an
    // unusually large thread before changing any labels; it will remain eligible
    // for retry after the thread is handled separately.
    if (threadData.messageIds.length > 1000) {
      throw new Error('Thread exceeds the Gmail batch label limit.');
    }

    // Label only eligible incoming messages in one request, leaving Spam, Trash,
    // Sent, and Draft messages untouched even when they share a conversation.
    phase = 'gmail_labeling';
    beforeJevGmailRequest_();
    metrics.gmailAttempts['messages.batchModify'] += 1;
    Gmail.Users.Messages.batchModify({
      addLabelIds: labelsToAdd,
      ids: threadData.messageIds,
    }, 'me');
  } catch (error) {
    error = addJevDiagnosticContextSafely_(error, { processingPhase: phase });
    throw error;
  }
}

/** Classifies one packed request, then applies each validated result in item order. */
function flushJevThreadBatch_(items, config, labelIdsByName, metrics, summary, totalCandidates, runContext) {
  if (!items.length) return;

  let classifications;
  try {
    classifications = classifyThreadBatch_(items, config, metrics);
  } catch (error) {
    if (isJevDeadlineError_(error)) {
      summary.stopped = true;
      summary.deferred += items.length;
      return;
    }
    error = addJevDiagnosticContextSafely_(error, { processingPhase: 'classification' });
    items.forEach(function (item) {
      summary.failed += 1;
      logThreadProcessingError_(item.threadId, error, config);
    });
    if (isJevRateLimitError_(error)) {
      summary.stopped = true;
      summary.deferred = Math.max(0, totalCandidates - summary.succeeded - summary.failed);
      console.error('[JEV] Stopping this batch after a rate-limit error; remaining thread(s) will be retried on a later trigger.');
    }
    return;
  }

  for (let i = 0; i < classifications.length; i += 1) {
    if (summary.stopped) break;
    const classification = classifications[i];
    try {
      assertJevRunTime_(runContext);
      applyThreadLabels_(classification.item.threadData, classification.scores, labelIdsByName, metrics, config);
      summary.succeeded += 1;
    } catch (error) {
      if (isJevDeadlineError_(error)) {
        summary.stopped = true;
        summary.deferred += classifications.length - i;
        break;
      }
      summary.failed += 1;
      logThreadProcessingError_(classification.item.threadId, error, config);
      if (isJevRateLimitError_(error)) {
        const diagnosticContext = getJevPropertySafely_(error, 'jevDiagnosticContext');
        const processingPhase = getJevPropertySafely_(diagnosticContext, 'processingPhase');
        if (['label_resolution', 'gmail_labeling'].indexOf(processingPhase) >= 0) {
          recordJevRateLimitIfNeeded_(error, true, config);
        }
        summary.stopped = true;
        summary.deferred = Math.max(0, totalCandidates - summary.succeeded - summary.failed);
        console.error('[JEV] Stopping this batch after a rate-limit error; remaining thread(s) will be retried on a later trigger.');
      }
    }
  }
}
