const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const API_KEY = 'api-key-fixture-secret';
const FIXTURE_BODY = 'private fixture body must never appear in logs';
const FIXTURE_SUBJECT = 'private fixture subject';
const FIXTURE_SENDER = 'private.sender@example.test';
const FIXTURE_THREAD_ID = 'thread-diagnostic-fixture';

const categoryKeys = [
  'pending',
  'people-personal',
  'work-career',
  'home-services',
  'health-benefits',
  'money-official-records',
  'transactions-bookings',
  'accounts-security',
  'news-promotions',
];

function base64Url(value) {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function makeThread(encodedBody, mimeType, bodySize, threadId, messageSpecs) {
  if (messageSpecs) {
    return { messages: [{ id: 'sent-message-' + threadId, labelIds: ['SENT'], payload: { mimeType: 'text/plain', body: { data: base64Url('ignored sent-message content') } } }].concat(messageSpecs.map(function (spec, index) {
      return {
        id: spec.id || 'eligible-message-' + threadId + '-' + index,
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'multipart/alternative',
          headers: [{ name: 'From', value: spec.sender || FIXTURE_SENDER }, { name: 'Subject', value: spec.subject || FIXTURE_SUBJECT }],
          parts: [{ mimeType: 'text/plain', body: { data: base64Url(spec.body), size: Buffer.byteLength(spec.body, 'utf8') } }],
        },
      };
    })) };
  }
  return {
    messages: [
      {
        id: 'sent-message-' + threadId,
        labelIds: ['SENT'],
        payload: {
          mimeType: 'text/plain',
          body: { data: base64Url('ignored sent-message content') },
        },
      },
      {
        id: 'eligible-message-' + threadId,
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'multipart/alternative',
          headers: [
            { name: 'From', value: FIXTURE_SENDER },
            { name: 'Subject', value: FIXTURE_SUBJECT },
          ],
          parts: [
            {
              mimeType: mimeType || ' TEXT/PLAIN; charset=UTF-8 ',
              body: { data: encodedBody, size: bodySize },
            },
          ],
        },
      },
    ],
  };
}

function createHarness(options) {
  const settings = options || {};
  const logs = [];
  let fakeNow = settings.now === undefined ? Date.now() : settings.now;
  class HarnessDate extends Date {
    constructor() {
      if (arguments.length) super(...arguments);
      else super(fakeNow);
    }
    static now() { return fakeNow; }
  }
  const counters = {
    searches: 0,
    threadReads: 0,
    labelLists: 0,
    labelCreates: 0,
    fetches: 0,
    batchModifies: 0,
    decodeCalls: 0,
    batchModifyIds: [],
    batchModifyCalls: [],
    threadReadIds: [],
    triggerCreates: 0,
    triggerDeletes: 0,
    sleeps: [],
  };
  const capturedRequests = [];
  let triggers = [];
  let triggerSequence = 0;
  const properties = {
    JEV_API_KEY: API_KEY,
    JEV_ENABLED: 'true',
    JEV_SCOPE: 'INBOX',
    JEV_INTERVAL_MINUTES: '5',
    JEV_MODEL: 'test-model',
    JEV_API_URL: 'https://example.test/classify',
    JEV_INTERNAL_TRIGGER_INTERVAL_MINUTES: '5',
    JEV_INTERNAL_TRIGGER_ID: 'trigger-initial',
  };
  triggers = [{
    getHandlerFunction: function () { return 'runJevBatch'; },
    getEventType: function () { return 'CLOCK'; },
    getUniqueId: function () { return 'trigger-initial'; },
    interval: 5,
  }];
  const consoleStub = {
    log: function () { logs.push({ level: 'log', text: Array.from(arguments).join(' ') }); },
    error: function () { logs.push({ level: 'error', text: Array.from(arguments).join(' ') }); },
  };
  const context = {
    console: consoleStub,
    Buffer: Buffer,
    Date: HarnessDate,
    PropertiesService: {
      getScriptProperties: function () {
        return {
          getProperties: function () { return Object.assign({}, properties); },
          getProperty: function (name) { return properties[name] === undefined ? null : properties[name]; },
          setProperty: function (name, value) {
            if (settings.failSetPropertyName === name) throw new Error('injected property write failure');
            properties[name] = String(value);
          },
          deleteProperty: function (name) { delete properties[name]; },
          setProperties: function (values, deleteAll) {
            if (deleteAll) Object.keys(properties).forEach(function (key) { delete properties[key]; });
            Object.keys(values).forEach(function (key) { properties[key] = String(values[key]); });
          },
        };
      },
    },
    ScriptApp: {
      EventType: { CLOCK: 'CLOCK' },
      getProjectTriggers: function () { return triggers.slice(); },
      deleteTrigger: function (trigger) {
        counters.triggerDeletes += 1;
        if (settings.deleteTriggerErrorId && trigger.getUniqueId() === settings.deleteTriggerErrorId) throw new Error('injected trigger cleanup failure');
        triggers = triggers.filter(function (item) { return item !== trigger; });
      },
      newTrigger: function () {
        let interval = null;
        return {
          timeBased: function () { return this; },
          everyMinutes: function (minutes) { interval = minutes; return this; },
          create: function () {
            counters.triggerCreates += 1;
            if (settings.triggerCreateError) throw settings.triggerCreateError;
            triggerSequence += 1;
            const id = 'trigger-' + triggerSequence;
            const trigger = {
              getHandlerFunction: function () { return 'runJevBatch'; },
              getEventType: function () { return 'CLOCK'; },
              getUniqueId: function () { return id; },
              interval: interval,
            };
            triggers.push(trigger);
            return trigger;
          },
        };
      },
    },
    LockService: {
      getScriptLock: function () {
        let held = false;
        return {
          tryLock: function () { if (settings.lockBusy) return false; held = true; return true; },
          releaseLock: function () { held = false; },
          hasLock: function () { return held; },
        };
      },
    },
    HtmlService: {
      XFrameOptionsMode: { DEFAULT: 'DEFAULT' },
      createHtmlOutputFromFile: function (name) { return { file: name, setTitle: function () { return this; }, setXFrameOptionsMode: function () { return this; } }; },
    },
    Gmail: {
      Users: {
        Threads: {
          list: function () {
            counters.searches += 1;
            return { threads: settings.candidateCount
              ? Array.from({ length: settings.candidateCount }, function (_, index) { return { id: (settings.threadId || FIXTURE_THREAD_ID) + '-' + index }; })
              : [{ id: settings.threadId || FIXTURE_THREAD_ID }] };
          },
          get: function (_, threadId) {
            counters.threadReads += 1;
            counters.threadReadIds.push(threadId);
            if (threadId === settings.threadReadQuotaErrorThreadId) {
              const error = new Error("Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'.");
              error.name = 'GoogleJsonResponseException';
              throw error;
            }
            const bodyByThread = settings.threadBodies || {};
            const body = bodyByThread[threadId] !== undefined
              ? bodyByThread[threadId]
              : settings.bodyLength
                ? 'x'.repeat(settings.bodyLength)
                : FIXTURE_BODY;
            return makeThread(
              settings.encodedBody !== undefined ? settings.encodedBody : base64Url(body),
              settings.mimeType,
              settings.bodySize,
              threadId,
              settings.messageSpecsByThread && settings.messageSpecsByThread[threadId]
            );
          },
        },
        Labels: {
          list: function () {
            counters.labelLists += 1;
            const labels = [
              { id: 'label-jev', name: 'JEV', type: 'user' },
              { id: 'label-uncategorized', name: 'Jev-Uncategoried', type: 'user' },
              { id: 'system-inbox', name: 'INBOX', type: 'system' },
              { id: 'system-spam', name: 'SPAM', type: 'system' },
              { id: 'system-trash', name: 'TRASH', type: 'system' },
            ];
            if (settings.raceLabelVisible && counters.labelLists > 1) {
              labels.push({ id: 'race-label-id', name: settings.raceLabelName || 'Jev-Pending', type: 'user' });
            }
            return { labels: labels };
          },
    create: function (request) {
      counters.labelCreates += 1;
      if (['INBOX', 'SPAM', 'TRASH'].indexOf(request.name) >= 0) throw new Error('System labels cannot be created.');
      if (settings.createConflict && request.name === settings.conflictLabelName) throw new Error('Label name already exists');
            return { id: 'created-label-' + request.name };
          },
        },
        Messages: {
          batchModify: function (request) {
            counters.batchModifies += 1;
            counters.batchModifyIds.push(request.addLabelIds);
            counters.batchModifyCalls.push({ ids: request.ids.slice(), addLabelIds: request.addLabelIds.slice() });
            if (settings.batchModifyQuotaError) {
              const error = new Error("Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'.");
              error.name = 'GoogleJsonResponseException';
              throw error;
            }
            if (settings.batchModifyError) throw settings.batchModifyError;
          },
        },
      },
    },
    UrlFetchApp: {
      fetch: function (url, requestOptions) {
        counters.fetches += 1;
        const payload = JSON.parse(requestOptions.payload);
        capturedRequests.push({ url: url, options: requestOptions, payload: payload });
        if (settings.fetchError) throw settings.fetchError;
        const fetchSpec = settings.fetchSequence && settings.fetchSequence[counters.fetches - 1] || {};
        return {
          getResponseCode: function () { return fetchSpec.status || settings.fetchStatus || 200; },
          getContentText: function () {
            if (settings.responseBodyReadError) throw new Error(settings.responseBodyReadError);
            if (Object.prototype.hasOwnProperty.call(fetchSpec, 'body')) return typeof fetchSpec.body === 'string' ? fetchSpec.body : JSON.stringify(fetchSpec.body);
            if (Object.prototype.hasOwnProperty.call(settings, 'httpErrorBody')) return settings.httpErrorBody;
            if (settings.responseFactory) {
              return JSON.stringify(settings.responseFactory(payload, counters.fetches));
            }
            const answers = {};
            Object.keys(payload.questions).forEach(function (questionKey) {
              if (questionKey === settings.omitAnswerKey) return;
              const categoryKey = questionKey.slice(questionKey.lastIndexOf('__') + 2);
              let value = settings.answerFactory
                ? settings.answerFactory(questionKey, payload)
                : settings.selectPending && categoryKey === 'pending' ? 1 : 0;
              if (questionKey === settings.invalidAnswerKey) value = NaN;
              answers[questionKey] = { type: 'noul', noul: value };
            });
            return JSON.stringify({ answers: answers });
          },
        };
      },
    },
    Utilities: {
      base64DecodeWebSafe: function (encoded) {
        return Buffer.from(String(encoded).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      },
      newBlob: function (bytes) {
        return {
          getBytes: function () { return Array.from(Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8')); },
          getDataAsString: function () {
            counters.decodeCalls += 1;
            if (settings.failDecode) {
              const error = new Error('Could not decode string.');
              // A decoder can include only a fragment of private content,
              // which exact-value redaction cannot identify.
              error.stack = 'Error: Could not decode string.\n    at decoder (' + API_KEY + ', ' + FIXTURE_BODY.slice(0, 15) + ')';
              throw error;
            }
            return Buffer.from(bytes).toString('utf8');
          },
        };
      },
      sleep: function (milliseconds) { counters.sleeps.push(milliseconds); fakeNow += milliseconds + (settings.sleepExtraMs || 0); },
      formatDate: function (date, timeZone, pattern) {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit',
          year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23',
        }).formatToParts(date).reduce(function (result, item) { result[item.type] = item.value; return result; }, {});
        if (pattern === 'u') return String({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday]);
        if (pattern === 'HH:mm') return parts.hour + ':' + parts.minute;
        if (pattern === 'yyyy-MM-dd') return parts.year + '-' + parts.month + '-' + parts.day;
        throw new Error('Unsupported Apps Script date format: ' + pattern);
      },
    },
  };

  vm.createContext(context);
  const codeFiles = ['Categories.gs', 'Config.gs', 'Code.gs', 'WebUi.gs'];
  const source = codeFiles.map(function (file) {
    return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  }).join('\n');
  vm.runInContext(source, context, { filename: 'jev-apps-script.js' });

  return {
    run: function () { return vm.runInContext('runJevBatch()', context); },
    runNow: function () { return vm.runInContext('runJevNow()', context); },
    installTrigger: function () { return vm.runInContext('installJevTrigger()', context); },
    evaluate: function (script) { return vm.runInContext(script, context); },
    getUiState: function () { return JSON.parse(vm.runInContext('JSON.stringify(getJevUiState())', context)); },
    properties: properties,
    getTriggers: function () { return triggers.slice(); },
    clearTriggerCreateError: function () { settings.triggerCreateError = null; },
    failDeleteForTrigger: function (id) { settings.deleteTriggerErrorId = id; },
    clearTriggerDeleteFailure: function () { settings.deleteTriggerErrorId = null; },
    setTriggerRecordWriteFailure: function () { settings.failSetPropertyName = 'JEV_INTERNAL_TRIGGER_RECORD'; },
    advanceTime: function (milliseconds) { fakeNow += milliseconds; },
    measureBodyTokens: function (bodyLength) {
      context.__jevTestItems = [{ threadData: { state: { messages: [{ sender: FIXTURE_SENDER, subject: FIXTURE_SUBJECT, body: 'x'.repeat(bodyLength) }] } } }];
      return vm.runInContext("getJevBatchAssessment_(__jevTestItems, 'test-model', getJevConfig_()).estimatedRequestTokens", context);
    },
    measureBodyAssessment: function (bodyLength, itemCount) {
      context.__jevTestItems = Array.from({ length: itemCount || 1 }, function () {
        return { threadData: { state: { messages: [{ sender: FIXTURE_SENDER, subject: FIXTURE_SUBJECT, body: 'x'.repeat(bodyLength) }] } } };
      });
      return JSON.parse(vm.runInContext(
        "JSON.stringify(getJevBatchAssessment_(__jevTestItems, 'test-model', getJevConfig_()))",
        context
      ));
    },
    logs: logs,
    counters: counters,
    requests: capturedRequests,
    encodedBody: settings.encodedBody || base64Url(FIXTURE_BODY),
  };
}

function assertLogsExcludePrivateFixtures(harness, extraFragments) {
  const allLogs = harness.logs.map(function (entry) { return entry.text; }).join('\n');
  [FIXTURE_BODY, FIXTURE_BODY.slice(0, 15), FIXTURE_SUBJECT, FIXTURE_SENDER, API_KEY, harness.encodedBody]
    .concat(extraFragments || []).forEach(function (secret) {
      assert.ok(!allLogs.includes(secret), 'logs must not contain ' + secret);
    });
  return allLogs;
}

function findBodyLengthForRequestTokens(harness, targetTokens) {
  let low = 0;
  let high = targetTokens * 4;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (harness.measureBodyTokens(middle) >= targetTokens) high = middle;
    else low = middle + 1;
  }
  assert.equal(harness.measureBodyTokens(low), targetTokens);
  return low;
}

function saveUiSettings(harness, request) {
  const encoded = JSON.stringify(JSON.stringify(request));
  return JSON.parse(harness.evaluate('JSON.stringify(saveJevSettings(JSON.parse(' + encoded + ')))'));
}

test('classification exceptions log only bounded safe diagnostics', function () {
  const bodyFragment = FIXTURE_BODY.slice(4, 19);
  const otherFragment = FIXTURE_SUBJECT.slice(2, 15);
  const error = new Error('provider failure: ' + bodyFragment + ' key=' + API_KEY);
  error.name = 'Custom' + otherFragment;
  error.stack = 'Error: ' + bodyFragment + '\n at fetch (' + FIXTURE_SENDER + ')';
  const harness = createHarness({ fetchError: error });
  harness.run();

  const logText = assertLogsExcludePrivateFixtures(harness, [bodyFragment, otherFragment]);
  const errorLog = harness.logs.filter(function (entry) { return entry.text.startsWith('[JEV] Thread processing failed: '); })[0];
  assert.ok(errorLog);
  const details = JSON.parse(errorLog.text.slice('[JEV] Thread processing failed: '.length));
  assert.equal(details.phase, 'classification');
  assert.equal(details.errorName, 'Error');
  assert.equal(details.message, 'Processing failed.');
  assert.equal(details.stack, '[omitted]');
  assert.ok(logText.includes('"phase":"classification"'));
});

test('Gmail labeling exceptions log only bounded safe diagnostics', function () {
  const bodyFragment = FIXTURE_BODY.slice(10, 28);
  const otherFragment = FIXTURE_SUBJECT.slice(1, 14);
  const error = new Error('Gmail rejected update: ' + bodyFragment);
  error.name = 'Provider' + otherFragment;
  error.stack = 'Error: ' + bodyFragment + '\n at batchModify (' + FIXTURE_SENDER + ')';
  const harness = createHarness({ batchModifyError: error });
  harness.run();

  assertLogsExcludePrivateFixtures(harness, [bodyFragment, otherFragment]);
  const errorLog = harness.logs.filter(function (entry) { return entry.text.startsWith('[JEV] Thread processing failed: '); })[0];
  assert.ok(errorLog);
  const details = JSON.parse(errorLog.text.slice('[JEV] Thread processing failed: '.length));
  assert.equal(details.phase, 'gmail_labeling');
  assert.equal(details.errorName, 'Error');
  assert.equal(details.message, 'Processing failed.');
  assert.equal(details.stack, '[omitted]');
});

test('throwing exception property getters do not interrupt logging or the batch', function () {
  const error = new Error('unreachable');
  ['message', 'name', 'statusCode', 'stack'].forEach(function (key) {
    Object.defineProperty(error, key, {
      configurable: true,
      get: function () { throw new Error('private getter failure'); },
    });
  });
  const harness = createHarness({ candidateCount: 2, fetchError: error });
  harness.run();

  const logText = assertLogsExcludePrivateFixtures(harness, ['private getter failure']);
  const errorLogs = harness.logs.filter(function (entry) { return entry.text.startsWith('[JEV] Thread processing failed: '); });
  assert.equal(errorLogs.length, 2);
  errorLogs.forEach(function (entry) {
    const details = JSON.parse(entry.text.slice('[JEV] Thread processing failed: '.length));
    assert.equal(details.phase, 'classification');
    assert.equal(details.errorName, 'Error');
    assert.equal(details.message, 'Processing failed.');
    assert.equal(details.stack, '[omitted]');
  });
  assert.equal(harness.counters.threadReads, 2, 'batch processing should continue after the first failure');
  assert.equal(harness.counters.fetches, 1);
  assert.match(logText, /Batch complete: 0 succeeded, 2 failed, 0 deferred\./);
});

test('throwing diagnostic-context getters preserve Gmail quota stop and defer behavior', function () {
  const error = new Error("Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'.");
  error.name = 'GoogleJsonResponseException';
  Object.defineProperty(error, 'jevDiagnosticContext', {
    configurable: true,
    get: function () { throw new Error('private diagnostic context getter'); },
  });
  const harness = createHarness({ candidateCount: 3, batchModifyError: error });
  harness.run();

  const logText = assertLogsExcludePrivateFixtures(harness, ['private diagnostic context getter']);
  assert.match(logText, /Stopping this batch after a rate-limit error/);
  assert.equal(harness.counters.threadReads, 3);
  assert.equal(harness.counters.fetches, 1);
  assert.equal(harness.counters.batchModifies, 1);
  assert.match(logText, /Batch complete: 0 succeeded, 1 failed, 2 deferred\./);
});

test('hostile nested diagnostic getters are omitted without interrupting later threads', function () {
  const privateFragment = 'privatefixturefragment';
  const error = new Error('opaque Gmail failure');
  const bodyDecode = {
    messageOrdinal: 1,
    mimePartPath: '0.0',
    mimeType: 'text/plain',
    encodedDataLength: 42,
  };
  Object.defineProperty(bodyDecode, 'decodeStage', {
    enumerable: true,
    get: function () { return privateFragment; },
  });
  const diagnosticContext = { bodyDecode: bodyDecode };
  Object.defineProperty(diagnosticContext, 'processingPhase', {
    enumerable: true,
    get: function () { throw new Error('private phase getter failure'); },
  });
  error.jevDiagnosticContext = diagnosticContext;

  const harness = createHarness({ candidateCount: 2, batchModifyError: error });
  harness.run();

  const logText = assertLogsExcludePrivateFixtures(harness, [privateFragment, 'private phase getter failure']);
  const errorLogs = harness.logs.filter(function (entry) { return entry.text.startsWith('[JEV] Thread processing failed: '); });
  assert.equal(errorLogs.length, 2);
  errorLogs.forEach(function (entry) {
    const details = JSON.parse(entry.text.slice('[JEV] Thread processing failed: '.length));
    assert.equal(details.phase, 'unknown');
    assert.equal(details.message, 'Body decoding failed.');
    assert.equal(details.stack, '[omitted for body decoding failure]');
    assert.equal(details.decodeStage, undefined, 'decoder stage must be a finite allowlisted value');
  });
  assert.equal(harness.counters.threadReads, 2);
  assert.equal(harness.counters.fetches, 1);
  assert.equal(harness.counters.batchModifies, 2);
  assert.match(logText, /Batch complete: 0 succeeded, 2 failed, 0 deferred\./);
});

test('thread IDs and MIME types are constrained before diagnostic logging', function () {
  const harness = createHarness({ threadId: FIXTURE_SENDER, mimeType: FIXTURE_SENDER, failDecode: true });
  harness.run();

  const logText = assertLogsExcludePrivateFixtures(harness);
  const errorLog = harness.logs.filter(function (entry) { return entry.text.startsWith('[JEV] Thread processing failed: '); })[0];
  assert.ok(errorLog);
  const details = JSON.parse(errorLog.text.slice('[JEV] Thread processing failed: '.length));
  assert.equal(details.threadId, '[invalid thread id]');
  assert.equal(details.mimeType, 'other');
  assert.ok(!logText.includes(FIXTURE_SENDER));
});

test('HTTP 429 diagnostics retain the validated status and final response body after retries', function () {
  const harness = createHarness({ fetchStatus: 429, httpErrorBody: 'rate limit response' });
  harness.run();

  const errorLog = harness.logs.filter(function (entry) { return entry.text.startsWith('[JEV] Thread processing failed: '); })[0];
  assert.ok(errorLog);
  const details = JSON.parse(errorLog.text.slice('[JEV] Thread processing failed: '.length));
  assert.equal(details.message, 'Request failed with HTTP 429.');
  assert.equal(details.errorName, 'Error');
  assert.equal(details.stack, '[omitted]');
  assert.equal(details.responseBody, 'rate limit response');
  assert.equal(harness.counters.fetches, 3, 'provider 429 responses should use the existing retry count');
});

function readThreadErrorDetails(harness) {
  const entry = harness.logs.filter(function (log) { return log.text.startsWith('[JEV] Thread processing failed: '); })[0];
  assert.ok(entry, 'a thread error should be logged');
  return JSON.parse(entry.text.slice('[JEV] Thread processing failed: '.length));
}

test('HTTP 4xx and 5xx diagnostics include provider response bodies', function () {
  [400, 503].forEach(function (status) {
    const body = 'provider error ' + status;
    const harness = createHarness({ fetchStatus: status, httpErrorBody: body });
    harness.run();
    const details = readThreadErrorDetails(harness);
    assert.equal(details.responseBody, body);
    assert.equal(details.message, 'Request failed with HTTP ' + status + '.');
    assert.equal(details.stack, '[omitted]');
  });
});

test('HTTP response diagnostics preserve empty body and omit bodies for 3xx', function () {
  const emptyHarness = createHarness({ fetchStatus: 400, httpErrorBody: '' });
  emptyHarness.run();
  assert.equal(readThreadErrorDetails(emptyHarness).responseBody, '');

  const redirectHarness = createHarness({ fetchStatus: 302, httpErrorBody: 'redirect details' });
  redirectHarness.run();
  assert.equal(Object.prototype.hasOwnProperty.call(readThreadErrorDetails(redirectHarness), 'responseBody'), false);
});

test('provider response bodies are capped and marked when truncated', function () {
  const harness = createHarness({ fetchStatus: 500, httpErrorBody: 'x'.repeat(2005) });
  harness.run();
  const details = readThreadErrorDetails(harness);
  assert.equal(details.responseBody.length, 2000);
  assert.equal(details.responseBodyTruncated, true);
});

test('response body read failures retain HTTP status without exposing read error', function () {
  const harness = createHarness({ fetchStatus: 502, responseBodyReadError: 'private read exception detail' });
  harness.run();
  const details = readThreadErrorDetails(harness);
  assert.equal(details.message, 'Request failed with HTTP 502.');
  assert.equal(details.responseBody, '[response body unavailable]');
  assert.ok(!JSON.stringify(details).includes('private read exception detail'));
});

test('provider response body diagnostics redact the configured API key', function () {
  const harness = createHarness({ fetchStatus: 400, httpErrorBody: 'provider echoed ' + API_KEY });
  harness.run();
  const details = readThreadErrorDetails(harness);
  assert.equal(details.responseBody, 'provider echoed [redacted API key]');
  assert.ok(!JSON.stringify(details).includes(API_KEY));
});

test('decoder failures log safe thread, phase, stack, and MIME diagnostics', function () {
  const harness = createHarness({ failDecode: true });
  harness.run();

  const errorLog = harness.logs.filter(function (entry) { return entry.level === 'error'; })[0];
  assert.ok(errorLog, 'a thread error should be logged');
  const prefix = '[JEV] Thread processing failed: ';
  assert.ok(errorLog.text.startsWith(prefix));
  const details = JSON.parse(errorLog.text.slice(prefix.length));
  assert.equal(details.threadId, FIXTURE_THREAD_ID);
  assert.equal(details.phase, 'thread_read');
  assert.equal(details.errorName, 'Error');
  assert.equal(details.message, 'Could not decode string.');
  assert.equal(details.stack, '[omitted for body decoding failure]');
  assert.equal(details.messageOrdinal, 1);
  assert.equal(details.mimePartPath, '0.0');
  assert.equal(details.mimeType, 'text/plain');
  assert.equal(details.encodedDataLength, harness.encodedBody.length);

  const allLogs = harness.logs.map(function (entry) { return entry.text; }).join('\n');
  [FIXTURE_BODY, FIXTURE_BODY.slice(0, 15), FIXTURE_SUBJECT, FIXTURE_SENDER, API_KEY, harness.encodedBody].forEach(function (secret) {
    assert.ok(!allLogs.includes(secret), 'logs must not contain ' + secret);
  });
  assert.equal(harness.counters.fetches, 0, 'classification API must not be called after decoding fails');
  assert.equal(harness.counters.batchModifies, 0, 'eligible Gmail messages must not be labeled after decoding fails');
  assert.equal(harness.counters.labelCreates, 0, 'no Gmail labels should be created for this failed thread');
});

test('valid body decoding continues through classification and labeling', function () {
  const harness = createHarness();
  harness.run();

  assert.equal(harness.counters.decodeCalls, 1);
  assert.equal(harness.counters.fetches, 1);
  assert.equal(harness.counters.batchModifies, 1);
  assert.equal(harness.counters.labelCreates, 0);
  assert.equal(harness.requests[0].payload.state.threads.item_000.messages[0].body, FIXTURE_BODY);
  const allLogs = harness.logs.map(function (entry) { return entry.text; }).join('\n');
  assert.ok(!allLogs.includes(FIXTURE_BODY));
  assert.ok(!allLogs.includes(API_KEY));
});

test('byte array body with shorter declared size reaches classification intact', function () {
  const body = 'complete byte array body';
  const bytes = Array.from(Buffer.from(body, 'utf8'));
  const harness = createHarness({ encodedBody: bytes, bodySize: bytes.length - 2 });
  harness.run();

  assert.equal(harness.counters.decodeCalls, 1);
  assert.equal(harness.counters.fetches, 1);
  assert.equal(harness.requests[0].payload.state.threads.item_000.messages[0].body, body);
});

test('a request below 16,000 estimated tokens flushes as the final remainder', function () {
  const sizingHarness = createHarness();
  const bodyLength = findBodyLengthForRequestTokens(sizingHarness, 15999);
  const harness = createHarness({ bodyLength: bodyLength });
  harness.run();

  assert.equal(harness.requests.length, 1);
  assert.equal(Math.ceil(harness.requests[0].options.payload.length / 4), 15999);
  assert.equal(Object.keys(harness.requests[0].payload.state.threads).length, 1);
  assert.equal(harness.counters.batchModifies, 1);
});

test('a request estimated at exactly 16,000 tokens flushes immediately', function () {
  const sizingHarness = createHarness();
  const bodyLength = findBodyLengthForRequestTokens(sizingHarness, 16000);
  const assessment = sizingHarness.measureBodyAssessment(bodyLength);
  assert.equal(assessment.estimatedStateQuestionTokens <= 16000, true);

  const harness = createHarness({ bodyLength: bodyLength });
  harness.run();

  assert.equal(harness.requests.length, 1);
  assert.equal(Math.ceil(harness.requests[0].options.payload.length / 4), 16000);
  assert.equal(harness.counters.batchModifies, 1);
});

test('the thread that crosses 16,000 tokens is included once in its request', function () {
  const sizingHarness = createHarness();
  const bodyLength = findBodyLengthForRequestTokens(sizingHarness, 1650);
  const crossingAssessment = sizingHarness.measureBodyAssessment(bodyLength, 10);
  assert.ok(crossingAssessment.estimatedRequestTokens >= 16000, 'estimated request tokens: ' + crossingAssessment.estimatedRequestTokens);
  assert.ok(crossingAssessment.estimatedRequestTokens < 32000, 'request remains below the hard limit');
  assert.ok(crossingAssessment.estimatedStateQuestionTokens <= 16000);

  const harness = createHarness({ threadId: 'crossing-thread', candidateCount: 20, bodyLength: bodyLength });
  harness.run();

  const totalQuestionKeys = harness.requests.reduce(function (total, request) {
    return total + Object.keys(request.payload.questions).length;
  }, 0);
  const totalStateEntries = harness.requests.reduce(function (total, request) {
    return total + Object.keys(request.payload.state.threads).length;
  }, 0);
  assert.ok(harness.requests[0].options.payload.length / 4 >= 16000);
  assert.equal(totalQuestionKeys, 20 * 9);
  assert.equal(totalStateEntries, 20);
  assert.equal(harness.counters.threadReads, 20);
  assert.equal(harness.counters.batchModifies, 20);
});

test('multiple small threads flush together as the final remainder', function () {
  const harness = createHarness({ threadId: 'remainder-thread', candidateCount: 3 });
  harness.run();

  assert.equal(harness.requests.length, 1);
  assert.equal(Object.keys(harness.requests[0].payload.state.threads).length, 3);
  assert.equal(Object.keys(harness.requests[0].payload.questions).length, 3 * 9);
  assert.equal(harness.counters.batchModifies, 3);
});

test('each response key applies its own thread and category labels', function () {
  const harness = createHarness({
    threadId: 'mapped-thread',
    candidateCount: 2,
    answerFactory: function (questionKey) {
      if (questionKey === 'item_000__pending') return 0.9;
      if (questionKey === 'item_001__work-career') return 0.91;
      return 0;
    },
  });
  harness.run();

  const request = harness.requests[0].payload;
  assert.deepEqual(Object.keys(request.state.threads), ['item_000', 'item_001']);
  assert.ok(request.questions.item_000__pending.instructions.includes('state.threads.item_000'));
  assert.ok(request.questions['item_001__work-career'].instructions.includes('state.threads.item_001'));
  assert.equal(harness.counters.batchModifyCalls.length, 2);
  assert.deepEqual(harness.counters.batchModifyCalls[0].ids, ['eligible-message-mapped-thread-0']);
  assert.deepEqual(harness.counters.batchModifyCalls[1].ids, ['eligible-message-mapped-thread-1']);
  assert.ok(harness.counters.batchModifyCalls[0].addLabelIds.includes('created-label-Jev-Pending'));
  assert.ok(!harness.counters.batchModifyCalls[0].addLabelIds.includes('created-label-Jev-Work & Career'));
  assert.ok(harness.counters.batchModifyCalls[1].addLabelIds.includes('created-label-Jev-Work & Career'));
  assert.ok(!harness.counters.batchModifyCalls[1].addLabelIds.includes('created-label-Jev-Pending'));
});

test('low-confidence successful classification adds the fallback label and JEV marker', function () {
  const harness = createHarness();
  harness.run();

  assert.equal(Object.keys(harness.requests[0].payload.questions).length, 9, 'fallback label must not add a classifier question');
  assert.deepEqual(Array.from(harness.counters.batchModifyCalls[0].addLabelIds), ['label-uncategorized', 'label-jev']);
});

test('label lookup indexes only user labels and never maps reserved Gmail system labels', function () {
  const harness = createHarness();
  const labels = JSON.parse(harness.evaluate('JSON.stringify(getLabelIdsByName_(createJevRunMetrics_()))'));
  assert.equal(labels.JEV, 'label-jev');
  assert.equal(labels['Jev-Uncategoried'], 'label-uncategorized');
  assert.equal(labels.INBOX, undefined);
  assert.equal(labels.SPAM, undefined);
  assert.equal(labels.TRASH, undefined);
});

test('scores equal to every effective threshold use fallback because matching is strict', function () {
  const harness = createHarness({ answerFactory: function () { return 0.75; } });
  harness.run();

  assert.deepEqual(Array.from(harness.counters.batchModifyCalls[0].addLabelIds), ['label-uncategorized', 'label-jev']);
});

test('disabled categories are omitted from requests and category overrides determine fallback', function () {
  const harness = createHarness({ answerFactory: function (questionKey) { return questionKey.endsWith('__pending') ? 0.72 : 0; } });
  harness.evaluate("var config = getJevConfig_(); config.categories.forEach(function (c) { c.enabled = c.key === 'pending'; }); config.categories[0].threshold = 0.7; commitJevConfig_(config)");
  harness.run();

  assert.deepEqual(Object.keys(harness.requests[0].payload.questions), ['item_000__pending']);
  assert.deepEqual(Array.from(harness.counters.batchModifyCalls[0].addLabelIds), ['created-label-Jev-Pending', 'label-jev']);
});

test('malformed batch answers fail every member before any label update', function () {
  const harness = createHarness({ threadId: 'invalid-answer-thread', candidateCount: 2, invalidAnswerKey: 'item_001__pending' });
  harness.run();

  assert.equal(harness.counters.fetches, 1);
  assert.equal(harness.counters.batchModifies, 0);
  assert.equal(harness.counters.labelCreates, 0);
  assert.match(harness.logs.map(function (entry) { return entry.text; }).join('\n'), /0 succeeded, 2 failed, 0 deferred/);
});

test('missing batch answers fail every member before any label update', function () {
  const harness = createHarness({ threadId: 'missing-answer-thread', candidateCount: 2, omitAnswerKey: 'item_001__news-promotions' });
  harness.run();

  assert.equal(harness.counters.fetches, 1);
  assert.equal(harness.counters.batchModifies, 0);
  assert.equal(harness.counters.labelCreates, 0);
  assert.match(harness.logs.map(function (entry) { return entry.text; }).join('\n'), /0 succeeded, 2 failed, 0 deferred/);
});

test('an oversized singleton is truncated and classified within the 20,000 token state limit', function () {
  const body = 'private oversized body ' + 'x'.repeat(140000) + ' PRIVATE-ORIGINAL-TAIL';
  const harness = createHarness({ threadBodies: { 'oversized-thread': body }, threadId: 'oversized-thread', selectPending: true });
  harness.run();

  assert.equal(harness.counters.fetches, 1);
  assert.equal(harness.counters.batchModifies, 1);
  assert.deepEqual(harness.counters.batchModifyCalls[0].ids, ['eligible-message-oversized-thread']);
  const request = harness.requests[0];
  const serialized = request.options.payload;
  const message = request.payload.state.threads.item_000.messages[0];
  const assessment = harness.measureBodyAssessment(140000);
  assert.ok(Math.ceil(JSON.stringify({ state: request.payload.state, question: request.payload.questions.item_000__pending }).length / 4) <= 20000);
  assert.ok(Math.ceil(serialized.length / 4) <= 32000);
  assert.ok(message.body.includes('truncat'), 'body should contain a truncation marker');
  assert.ok(!serialized.includes('PRIVATE-ORIGINAL-TAIL'));
  assert.equal(message.sender, FIXTURE_SENDER);
  assert.equal(message.subject, FIXTURE_SUBJECT);
  assert.equal(assessment.estimatedRequestTokens > 32000, true);
  assertLogsExcludePrivateFixtures(harness, ['PRIVATE-ORIGINAL-TAIL']);
  assert.ok(!harness.logs.map(function (entry) { return entry.text; }).join('\n').includes('x'.repeat(100)));
});

test('ordinary body remains byte-for-byte intact and oversized multi-message thread is shortened retaining metadata', function () {
  const ordinary = 'ordinary body stays exactly intact\nwith newlines';
  const ordinaryHarness = createHarness({ threadBodies: { 'ordinary-thread': ordinary }, threadId: 'ordinary-thread' });
  ordinaryHarness.run();
  assert.equal(ordinaryHarness.requests[0].payload.state.threads.item_000.messages[0].body, ordinary);

  const specs = [
    { id: 'eligible-multi-1', sender: 'one@example.test', subject: 'First subject', body: 'A'.repeat(80000) + ' MULTI-TAIL-ONE' },
    { id: 'eligible-multi-2', sender: 'two@example.test', subject: 'Second subject', body: 'B'.repeat(80000) + ' MULTI-TAIL-TWO' },
  ];
  const harness = createHarness({ threadId: 'multi-thread', messageSpecsByThread: { 'multi-thread': specs }, selectPending: true });
  harness.run();
  assert.equal(harness.counters.fetches, 1);
  assert.deepEqual(harness.counters.batchModifyCalls[0].ids, ['eligible-multi-1', 'eligible-multi-2']);
  const request = harness.requests[0];
  const serialized = request.options.payload;
  const messages = request.payload.state.threads.item_000.messages;
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(function (m) { return [m.sender, m.subject]; }), [['one@example.test', 'First subject'], ['two@example.test', 'Second subject']]);
  assert.ok(messages.every(function (m) { return m.body.includes('truncat'); }));
  assert.ok(Math.ceil(JSON.stringify({ state: request.payload.state, question: request.payload.questions.item_000__pending }).length / 4) <= 20000);
  assert.ok(Math.ceil(serialized.length / 4) <= 32000);
  assert.ok(!serialized.includes('MULTI-TAIL-ONE'));
  assert.ok(!serialized.includes('MULTI-TAIL-TWO'));
});

test('exhausted provider rate limits fail the sent batch and defer remaining candidates', function () {
  const sizingHarness = createHarness();
  const bodyLength = findBodyLengthForRequestTokens(sizingHarness, 1750);
  const harness = createHarness({
    threadId: 'provider-limit-thread',
    candidateCount: 20,
    bodyLength: bodyLength,
    fetchStatus: 429,
  });
  harness.run();

  const logText = harness.logs.map(function (entry) { return entry.text; }).join('\n');
  assert.equal(harness.counters.fetches, 3);
  assert.ok(harness.counters.threadReads < 20);
  assert.equal(harness.counters.batchModifies, 0);
  assert.match(logText, /Stopping this batch after a rate-limit error/);
  assert.match(logText, /0 succeeded, \d+ failed, \d+ deferred\./);
  const summary = /Batch complete: 0 succeeded, (\d+) failed, (\d+) deferred\./.exec(logText);
  assert.ok(summary);
  assert.ok(Number(summary[1]) > 0);
  assert.ok(Number(summary[2]) > 0);
  assert.equal(Number(summary[1]) + Number(summary[2]), 20);
});

test('invalid byte array elements still fail decoding', function () {
  const harness = createHarness({ encodedBody: [65, 256, 67], bodySize: 1 });
  harness.run();

  const errorLog = harness.logs.filter(function (entry) { return entry.text.startsWith('[JEV] Thread processing failed: '); })[0];
  assert.ok(errorLog);
  const details = JSON.parse(errorLog.text.slice('[JEV] Thread processing failed: '.length));
  assert.equal(details.message, 'Body decoding failed.');
  assert.equal(details.byteArrayValidationValid, false);
  assert.equal(details.byteArrayInvalidElementCount, 1);
  assert.equal(harness.counters.fetches, 0);
});

test('invalid declared byte array size still fails decoding', function () {
  const harness = createHarness({ encodedBody: [65, 66, 67], bodySize: -1 });
  harness.run();

  const errorLog = harness.logs.filter(function (entry) { return entry.text.startsWith('[JEV] Thread processing failed: '); })[0];
  assert.ok(errorLog);
  const details = JSON.parse(errorLog.text.slice('[JEV] Thread processing failed: '.length));
  assert.equal(details.message, 'Body decoding failed.');
  assert.equal(details.expectedBodySize, undefined);
  assert.equal(details.bodySizeMatches, false);
  assert.equal(harness.counters.fetches, 0);
});

test('label creation conflict refreshes and reuses only an exact matching label', function () {
  const harness = createHarness({ createConflict: true, raceLabelVisible: true, selectPending: true, conflictLabelName: 'Jev-Pending' });
  harness.run();
  assert.ok(harness.counters.labelLists >= 2);
  assert.equal(harness.counters.batchModifies, 1);
  assert.ok(harness.counters.batchModifyIds[0].includes('race-label-id'));
});

test('label creation conflict without an exact refreshed match fails without labeling', function () {
  const harness = createHarness({ createConflict: true, raceLabelVisible: true, raceLabelName: 'Different', selectPending: true, conflictLabelName: 'Jev-Pending' });
  harness.run();
  assert.equal(harness.counters.batchModifies, 0);
  assert.ok(harness.counters.labelLists >= 2);
});

test('Gmail batchModify quota errors stop the batch and defer later threads', function () {
  const harness = createHarness({ candidateCount: 3, batchModifyQuotaError: true });
  harness.run();
  const logText = harness.logs.map(function (entry) { return entry.text; }).join('\n');
  assert.match(logText, /Stopping this batch after a rate-limit error/);
  assert.doesNotMatch(logText, /repeated rate limiting/);
  assert.equal(harness.counters.threadReads, 3);
  assert.equal(harness.counters.fetches, 1);
  assert.equal(harness.counters.batchModifies, 1);
  assert.match(logText, /Batch complete: 0 succeeded, 1 failed, 2 deferred\./);
});

test('Gmail thread-read quota errors stop without flushing pending threads', function () {
  const harness = createHarness({
    threadId: 'thread-read-limit',
    candidateCount: 3,
    threadReadQuotaErrorThreadId: 'thread-read-limit-2',
  });
  harness.run();

  const logText = harness.logs.map(function (entry) { return entry.text; }).join('\n');
  assert.match(logText, /Stopping this batch after a rate-limit error/);
  assert.equal(harness.counters.threadReads, 3);
  assert.equal(harness.counters.fetches, 0, 'pending threads must not be sent after a Gmail quota error');
  assert.equal(harness.counters.batchModifies, 0, 'pending threads must not be labeled after a Gmail quota error');
  assert.match(logText, /Batch complete: 0 succeeded, 1 failed, 2 deferred\./);
});

test('UI state exposes a configured-key flag without returning the API key', function () {
  const harness = createHarness();
  const state = harness.getUiState();
  assert.equal(state.ok, true);
  assert.equal(state.apiKeyConfigured, true);
  assert.ok(!JSON.stringify(state).includes(API_KEY));
  assert.equal(state.settings.fallbackLabel, 'Jev-Uncategoried');
});

test('provider profiles in public UI state expose metadata and key flags but never credentials', function () {
  const harness = createHarness();
  const profiles = [
    { id: 'primary', apiUrl: 'https://primary.example/v1', model: 'model-a', apiKey: 'primary-private-key' },
    { id: 'backup', apiUrl: 'https://backup.example/v2', model: 'model-b', apiKey: 'backup-private-key' },
  ];
  harness.evaluate('var c = getJevConfig_(); c.providers = ' + JSON.stringify(profiles) + '; c.enabled = true; commitJevConfig_(validateJevConfig_(c))');
  const state = harness.getUiState();
  assert.equal(state.ok, true);
  assert.deepEqual(state.settings.providers.map((p) => [p.id, p.apiUrl, p.model]), profiles.map((p) => [p.id, p.apiUrl, p.model]));
  assert.ok(state.settings.providers.every((p) => p.apiKeyConfigured === true));
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes('primary-private-key'));
  assert.ok(!serialized.includes('backup-private-key'));
});

test('provider key save actions preserve keys by stable ID and return no configured key values', function () {
  const harness = createHarness();
  harness.evaluate("var c = getJevConfig_(); c.providers = [{id:'alpha',apiUrl:'https://a.example/v1',model:'a',apiKey:'secret-alpha'},{id:'beta',apiUrl:'https://b.example/v1',model:'b',apiKey:'secret-beta'}]; c.enabled = true; commitJevConfig_(validateJevConfig_(c))");
  const state = harness.getUiState();
  const settings = state.settings;
  settings.providers = settings.providers.map(({ id, apiUrl, model }) => ({ id, apiUrl, model }));
  settings.providers.reverse();
  settings.providers[0].model = 'b-updated';
  const saved = saveUiSettings(harness, { expectedRevision: state.revision, settings: settings, providerKeyActions: { alpha: 'keep', beta: 'replace' }, providerKeys: { beta: 'replacement-beta' } });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.providers[0].id, 'beta');
  assert.equal(saved.settings.providers[0].model, 'b-updated');
  assert.ok(!JSON.stringify(saved).includes('replacement-beta'));
  const committed = JSON.parse(harness.evaluate('JSON.stringify(getJevConfig_())'));
  assert.equal(committed.providers.find((p) => p.id === 'alpha').apiKey, 'secret-alpha');
  assert.equal(committed.providers.find((p) => p.id === 'beta').apiKey, 'replacement-beta');
});

test('provider IDs that match inherited object properties keep credentials without key actions', function () {
  const harness = createHarness();
  harness.evaluate("var c = getJevConfig_(); c.providers = [{id:'toString',apiUrl:'https://a.example/v1',model:'a',apiKey:'secret-string-provider'}]; c.enabled = false; commitJevConfig_(validateJevConfig_(c))");
  const state = harness.getUiState();
  const settings = state.settings;
  settings.providers = settings.providers.map(({ id, apiUrl, model }) => ({ id, apiUrl, model }));
  const saved = saveUiSettings(harness, { expectedRevision: state.revision, settings, providerKeyActions: {}, providerKeys: {} });
  assert.equal(saved.ok, true);
  const committed = JSON.parse(harness.evaluate('JSON.stringify(getJevConfig_())'));
  assert.equal(committed.providers[0].apiKey, 'secret-string-provider');
});

test('provider removal drops its key while remaining IDs retain their keys; malformed key payloads are rejected', function () {
  const harness = createHarness();
  harness.evaluate("var c = getJevConfig_(); c.providers = [{id:'alpha',apiUrl:'https://a.example/v1',model:'a',apiKey:'secret-alpha'},{id:'beta',apiUrl:'https://b.example/v1',model:'b',apiKey:'secret-beta'}]; c.enabled = true; commitJevConfig_(validateJevConfig_(c))");
  const state = harness.getUiState();
  const settings = state.settings;
  settings.providers = settings.providers.filter((p) => p.id === 'beta').map(({ id, apiUrl, model }) => ({ id, apiUrl, model }));
  assert.equal(saveUiSettings(harness, { expectedRevision: state.revision, settings, providerKeyActions: { beta: 'keep' } }).ok, true);
  let committed = JSON.parse(harness.evaluate('JSON.stringify(getJevConfig_())'));
  assert.deepEqual(committed.providers.map((p) => p.id), ['beta']);
  assert.equal(committed.providers[0].apiKey, 'secret-beta');
  const nextState = harness.getUiState();
  const nextSettings = nextState.settings;
  nextSettings.providers = nextSettings.providers.map(({ id, apiUrl, model }) => ({ id, apiUrl, model }));
  const malformed = saveUiSettings(harness, { expectedRevision: nextState.revision, settings: nextSettings, providerKeys: ['bad'] });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'VALIDATION');
});

test('clearing one of several provider keys preserves the others and empty replacement is rejected', function () {
  const harness = createHarness();
  harness.evaluate("var c = getJevConfig_(); c.providers = [{id:'alpha',apiUrl:'https://a.example/v1',model:'a',apiKey:'secret-alpha'},{id:'beta',apiUrl:'https://b.example/v1',model:'b',apiKey:'secret-beta'}]; c.enabled = true; commitJevConfig_(validateJevConfig_(c))");
  const state = harness.getUiState();
  const settings = state.settings;
  settings.providers = settings.providers.map(({ id, apiUrl, model }) => ({ id, apiUrl, model }));
  const result = saveUiSettings(harness, { expectedRevision: state.revision, settings, providerKeyActions: { alpha: 'clear', beta: 'keep' } });
  assert.equal(result.ok, true);
  let committed = JSON.parse(harness.evaluate('JSON.stringify(getJevConfig_())'));
  assert.equal(committed.providers.find((p) => p.id === 'alpha').apiKey, '');
  assert.equal(committed.providers.find((p) => p.id === 'beta').apiKey, 'secret-beta');
  const nextState = harness.getUiState();
  const nextSettings = nextState.settings;
  nextSettings.providers = nextSettings.providers.map(({ id, apiUrl, model }) => ({ id, apiUrl, model }));
  const empty = saveUiSettings(harness, { expectedRevision: nextState.revision, settings: nextSettings, providerKeyActions: { alpha: 'replace', beta: 'keep' }, providerKeys: { alpha: '   ' } });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'ERROR');
});

test('429 and 529 retry the active profile before rotating to a later keyed profile', function () {
  const harness = createHarness({ fetchSequence: [{ status: 429 }, { status: 529 }, {}] });
  harness.evaluate("var c = getJevConfig_(); c.providers = [{id:'primary',apiUrl:'https://primary.example/v1',model:'m1',apiKey:'key-primary'},{id:'backup',apiUrl:'https://backup.example/v1',model:'m2',apiKey:'key-backup'}]; c.apiUrl=c.providers[0].apiUrl;c.model=c.providers[0].model;c.apiKey=c.providers[0].apiKey;c.advanced.providerAttempts=2; commitJevConfig_(validateJevConfig_(c))");
  harness.run();
  assert.equal(harness.counters.fetches, 3);
  assert.deepEqual(harness.requests.map((r) => r.url), [
    'https://primary.example/v1', 'https://primary.example/v1', 'https://backup.example/v1',
  ]);
  assert.deepEqual(harness.requests.map((r) => r.options.headers.Authorization), [
    'Bearer key-primary', 'Bearer key-primary', 'Bearer key-backup',
  ]);
});

test('provider rate limit takes precedence over a later generic failure and stops the run', function () {
  const harness = createHarness({ candidateCount: 3, fetchSequence: [{ status: 429 }, { status: 400 }] });
  harness.evaluate("var c = getJevConfig_(); c.providers = [{id:'primary',apiUrl:'https://primary.example/v1',model:'m1',apiKey:'key-primary'},{id:'backup',apiUrl:'https://backup.example/v1',model:'m2',apiKey:'key-backup'}]; c.apiUrl=c.providers[0].apiUrl;c.model=c.providers[0].model;c.apiKey=c.providers[0].apiKey;c.advanced.providerAttempts=1;c.advanced.batchTargetTokens=1000; commitJevConfig_(validateJevConfig_(c))");
  const summary = harness.run();
  assert.equal(harness.counters.fetches, 2);
  assert.equal(harness.counters.batchModifies, 0);
  assert.equal(summary.ok, true);
  assert.equal(summary.summary.stopped, true);
  assert.equal(summary.summary.failed, 1);
  assert.equal(summary.summary.deferred, 2, 'unsubmitted candidates should remain deferred after an exhausted profile rate limit');
});

test('successful backup becomes the starting profile for the next classification batch', function () {
  const harness = createHarness({ candidateCount: 2, bodyLength: 5000, fetchSequence: [{ status: 400 }, {}, {}] });
  harness.evaluate("var c = getJevConfig_(); c.providers = [{id:'primary',apiUrl:'https://primary.example/v1',model:'m1',apiKey:'key-primary'},{id:'backup',apiUrl:'https://backup.example/v1',model:'m2',apiKey:'key-backup'}]; c.apiUrl=c.providers[0].apiUrl;c.model=c.providers[0].model;c.apiKey=c.providers[0].apiKey;c.advanced.batchTargetTokens=1000; commitJevConfig_(validateJevConfig_(c))");
  harness.run();
  assert.deepEqual(harness.requests.map((r) => r.url), [
    'https://primary.example/v1', 'https://backup.example/v1', 'https://backup.example/v1',
  ]);
});

test('unkeyed profiles are skipped and exhaustion visits each keyed profile once', function () {
  const harness = createHarness({ fetchSequence: [{ status: 400 }, { status: 400 }] });
  harness.evaluate("var c = getJevConfig_(); c.providers = [{id:'empty',apiUrl:'https://empty.example/v1',model:'m0',apiKey:''},{id:'first',apiUrl:'https://first.example/v1',model:'m1',apiKey:'key-first'},{id:'second',apiUrl:'https://second.example/v1',model:'m2',apiKey:'key-second'}]; c.apiUrl=c.providers[0].apiUrl;c.model=c.providers[0].model;c.apiKey=''; commitJevConfig_(validateJevConfig_(c))");
  harness.run();
  assert.deepEqual(harness.requests.map((r) => r.url), ['https://first.example/v1', 'https://second.example/v1']);
  assert.equal(harness.counters.batchModifies, 0, 'exhausted classification must not label any thread');
});

test('malformed provider response rotates to backup and diagnostics redact every configured key', function () {
  const harness = createHarness({
    fetchSequence: [{ body: '{not-json' }, {}],
    fetchError: null,
  });
  harness.evaluate("var c = getJevConfig_(); c.providers = [{id:'primary',apiUrl:'https://primary.example/v1',model:'m1',apiKey:'redact-primary'},{id:'backup',apiUrl:'https://backup.example/v1',model:'m2',apiKey:'redact-backup'}]; c.apiUrl=c.providers[0].apiUrl;c.model=c.providers[0].model;c.apiKey=c.providers[0].apiKey; commitJevConfig_(validateJevConfig_(c))");
  harness.run();
  assert.equal(harness.counters.fetches, 2);
  assert.deepEqual(harness.requests.map((r) => r.url), ['https://primary.example/v1', 'https://backup.example/v1']);
  const logs = harness.logs.map((entry) => entry.text).join('\n');
  assert.ok(!logs.includes('redact-primary'));
  assert.ok(!logs.includes('redact-backup'));
});

test('invalid category answers rotate to the next provider before any labels are applied', function () {
  const harness = createHarness({ responseFactory: function (payload, fetchCount) {
    const answers = {};
    Object.keys(payload.questions).forEach(function (key) { answers[key] = { type: 'noul', noul: fetchCount === 1 ? 2 : 0 }; });
    return { answers: answers };
  } });
  harness.evaluate("var c = getJevConfig_(); c.providers = [{id:'primary',apiUrl:'https://primary.example/v1',model:'m1',apiKey:'key-primary'},{id:'backup',apiUrl:'https://backup.example/v1',model:'m2',apiKey:'key-backup'}]; c.apiUrl=c.providers[0].apiUrl;c.model=c.providers[0].model;c.apiKey=c.providers[0].apiKey; commitJevConfig_(validateJevConfig_(c))");
  harness.run();
  assert.deepEqual(harness.requests.map((r) => r.url), ['https://primary.example/v1', 'https://backup.example/v1']);
  assert.equal(harness.counters.batchModifies, 1, 'labels are applied only after the backup response validates');
});

test('HTTP error diagnostics redact keys from every configured provider', function () {
  const harness = createHarness({ fetchSequence: [
    { status: 400, body: 'echo key-one key-two' },
    { status: 400, body: 'echo key-one key-two' },
  ] });
  harness.evaluate("var c = getJevConfig_(); c.providers = [{id:'one',apiUrl:'https://one.example/v1',model:'m1',apiKey:'key-one'},{id:'two',apiUrl:'https://two.example/v1',model:'m2',apiKey:'key-two'}]; c.apiUrl=c.providers[0].apiUrl;c.model=c.providers[0].model;c.apiKey=c.providers[0].apiKey; commitJevConfig_(validateJevConfig_(c))");
  harness.run();
  const logs = harness.logs.map((entry) => entry.text).join('\n');
  assert.ok(!logs.includes('key-one'));
  assert.ok(!logs.includes('key-two'));
});

test('settings save persists a custom fallback and key replacement without returning secrets', function () {
  const harness = createHarness();
  const state = harness.getUiState();
  const settings = state.settings;
  settings.fallbackLabel = 'Jev-Needs-Review';
  const result = saveUiSettings(harness, { expectedRevision: state.revision, settings: settings, apiKeyAction: 'replace', apiKey: 'new-private-api-key' });
  assert.equal(result.ok, true);
  assert.equal(result.apiKeyConfigured, true);
  assert.equal(result.settings.fallbackLabel, 'Jev-Needs-Review');
  assert.ok(!JSON.stringify(result).includes('new-private-api-key'));
  const refreshed = harness.getUiState();
  assert.equal(refreshed.revision, state.revision + 1);
  assert.equal(refreshed.settings.fallbackLabel, 'Jev-Needs-Review');
  assert.ok(!JSON.stringify(refreshed).includes('new-private-api-key'));
});

test('stale settings revisions are rejected without overwriting the committed fallback', function () {
  const harness = createHarness();
  const state = harness.getUiState();
  const settings = state.settings;
  settings.fallbackLabel = 'Jev-First-Save';
  assert.equal(saveUiSettings(harness, { expectedRevision: state.revision, settings: settings, apiKeyAction: 'keep' }).ok, true);
  const staleSettings = JSON.parse(JSON.stringify(state.settings));
  staleSettings.fallbackLabel = 'Jev-Stale-Save';
  const result = saveUiSettings(harness, { expectedRevision: state.revision, settings: staleSettings, apiKeyAction: 'keep' });
  assert.equal(result.code, 'CONFLICT');
  assert.equal(harness.getUiState().settings.fallbackLabel, 'Jev-First-Save');
});

test('blank API key replacement is rejected even while scheduling is paused', function () {
  const harness = createHarness();
  const state = harness.getUiState();
  const settings = state.settings;
  settings.enabled = false;
  const result = saveUiSettings(harness, { expectedRevision: state.revision, settings: settings, apiKeyAction: 'replace', apiKey: '   ' });
  assert.equal(result.ok, false);
  assert.equal(harness.getUiState().apiKeyConfigured, true, 'the prior key should remain committed');
});

test('malformed category entries return structured validation and preserve the committed settings', function () {
  const harness = createHarness();
  const state = harness.getUiState();
  const settings = state.settings;
  settings.categories = [null];
  const result = saveUiSettings(harness, { expectedRevision: state.revision, settings: settings, apiKeyAction: 'keep' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VALIDATION');
  assert.equal(harness.getUiState().revision, state.revision);
  assert.equal(harness.getUiState().settings.categories.length, 9);
});

test('unknown nested config fields never appear in browser settings state', function () {
  const harness = createHarness();
  const state = harness.getUiState();
  const settings = state.settings;
  settings.schedule.internalSecret = 'must-not-leak';
  settings.advanced.internalNote = 'must-not-leak-either';
  settings.categories[0].providerResponse = 'private';
  const result = saveUiSettings(harness, { expectedRevision: state.revision, settings: settings, apiKeyAction: 'keep' });
  assert.equal(result.ok, false, 'unsupported nested fields should be rejected');
  assert.equal(harness.getUiState().revision, state.revision, 'rejected input must leave the saved revision unchanged');
  harness.evaluate("var c = getJevConfig_(); c.schedule.internalSecret = 'must-not-leak'; c.advanced.internalNote = 'must-not-leak-either'; c.categories[0].providerResponse = 'private'; commitJevConfig_(c)");
  const refreshed = JSON.stringify(harness.getUiState());
  assert.ok(!refreshed.includes('must-not-leak'));
  assert.ok(!refreshed.includes('providerResponse'));
});

test('busy manual runs return structured BUSY and preserve the active running marker', function () {
  const harness = createHarness({ lockBusy: true });
  const active = JSON.stringify({ startedAt: Date.now(), source: 'scheduled', revision: 4 });
  harness.properties.JEV_INTERNAL_RUNNING = active;
  const result = harness.runNow();
  assert.equal(result.code, 'BUSY');
  assert.equal(harness.properties.JEV_INTERNAL_RUNNING, active);
});

test('manual processing runs while scheduled processing is paused', function () {
  const harness = createHarness();
  harness.evaluate("var config = getJevConfig_(); config.enabled = false; commitJevConfig_(config)");
  const result = harness.runNow();
  assert.equal(result.ok, true);
  assert.equal(harness.counters.searches, 1);
  assert.equal(harness.counters.batchModifies, 1);
});

test('failed replacement-trigger creation keeps the installed timer available', function () {
  const harness = createHarness({ triggerCreateError: new Error('trigger create failed') });
  const state = harness.getUiState();
  const settings = state.settings;
  settings.intervalMinutes = 10;
  const result = saveUiSettings(harness, { expectedRevision: state.revision, settings: settings, apiKeyAction: 'keep' });
  assert.equal(result.ok, true);
  assert.equal(result.schedulePending, true);
  assert.equal(harness.counters.triggerDeletes, 0);
  assert.equal(harness.getTriggers().length, 1);
});

test('pending schedule repair succeeds while paused and outside the active window', function () {
  const harness = createHarness({ triggerCreateError: new Error('trigger create failed') });
  const state = harness.getUiState();
  const settings = state.settings;
  settings.enabled = false;
  settings.intervalMinutes = 10;
  settings.schedule.weekdays = [1];
  settings.schedule.startTime = '22:00';
  settings.schedule.endTime = '23:00';
  assert.equal(saveUiSettings(harness, { expectedRevision: state.revision, settings: settings, apiKeyAction: 'keep' }).schedulePending, true);
  harness.clearTriggerCreateError();
  const result = JSON.parse(harness.evaluate('JSON.stringify(repairJevSchedule())'));
  assert.equal(result.ok, true);
  assert.equal(harness.getTriggers().length, 1);
});

test('manual run still classifies with valid saved settings when trigger installation is pending', function () {
  const harness = createHarness({ triggerCreateError: new Error('trigger create failed') });
  const state = harness.getUiState();
  const settings = state.settings;
  settings.intervalMinutes = 10;
  const saved = saveUiSettings(harness, { expectedRevision: state.revision, settings: settings, apiKeyAction: 'keep' });
  assert.equal(saved.ok, true);
  assert.equal(saved.schedulePending, true);

  const result = harness.runNow();
  assert.equal(result.ok, true);
  assert.equal(harness.counters.searches, 1, 'manual run should process even when timer repair keeps failing');
  assert.equal(harness.counters.batchModifies, 1);
  assert.equal(harness.getUiState().triggerHealth.healthy, false, 'scheduled timer remains visibly unhealthy');
});

test('installing the schedule takes the script lock and leaves timers untouched when busy', function () {
  const harness = createHarness({ lockBusy: true });
  const before = harness.properties.JEV_INTERNAL_TRIGGER_RECORD;
  harness.installTrigger();
  assert.equal(harness.counters.triggerCreates, 0);
  assert.equal(harness.counters.triggerDeletes, 0);
  assert.equal(harness.properties.JEV_INTERNAL_TRIGGER_RECORD, before);
});

test('legacy timer interval and ID migrate to the authoritative trigger record', function () {
  const harness = createHarness();
  harness.installTrigger();
  const record = JSON.parse(harness.properties.JEV_INTERNAL_TRIGGER_RECORD);
  assert.deepEqual(record, { schemaVersion: 1, intervalMinutes: 5, triggerId: 'trigger-initial' });
  assert.equal(harness.counters.triggerCreates, 0);
  assert.equal(harness.getTriggers().length, 1);
});

test('failed trigger-record publication keeps the old record and timer authoritative', function () {
  const harness = createHarness();
  const oldRecord = JSON.stringify({ schemaVersion: 1, intervalMinutes: 5, triggerId: 'trigger-initial' });
  harness.properties.JEV_INTERNAL_TRIGGER_RECORD = oldRecord;
  harness.evaluate("var c = getJevConfig_(); c.intervalMinutes = 10; commitJevConfig_(c)");
  harness.properties.JEV_INTERNAL_TRIGGER_RECORD = oldRecord;
  harness.properties.JEV_INTERNAL_TRIGGER_INTERVAL_MINUTES = '5';
  harness.properties.JEV_INTERNAL_TRIGGER_ID = 'trigger-initial';
  // Inject failure only after settings are committed, when the new timer record is published.
  harness.setTriggerRecordWriteFailure();
  assert.throws(function () { harness.installTrigger(); }, /injected property write failure/);
  assert.equal(harness.properties.JEV_INTERNAL_TRIGGER_RECORD, oldRecord);
  assert.equal(harness.getTriggers().some(function (trigger) { return trigger.getUniqueId() === 'trigger-initial'; }), true);
  assert.equal(harness.getTriggers().length, 1, 'the uncommitted replacement must be removed');
});

test('trigger health reports the old interval unhealthy after a saved interval change fails to install', function () {
  const harness = createHarness({ triggerCreateError: new Error('trigger create failed') });
  const state = harness.getUiState();
  const settings = state.settings;
  settings.intervalMinutes = 10;
  const result = saveUiSettings(harness, { expectedRevision: state.revision, settings: settings, apiKeyAction: 'keep' });
  assert.equal(result.schedulePending, true);
  assert.equal(harness.getUiState().triggerHealth.healthy, false);
});

test('cleanup failure preserves the new timer record and repair reuses its trigger', function () {
  const harness = createHarness({ deleteTriggerErrorId: 'trigger-initial' });
  const state = harness.getUiState();
  const settings = state.settings;
  settings.intervalMinutes = 10;
  const saved = saveUiSettings(harness, { expectedRevision: state.revision, settings: settings, apiKeyAction: 'keep' });
  assert.equal(saved.ok, true);
  assert.equal(saved.schedulePending, true);
  const record = JSON.parse(harness.properties.JEV_INTERNAL_TRIGGER_RECORD);
  assert.equal(record.intervalMinutes, 10);
  assert.notEqual(record.triggerId, 'trigger-initial');
  assert.equal(harness.getUiState().triggerHealth.healthy, false, 'duplicate timer remains unhealthy until repair');
  harness.clearTriggerDeleteFailure();
  const repaired = JSON.parse(harness.evaluate('JSON.stringify(repairJevSchedule())'));
  assert.equal(repaired.ok, true);
  assert.equal(harness.getTriggers().length, 1);
  assert.equal(harness.getTriggers()[0].getUniqueId(), record.triggerId, 'repair keeps the authoritative replacement');
  assert.equal(harness.counters.triggerCreates, 1);
});

test('manual run still processes when replacement timer is recorded but old-timer cleanup is pending', function () {
  const harness = createHarness({ deleteTriggerErrorId: 'trigger-initial' });
  const state = harness.getUiState();
  const settings = state.settings;
  settings.intervalMinutes = 10;
  const saved = saveUiSettings(harness, { expectedRevision: state.revision, settings: settings, apiKeyAction: 'keep' });
  assert.equal(saved.ok, true);
  assert.equal(saved.schedulePending, true);
  const record = JSON.parse(harness.properties.JEV_INTERNAL_TRIGGER_RECORD);
  assert.equal(record.intervalMinutes, 10);

  const result = harness.runNow();
  assert.equal(result.ok, true);
  assert.equal(harness.counters.searches, 1);
  assert.equal(harness.counters.batchModifies, 1);
  assert.equal(harness.getUiState().triggerHealth.healthy, false, 'leftover old timer remains visible as unhealthy until cleanup succeeds');
});

test('execution deadline during label setup defers all candidates without failure', function () {
  const harness = createHarness({ candidateCount: 20, sleepExtraMs: 240001 });
  harness.evaluate("var c = getJevConfig_(); c.advanced.gmailSpacingMs = 10000; commitJevConfig_(c)");
  const result = harness.runNow();
  assert.equal(result.ok, true);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.succeeded, 0);
  assert.equal(result.summary.deferred, 20);
  assert.equal(harness.counters.labelLists, 0, 'deadline overshoot must stop before issuing label-list request');
});

test('runtime budget during Gmail labeling defers unfinished threads without counting failures', function () {
  const harness = createHarness({ candidateCount: 20 });
  harness.evaluate("var config = getJevConfig_(); config.advanced.gmailSpacingMs = 10000; config.advanced.batchTargetTokens = 32000; commitJevConfig_(config)");
  const result = harness.runNow();
  assert.equal(result.ok, true);
  assert.equal(result.summary.failed, 0);
  assert.ok(result.summary.deferred > 0);
  assert.equal(result.summary.succeeded + result.summary.deferred, 20);
  assert.match(harness.logs.map(function (entry) { return entry.text; }).join('\n'), /deferred\./);
});

test('provider retry sleep reaching the execution deadline defers the unclassified request', function () {
  const harness = createHarness({ candidateCount: 17, bodyLength: 900, fetchStatus: 429 });
  harness.evaluate("var config = getJevConfig_(); config.advanced.gmailSpacingMs = 10000; config.advanced.batchTargetTokens = 32000; config.advanced.providerAttempts = 5; config.advanced.initialRetryDelayMs = 5000; commitJevConfig_(config)");
  const result = harness.runNow();
  assert.equal(result.ok, true);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.succeeded, 0);
  assert.equal(result.summary.deferred, 17);
  assert.ok(harness.counters.fetches < 5, 'retry sequence should stop before another request when its wait reaches the deadline');
});
