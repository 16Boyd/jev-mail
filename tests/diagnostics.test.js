const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const API_KEY = 'api-key-fixture-secret';
const FIXTURE_BODY = 'A private fixture sentence is being processed. The ordinary delivery arrives Tuesday. Please confirm the updated time. This final source sentence stays local.';
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
        labelIds: spec.labelIds || ['INBOX'],
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
    responseReads: 0,
    batchModifies: 0,
    decodeCalls: 0,
    batchModifyIds: [],
    batchModifyCalls: [],
    threadReadIds: [],
    labelQueries: [],
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
            counters.labelQueries.push(arguments[1] && arguments[1].q);
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
            if (threadId === settings.threadReadErrorThreadId) throw new Error('injected Gmail thread read failure');
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
            if (settings.existingReviewLabel) labels.push({ id: 'label-needs-review', name: 'Jev-Needs-Review', type: 'user' });
            if (settings.missingProcessedLabel) labels.splice(0, 1);
            if (settings.raceLabelVisible && counters.labelLists > 1) {
              labels.push({ id: 'race-label-id', name: settings.raceLabelName || 'Jev-Pending', type: 'user' });
            }
            return { labels: labels };
          },
    create: function (request) {
      counters.labelCreates += 1;
      if (settings.labelCreateError && request.name === 'Jev-Needs-Review') throw settings.labelCreateError;
      if (['INBOX', 'SPAM', 'TRASH'].indexOf(request.name) >= 0) throw new Error('System labels cannot be created.');
      if (settings.createConflict && request.name === settings.conflictLabelName) throw new Error('Label name already exists');
            return { id: 'created-label-' + request.name };
          },
        },
        Messages: {
          batchModify: function (request) {
            counters.batchModifies += 1;
            counters.batchModifyIds.push(request.addLabelIds);
            counters.batchModifyCalls.push({ ids: Array.from(request.ids), addLabelIds: Array.from(request.addLabelIds) });
            if (settings.reviewModifyError && (request.addLabelIds.indexOf('label-needs-review') >= 0 || request.addLabelIds.indexOf('created-label-Jev-Needs-Review') >= 0)) throw settings.reviewModifyError;
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
            counters.responseReads += 1;
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
    measureSummaryTokens: function (summaryLength) {
      context.__jevTestItems = [{ threadData: { state: { messages: [{ summary: 'x'.repeat(summaryLength) + '.' }] } } }];
      return vm.runInContext("getJevBatchAssessment_(__jevTestItems, 'test-model', getJevConfig_()).estimatedRequestTokens", context);
    },
    measureSummaryAssessment: function (summaryLength, itemCount) {
      context.__jevTestItems = Array.from({ length: itemCount || 1 }, function () {
        return { threadData: { state: { messages: [{ summary: 'x'.repeat(summaryLength) + '.' }] } } };
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
  assert.match(logText, /Batch complete: 0 succeeded, 2 failed, 0 needs review, 0 deferred\./);
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
  assert.match(logText, /Batch complete: 0 succeeded, 1 failed, 0 needs review, 2 deferred\./);
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
  assert.match(logText, /Batch complete: 0 succeeded, 2 failed, 0 needs review, 0 deferred\./);
});

test('thread IDs and MIME types are constrained before diagnostic logging', function () {
  const harness = createHarness({ threadId: FIXTURE_SENDER, mimeType: FIXTURE_SENDER, failDecode: true });
  harness.run();

  const logText = assertLogsExcludePrivateFixtures(harness);
  assert.match(logText, /Thread handed to manual review: local summary unavailable\./);
  assert.doesNotMatch(logText, /Thread processing failed/);
  assert.ok(!logText.includes(FIXTURE_SENDER));
});

test('HTTP 429 diagnostics retain safe status after retries without logging provider echoes', function () {
  const harness = createHarness({ fetchStatus: 429, httpErrorBody: 'rate limit response' });
  harness.run();

  const errorLog = harness.logs.filter(function (entry) { return entry.text.startsWith('[JEV] Thread processing failed: '); })[0];
  assert.ok(errorLog);
  const details = JSON.parse(errorLog.text.slice('[JEV] Thread processing failed: '.length));
  assert.equal(details.message, 'Request failed with HTTP 429.');
  assert.equal(details.errorName, 'Error');
  assert.equal(details.stack, '[omitted]');
  assert.equal(Object.prototype.hasOwnProperty.call(details, 'responseBody'), false);
  assert.equal(harness.counters.fetches, 3, 'provider 429 responses should use the existing retry count');
});

function readThreadErrorDetails(harness) {
  const entry = harness.logs.filter(function (log) { return log.text.startsWith('[JEV] Thread processing failed: '); })[0];
  assert.ok(entry, 'a thread error should be logged');
  return JSON.parse(entry.text.slice('[JEV] Thread processing failed: '.length));
}

test('HTTP 4xx and 5xx diagnostics omit provider response bodies', function () {
  [400, 503].forEach(function (status) {
    const body = 'provider error ' + status;
    const harness = createHarness({ fetchStatus: status, httpErrorBody: body });
    harness.run();
    const details = readThreadErrorDetails(harness);
    assert.equal(Object.prototype.hasOwnProperty.call(details, 'responseBody'), false);
    assert.equal(details.message, 'Request failed with HTTP ' + status + '.');
    assert.equal(details.stack, '[omitted]');
  });
});

test('HTTP response diagnostics omit bodies for empty and 3xx responses', function () {
  const emptyHarness = createHarness({ fetchStatus: 400, httpErrorBody: '' });
  emptyHarness.run();
  assert.equal(Object.prototype.hasOwnProperty.call(readThreadErrorDetails(emptyHarness), 'responseBody'), false);

  const redirectHarness = createHarness({ fetchStatus: 302, httpErrorBody: 'redirect details' });
  redirectHarness.run();
  assert.equal(Object.prototype.hasOwnProperty.call(readThreadErrorDetails(redirectHarness), 'responseBody'), false);
});

test('provider response bodies are not captured even when very long', function () {
  const harness = createHarness({ fetchStatus: 500, httpErrorBody: 'x'.repeat(2005) });
  harness.run();
  const details = readThreadErrorDetails(harness);
  assert.equal(Object.prototype.hasOwnProperty.call(details, 'responseBody'), false);
});

test('provider response bodies are never read on HTTP failure', function () {
  const harness = createHarness({ fetchStatus: 502, responseBodyReadError: 'private read exception detail' });
  harness.run();
  const details = readThreadErrorDetails(harness);
  assert.equal(details.message, 'Request failed with HTTP 502.');
  assert.equal(Object.prototype.hasOwnProperty.call(details, 'responseBody'), false);
  assert.ok(!JSON.stringify(details).includes('private read exception detail'));
  assert.equal(harness.counters.responseReads, 0, 'failed provider replies must not be read or logged');
});

test('provider error echoes are absent from diagnostics', function () {
  const echo = 'provider echoed ' + API_KEY + ' and private summary text';
  const harness = createHarness({ fetchStatus: 400, httpErrorBody: echo });
  harness.run();
  const details = readThreadErrorDetails(harness);
  assert.equal(Object.prototype.hasOwnProperty.call(details, 'responseBody'), false);
  assert.ok(!JSON.stringify(details).includes(API_KEY));
  assert.ok(!harness.logs.map(function (entry) { return entry.text; }).join('\n').includes(echo));
});

test('decoder failures receive only the review label and do not expose source data in logs', function () {
  const harness = createHarness({ failDecode: true });
  harness.run();
  assert.equal(harness.counters.fetches, 0, 'classification API must not be called after decoding fails');
  assert.equal(harness.counters.batchModifies, 1, 'eligible Gmail messages receive the review label after decoding fails');
  assert.deepEqual(harness.counters.batchModifyCalls[0].ids, ['eligible-message-' + FIXTURE_THREAD_ID]);
  assert.deepEqual(harness.counters.batchModifyCalls[0].addLabelIds, ['created-label-Jev-Needs-Review']);
  assert.equal(harness.counters.labelCreates, 1, 'only the review label should be created');
  assert.equal(harness.counters.fetches, 0, 'classification API must not be called after decoding fails');
  assertLogsExcludePrivateFixtures(harness);
  assert.ok(!harness.logs.map(function (entry) { return entry.text; }).join('\n').includes(FIXTURE_THREAD_ID), 'review handoff logs must not expose message or thread IDs');
});

test('valid body decoding continues through classification and labeling', function () {
  const harness = createHarness();
  harness.run();

  assert.equal(harness.counters.decodeCalls, 1);
  assert.equal(harness.counters.fetches, 1);
  assert.equal(harness.counters.batchModifies, 1);
  assert.equal(harness.counters.labelCreates, 0);
  const message = harness.requests[0].payload.state.threads.item_000.messages[0];
  assert.deepEqual(Object.keys(message), ['summary']);
  assert.equal(typeof message.summary, 'string');
  assert.ok(message.summary.length > 0);
  assert.ok(!JSON.stringify(message).includes(FIXTURE_BODY));
  const allLogs = harness.logs.map(function (entry) { return entry.text; }).join('\n');
  assert.ok(!allLogs.includes(FIXTURE_BODY));
  assert.ok(!allLogs.includes(API_KEY));
});

test('byte array body with shorter declared size is locally summarized', function () {
  const body = 'A complete byte array body is ready for review.';
  const bytes = Array.from(Buffer.from(body, 'utf8'));
  const harness = createHarness({ encodedBody: bytes, bodySize: bytes.length - 2 });
  harness.run();

  assert.equal(harness.counters.decodeCalls, 1);
  assert.equal(harness.counters.fetches, 1);
  const message = harness.requests[0].payload.state.threads.item_000.messages[0];
  assert.deepEqual(Object.keys(message), ['summary']);
  assert.ok(message.summary.length > 0);
  assert.equal(message.summary, body);
});

test('local summary removes common credential forms and all URLs before sending', function () {
  const sensitive = [
    'Meeting is scheduled for Thursday at 11 AM.',
    'password: violet-password-932',
    'Login: alice-login-932',
    'Your login code is login-code-932',
    'User name: username-value-932',
    'Security code: security-code-932',
    'Password:\nmultiline-password-932\n\n',
    'API key:\nmultiline-api-key-932\n\n',
    'AWS_SECRET_ACCESS_KEY:\nmultiline-aws-secret-932\n\n',
    'Database URL:\nmultiline-database-secret-932\n\n',
    'passphrase: violet-passphrase-932',
    'passcode: violet-passcode-932',
    'PIN: 849321',
    'OTP: 193482',
    'verification code: verify-932',
    'access_token=access-932',
    'refresh token: refresh-932',
    'client_secret: client-932',
    'credentials: user:password@database.example',
    'postgres://account:db-secret@db.example/private',
    '-----BEGIN PRIVATE KEY-----\nprivate-key-payload-932\n-----END PRIVATE KEY-----',
    'Authorization: Bearer bearer-value-932',
    'Authorization: Token token-scheme-value-932',
    'Proxy-Authorization: Custom proxy-scheme-value-932',
    'Basic dXNlcjpwYXNzd29yZA==',
    'API_KEY=assignment-value-932',
    '{"password":"json-secret-932"}',
    'https://person:secret@private.example/reset?token=url-token-932',
    'private.example/reset?token=bare-url-932',
    '\nThe team will send the final agenda tomorrow.',
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890AB',
    'ya29.abcdefghijklmnopqrstuvwx',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signaturepart',
    '\nThe project review remains on track for Friday.',
  ].join('\n\n');
  const harness = createHarness({ threadBodies: { [FIXTURE_THREAD_ID]: sensitive } });
  harness.run();
  assert.equal(harness.requests.length, 1);
  const outbound = JSON.stringify(harness.requests[0].payload);
  [
    'multiline-aws-secret-932', 'multiline-database-secret-932', 'alice-login-932', 'login-code-932', 'username-value-932', 'security-code-932', 'multiline-password-932', 'multiline-api-key-932', 'violet-password-932', 'violet-passphrase-932', 'violet-passcode-932', '849321',
    '193482', 'verify-932', 'access-932', 'refresh-932', 'client-932',
    'user:password@database.example', 'db-secret', 'private-key-payload-932',
    'bearer-value-932', 'token-scheme-value-932', 'proxy-scheme-value-932', 'dXNlcjpwYXNzd29yZA==',
    'assignment-value-932', 'json-secret-932', 'url-token-932', 'bare-url-932', 'private.example', 'AKIAIOSFODNN7EXAMPLE',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890AB', 'ya29.abcdefghijklmnopqrstuvwx',
    'eyJhbGciOiJIUzI1NiJ9', 'person:secret@private.example',
  ].forEach(function (secret) { assert.ok(!outbound.includes(secret), 'outbound request leaked ' + secret); });
  assert.ok(!outbound.includes('https://'));
  const message = harness.requests[0].payload.state.threads.item_000.messages[0];
  assert.deepEqual(Object.keys(message), ['summary']);
  assert.ok(message.summary.includes('Thursday'));
  assert.ok(message.summary.includes('agenda'));
  assert.ok(message.summary.includes('Friday'));
});

test('local summary redacts edge credential forms before selecting the safe sentence', function () {
  const cases = [
    {
      name: 'generic secret and token assignments including multiline values',
      input: 'secret=generic-secret-943\ntoken: generic-token-943\nAPI token: generic-api-token-943\nsecret:\nwrapped-secret-943\n\ntoken:\nwrapped-token-943\n\nAPI token:\nwrapped-api-token-943\n\nThe safe planning update is ready for review.',
      secrets: ['generic-secret-943', 'generic-token-943', 'generic-api-token-943', 'wrapped-secret-943', 'wrapped-token-943', 'wrapped-api-token-943'],
    },
    {
      name: 'MFA, 2FA, and authentication codes on same and following lines',
      input: 'MFA code: mfa-code-943\n2FA: twofa-code-943\nYour security code 849321 expires in five minutes.\nMFA code:\nwrapped-mfa-code-943\n\n2FA code:\nwrapped-twofa-code-943\n\nauthentication code:\nauth-code-943\n\nThe safe planning update is ready for review.',
      secrets: ['mfa-code-943', 'twofa-code-943', '849321', 'wrapped-mfa-code-943', 'wrapped-twofa-code-943', 'auth-code-943'],
    },
    {
      name: 'User identifiers',
      input: 'User: user-value-943\nUser id: user-id-value-943\nlogin id: login-id-value-943\n\nThe safe planning update is ready for review.',
      secrets: ['user-value-943', 'user-id-value-943', 'login-id-value-943'],
    },
    {
      name: 'empty Your password label across blank lines',
      input: 'Your password:\n\n\nempty-label-password-943\n\nThe safe planning update is ready for review.',
      secrets: ['empty-label-password-943'],
    },
    {
      name: 'arbitrary Authorization scheme with wrapped value',
      input: 'Authorization: Custom\nopaque authorization secret sentence-943.\n\nThe safe planning update is ready for review.',
      secrets: ['opaque authorization secret sentence-943'],
    },
    {
      name: 'JSON quoted password and Authorization values',
      input: '{"password":"json-password-edge-943","Authorization":"json-authorization-edge-943"}\n\nThe safe planning update is ready for review.',
      secrets: ['json-password-edge-943', 'json-authorization-edge-943'],
    },
    {
      name: 'HTML inline split labels and configured fallback key',
      input: '<p>Pass<script>ignored script text</script><b>word</b>: html-inline-password-943</p><p>Authori<b>zation</b>: Custom html-inline-auth-943</p><p>HTML fallback key html-fallback-<span>key</span>-943</p><br><p>The safe planning update is ready for review.</p>',
      secrets: ['html-inline-password-943', 'html-inline-auth-943', 'html-fallback-key-943'],
      configureFallback: true,
      mimeType: 'text/html',
    },
    {
      name: 'HTML fullwidth numeric entity and soft-hyphen credential labels',
      input: '<p>Pass&#xff57;ord: fullwidth-password-943</p><p>OTP: &#xff11;&#xff12;&#xff13;&#xff14;&#xff15;&#xff16;</p><p>pass&shy;word: soft-hyphen-password-943</p><p>Pass&#847;word: invisible-password-943</p><br><p>The safe planning update is ready for review.</p>',
      secrets: ['１２３４５６', '123456', 'fullwidth-password-943', 'soft-hyphen-password-943', 'invisible-password-943'],
      mimeType: 'text/html',
    },
    {
      name: 'URL schemes without double slashes and protocol-relative IP URLs',
      input: 'data:text/plain,reset-url-secret-943\nmailto:account@example.test?body=mail-url-secret-943\n//127.0.0.1/reset?opaque-url-secret-943\n\nThe safe planning update is ready for review.',
      secrets: ['reset-url-secret-943', 'mail-url-secret-943', 'opaque-url-secret-943'],
    },
    {
      name: 'populated credential assignment with an unindented continuation',
      input: 'password: first-part-943\nsecond secret phrase-943.\n\nThe safe planning update is ready for review.',
      secrets: ['first-part-943', 'second secret phrase-943'],
    },
    {
      name: 'HTML populated credential with a wrapped paragraph value',
      input: '<p>password: first-part-html-943</p><p>second secret phrase-html-943.</p><br><p>The safe planning update is ready for review.</p>',
      secrets: ['first-part-html-943', 'second secret phrase-html-943'],
      mimeType: 'text/html',
    },
    {
      name: 'new empty label within a discarded credential block',
      input: 'Username: account-943\nPassword:\n\nViolet meadow winter river.\n\nThe safe planning update is ready for review.',
      secrets: ['account-943', 'Violet meadow winter river'],
    },
    {
      name: 'nested HTML opening block separates credential labels',
      input: '<div>Account details<div>Password: nested-html-password-943.</div></div><br><p>The safe planning update is ready for review.</p>',
      secrets: ['nested-html-password-943'],
      mimeType: 'text/html',
    },
    {
      name: 'OTP without assignment punctuation',
      input: 'Your OTP 849321 expires in five minutes.\n\nThe safe planning update is ready for review.',
      secrets: ['849321'],
    },
  ];

  cases.forEach(function (fixture) {
    const harness = createHarness({
      threadBodies: { [FIXTURE_THREAD_ID]: fixture.input },
      mimeType: fixture.mimeType,
    });
    if (fixture.configureFallback) {
      harness.evaluate("var c = getJevConfig_(); c.providers = [{id:'primary',apiUrl:'https://primary.example/v1',model:'m1',apiKey:'primary-key-edge-943'},{id:'backup',apiUrl:'https://backup.example/v1',model:'m2',apiKey:'html-fallback-key-943'}]; c.apiUrl=c.providers[0].apiUrl;c.model=c.providers[0].model;c.apiKey=c.providers[0].apiKey; commitJevConfig_(validateJevConfig_(c))");
    }
    harness.run();

    assert.equal(harness.requests.length, 1, fixture.name + ': one outbound classification request');
    const outbound = JSON.stringify(harness.requests[0].payload);
    fixture.secrets.forEach(function (secret) {
      assert.ok(!outbound.includes(secret), fixture.name + ': outbound request leaked ' + secret);
    });
    assert.ok(!outbound.includes('primary-key-edge-943'), fixture.name + ': outbound request leaked the configured primary key');
    assert.deepEqual(Object.keys(harness.requests[0].payload.state.threads.item_000.messages[0]), ['summary']);
    assert.ok(harness.requests[0].payload.state.threads.item_000.messages[0].summary.includes('The safe planning update is ready for review.'), fixture.name + ': safe planning sentence should remain');

    const logs = harness.logs.map(function (entry) { return entry.text; }).join('\n');
    fixture.secrets.forEach(function (secret) {
      assert.ok(!logs.includes(secret), fixture.name + ': logs leaked ' + secret);
    });
    assert.ok(!logs.includes('primary-key-edge-943'), fixture.name + ': logs leaked the configured primary key');
  });
});

test('all configured fallback keys are removed locally before any provider request', function () {
  const body = 'The migration completes on Wednesday.\nprimary-key-local-932 backup-key-local-932\nThe team will verify access afterward.';
  const harness = createHarness({ threadBodies: { [FIXTURE_THREAD_ID]: body } });
  harness.evaluate("var c = getJevConfig_(); c.providers = [{id:'primary',apiUrl:'https://primary.example/v1',model:'m1',apiKey:'primary-key-local-932'},{id:'backup',apiUrl:'https://backup.example/v1',model:'m2',apiKey:'backup-key-local-932'}]; c.apiUrl=c.providers[0].apiUrl;c.model=c.providers[0].model;c.apiKey=c.providers[0].apiKey; commitJevConfig_(validateJevConfig_(c))");
  harness.run();
  assert.ok(harness.requests.length >= 1);
  harness.requests.forEach(function (request) {
    const outbound = JSON.stringify(request.payload);
    assert.ok(!outbound.includes('primary-key-local-932'));
    assert.ok(!outbound.includes('backup-key-local-932'));
    assert.deepEqual(Object.keys(request.payload.state.threads.item_000.messages[0]), ['summary']);
    assert.equal(request.options.headers.Authorization, request.url.includes('primary.') ? 'Bearer primary-key-local-932' : 'Bearer backup-key-local-932');
  });
});

test('token trimming preserves decimals and abbreviated names within complete sentences', function () {
  const harness = createHarness();
  const retained = 'Dr. Smith will pay 125.50 dollars on Friday.';
  const extra = 'The delivery team will confirm the final receipt tomorrow.';
  const result = harness.evaluate(`(function () {
    var config = getJevConfig_();
    var item = {threadData:{state:{messages:[{summary:${JSON.stringify(retained)}}]}}};
    config.advanced.maxRequestTokens = getJevBatchAssessment_([item], config.model, config).estimatedRequestTokens;
    item.threadData.state.messages[0].summary += ' ' + ${JSON.stringify(extra)};
    truncateJevThreadToFit_(item, config.model, config);
    return item.threadData.state.messages[0].summary;
  })()`);
  assert.equal(result, retained);
});

test('summary allowlist rejects sparse message arrays before provider fetch', function () {
  const harness = createHarness();
  assert.throws(function () {
    harness.evaluate('validateJevSummaryState_({messages:new Array(1)}, getJevConfig_())');
  }, /Local summary validation failed/);
  assert.equal(harness.counters.fetches, 0);
});

test('unsafe local mail cannot create the processed label when it does not exist', function () {
  const harness = createHarness({ missingProcessedLabel: true, threadBodies: { [FIXTURE_THREAD_ID]: 'password: confidential-local-value-943.' } });
  harness.run();
  assert.equal(harness.counters.fetches, 0);
  assert.equal(harness.counters.labelCreates, 1);
  assert.equal(harness.counters.batchModifies, 1);
  assert.deepEqual(harness.counters.batchModifyCalls[0].addLabelIds, ['created-label-Jev-Needs-Review']);
});

test('HTML, entities, line endings, and Unicode are normalized before local summarization', function () {
  const body = '<div>Résumé &#8212; delivery is due <b>today</b>.</div>\r\n<p>Confirm with José &amp; Ana.</p><p>https://private.example/path?token=html-url-932</p>';
  const harness = createHarness({ threadBodies: { [FIXTURE_THREAD_ID]: body }, mimeType: 'text/html' });
  harness.run();
  const message = harness.requests[0].payload.state.threads.item_000.messages[0];
  assert.deepEqual(Object.keys(message), ['summary']);
  assert.ok(message.summary.includes('Résumé'));
  assert.ok(message.summary.includes('José & Ana'));
  assert.ok(!JSON.stringify(message).includes('html-url-932'));
  assert.ok(!JSON.stringify(message).includes('private.example'));
  assert.ok(message.summary.length <= 800);
});

test('local summary is capped at 800 characters and contains complete sentences only', function () {
  const first = 'The first operational update contains useful context '.repeat(12) + 'for the response team. ';
  const second = 'The second operational update explains the next important action '.repeat(12) + 'for the response team. ';
  const third = 'The third operational update provides final details '.repeat(12) + 'for the response team.';
  const harness = createHarness({ threadBodies: { [FIXTURE_THREAD_ID]: first + second + third } });
  harness.run();
  const summary = harness.requests[0].payload.state.threads.item_000.messages[0].summary;
  assert.ok(summary.length > 0);
  assert.ok(summary.length <= 800);
  assert.ok(/[.!?]$/.test(summary), 'the summary must end at a complete sentence');
});

test('empty eligible message is routed to review without classification or normal labels', function () {
  const harness = createHarness({ threadBodies: { [FIXTURE_THREAD_ID]: '<div>\n &nbsp; \n</div>' } });
  const result = harness.run();
  assert.equal(harness.counters.fetches, 0);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.counters.batchModifies, 1);
  assert.deepEqual(harness.counters.batchModifyCalls[0].addLabelIds, ['created-label-Jev-Needs-Review']);
  assert.deepEqual(harness.counters.batchModifyCalls[0].ids, ['eligible-message-' + FIXTURE_THREAD_ID]);
  assert.equal(harness.counters.labelCreates, 1);
  assert.equal(result.summary.needsReview, 1, 'review routing is counted only after successful labeling');
});

test('credential-only message is routed to review without a placeholder summary', function () {
  const harness = createHarness({ threadBodies: { [FIXTURE_THREAD_ID]: 'password: credential-only-932\nhttps://private.example/reset?token=only-url-932\n> quoted text' } });
  harness.run();
  assert.equal(harness.counters.fetches, 0);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.counters.batchModifies, 1);
  assert.deepEqual(harness.counters.batchModifyCalls[0].addLabelIds, ['created-label-Jev-Needs-Review']);
  assert.equal(harness.counters.labelCreates, 1);
});

test('summaries stay within the per-message boundary and assessment contains only summaries', function () {
  const sizingHarness = createHarness();
  const assessment = sizingHarness.measureSummaryAssessment(799);
  assert.equal(Object.keys(assessment.payload.state.threads.item_000.messages[0]).join(','), 'summary');
  assert.ok(assessment.payload.state.threads.item_000.messages[0].summary.length <= 800);
  assert.ok(assessment.estimatedStateQuestionTokens <= 20000);
  assert.ok(assessment.estimatedRequestTokens <= 32000);
});

test('summary-only batch target flushes groups without losing threads or adding metadata', function () {
  const harness = createHarness({ threadId: 'crossing-thread', candidateCount: 20 });
  harness.evaluate("var c = getJevConfig_(); c.advanced.batchTargetTokens = 1000; commitJevConfig_(c)");
  harness.run();

  assert.ok(harness.requests.length > 1, 'the lower target should produce multiple summary-only requests');
  const totalQuestionKeys = harness.requests.reduce(function (total, request) {
    return total + Object.keys(request.payload.questions).length;
  }, 0);
  const totalStateEntries = harness.requests.reduce(function (total, request) {
    return total + Object.keys(request.payload.state.threads).length;
  }, 0);
  harness.requests.forEach(function (request) {
    Object.keys(request.payload.state.threads).forEach(function (threadKey) {
      request.payload.state.threads[threadKey].messages.forEach(function (message) {
        assert.deepEqual(Object.keys(message), ['summary']);
        assert.ok(message.summary.length > 0 && message.summary.length <= 800);
      });
    });
  });
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
  assert.match(harness.logs.map(function (entry) { return entry.text; }).join('\n'), /0 succeeded, 2 failed, 0 needs review, 0 deferred/);
});

test('missing batch answers fail every member before any label update', function () {
  const harness = createHarness({ threadId: 'missing-answer-thread', candidateCount: 2, omitAnswerKey: 'item_001__news-promotions' });
  harness.run();

  assert.equal(harness.counters.fetches, 1);
  assert.equal(harness.counters.batchModifies, 0);
  assert.equal(harness.counters.labelCreates, 0);
  assert.match(harness.logs.map(function (entry) { return entry.text; }).join('\n'), /0 succeeded, 2 failed, 0 needs review, 0 deferred/);
});

test('a decoded message above the local size bound is routed to review without provider fetch', function () {
  const body = 'private oversized body ' + 'x'.repeat(140000) + ' PRIVATE-ORIGINAL-TAIL';
  const harness = createHarness({ threadBodies: { 'oversized-thread': body }, threadId: 'oversized-thread', selectPending: true });
  harness.run();

  assert.equal(harness.counters.fetches, 0);
  assert.equal(harness.counters.batchModifies, 1);
  assert.deepEqual(harness.counters.batchModifyCalls[0].addLabelIds, ['created-label-Jev-Needs-Review']);
  assert.equal(harness.requests.length, 0);
  assertLogsExcludePrivateFixtures(harness, ['PRIVATE-ORIGINAL-TAIL']);
  assert.equal(harness.counters.labelCreates, 1);
});

test('one unsafe message routes every eligible message to review and leaves excluded messages untouched', function () {
  const specs = [
    { id: 'eligible-good', body: 'A useful update is ready for the team.' },
    { id: 'eligible-empty', body: '<div>&nbsp;</div>' },
    { id: 'excluded-sent', labelIds: ['SENT'], body: 'A sent message must remain untouched.' },
  ];
  const harness = createHarness({ threadId: 'mixed-thread', messageSpecsByThread: { 'mixed-thread': specs } });
  const result = harness.run();
  assert.equal(result.summary.needsReview, 1);
  assert.equal(result.summary.failed, 0);
  assert.equal(harness.counters.fetches, 0);
  assert.equal(harness.counters.batchModifies, 1);
  assert.deepEqual(harness.counters.batchModifyCalls[0].ids, ['eligible-good', 'eligible-empty']);
  assert.deepEqual(harness.counters.batchModifyCalls[0].addLabelIds, ['created-label-Jev-Needs-Review']);
});

test('review label is reused when it already exists', function () {
  const harness = createHarness({ existingReviewLabel: true, threadBodies: { [FIXTURE_THREAD_ID]: '<div></div>' } });
  const result = harness.run();
  assert.equal(result.summary.needsReview, 1);
  assert.equal(harness.counters.labelCreates, 0);
  assert.deepEqual(harness.counters.batchModifyCalls[0].addLabelIds, ['label-needs-review']);
});

test('review label creation failure counts as failure and does not classify', function () {
  const harness = createHarness({ labelCreateError: new Error('private label create failure'), threadBodies: { [FIXTURE_THREAD_ID]: '<div></div>' } });
  const result = harness.run();
  assert.equal(result.summary.needsReview, 0);
  assert.equal(result.summary.failed, 1);
  assert.equal(harness.counters.fetches, 0);
  assert.equal(harness.counters.batchModifies, 0);
  assert.equal(harness.counters.labelCreates, 1);
});

test('review label modification failure counts as failure without falling through to classification', function () {
  const harness = createHarness({ existingReviewLabel: true, reviewModifyError: new Error('private label modification failure'), threadBodies: { [FIXTURE_THREAD_ID]: '<div></div>' } });
  const result = harness.run();
  assert.equal(result.summary.needsReview, 0);
  assert.equal(result.summary.failed, 1);
  assert.equal(harness.counters.fetches, 0);
  assert.equal(harness.counters.batchModifies, 1);
  assert.deepEqual(harness.counters.batchModifyCalls[0].addLabelIds, ['label-needs-review']);
});

test('Gmail thread read and provider failures do not receive the review label', function () {
  const gmailFailure = createHarness({ threadReadErrorThreadId: FIXTURE_THREAD_ID });
  const gmailResult = gmailFailure.run();
  assert.equal(gmailResult.summary.needsReview, 0);
  assert.equal(gmailFailure.counters.batchModifies, 0);

  const providerFailure = createHarness({ fetchStatus: 400 });
  const providerResult = providerFailure.run();
  assert.equal(providerResult.summary.needsReview, 0);
  assert.equal(providerFailure.counters.batchModifies, 0);
  assert.equal(providerFailure.counters.labelCreates, 0);
});

test('oversized eligible ID sets are rejected before review label creation', function () {
  const specs = Array.from({ length: 1001 }, function (_, index) {
    return { id: 'eligible-' + index, body: index === 0 ? '<div></div>' : 'Must not need decoding after first rejection.' };
  });
  const harness = createHarness({ threadId: 'oversized-id-thread', messageSpecsByThread: { 'oversized-id-thread': specs } });
  const result = harness.run();
  assert.equal(result.summary.needsReview, 0);
  assert.equal(result.summary.failed, 1);
  assert.equal(harness.counters.fetches, 0);
  assert.equal(harness.counters.labelCreates, 0, 'size validation occurs before label lookup or creation');
  assert.equal(harness.counters.batchModifies, 0, 'oversized IDs are never partially labeled');
});

test('search hands review-labeled threads to the user until the review label is removed', function () {
  const harness = createHarness({ threadBodies: { [FIXTURE_THREAD_ID]: '<div></div>' } });
  harness.run();
  assert.match(harness.counters.labelQueries[0], /-label:JEV/);
  assert.match(harness.counters.labelQueries[0], /-label:Jev-Needs-Review/);
});

test('singleton token rejection routes to review before flushing a healthy pending thread', function () {
  const harness = createHarness({ threadId: 'token-thread', candidateCount: 2, threadBodies: {
    'token-thread-0': 'A healthy message is ready for review.',
    'token-thread-1': 'TOKEN_LIMIT_FIXTURE marks this safe sentence as a singleton that exceeds the configured assessment limit.',
  } });
  harness.evaluate("var originalAssessment = getJevBatchAssessment_; getJevBatchAssessment_ = function(items, model, config) { var a = originalAssessment(items, model, config); if (items.some(function(item) { return item.threadData.state.messages.some(function(message) { return message.summary.indexOf('TOKEN_LIMIT_FIXTURE') >= 0; }); })) a.estimatedRequestTokens = config.advanced.maxRequestTokens + 1; return a; }");
  const result = harness.run();
  assert.equal(result.summary.succeeded, 1);
  assert.equal(result.summary.needsReview, 1);
  assert.equal(harness.counters.fetches, 1, 'only the healthy thread is submitted');
  assert.deepEqual(harness.counters.batchModifyCalls[0].ids, ['eligible-message-token-thread-1']);
  assert.deepEqual(harness.counters.batchModifyCalls[0].addLabelIds, ['created-label-Jev-Needs-Review']);
  assert.deepEqual(harness.counters.batchModifyCalls[1].ids, ['eligible-message-token-thread-0']);
});

test('successful review routing is recorded separately from classification in run history', function () {
  const harness = createHarness({ threadBodies: { [FIXTURE_THREAD_ID]: '<div></div>' } });
  const result = harness.run();
  assert.equal(result.summary.succeeded, 0);
  assert.equal(result.summary.needsReview, 1);
  assert.equal(result.summary.failed, 0);
  const lastRun = harness.getUiState().lastRuns[0];
  assert.equal(lastRun.succeeded, 0);
  assert.equal(lastRun.needsReview, 1);
  assert.equal(lastRun.failed, 0);
});

test('outbound state excludes metadata and keeps only locally generated summaries', function () {
  const ordinary = 'The delivery arrives Tuesday at noon. Please leave it at reception.';
  const ordinaryHarness = createHarness({ threadBodies: { 'ordinary-thread': ordinary }, threadId: 'ordinary-thread' });
  ordinaryHarness.run();
  const ordinaryMessage = ordinaryHarness.requests[0].payload.state.threads.item_000.messages[0];
  assert.deepEqual(Object.keys(ordinaryMessage), ['summary']);
  assert.ok(ordinaryMessage.summary.length > 0);
  assert.ok(!JSON.stringify(ordinaryHarness.requests[0].payload.state).includes(FIXTURE_SUBJECT));
  assert.ok(!JSON.stringify(ordinaryHarness.requests[0].payload.state).includes(FIXTURE_SENDER));
  assert.equal(ordinaryMessage.summary, ordinary);

  const specs = [
    { id: 'eligible-multi-1', sender: 'one@example.test', subject: 'First subject', body: 'The first project detail remains important for the review. '.repeat(1500) + ' MULTI-TAIL-ONE' },
    { id: 'eligible-multi-2', sender: 'two@example.test', subject: 'Second subject', body: 'The second project detail remains important for the review. '.repeat(1500) + ' MULTI-TAIL-TWO' },
  ];
  const harness = createHarness({ threadId: 'multi-thread', messageSpecsByThread: { 'multi-thread': specs }, selectPending: true });
  harness.run();
  assert.equal(harness.counters.fetches, 1);
  assert.deepEqual(harness.counters.batchModifyCalls[0].ids, ['eligible-multi-1', 'eligible-multi-2']);
  const request = harness.requests[0];
  const serialized = request.options.payload;
  const messages = request.payload.state.threads.item_000.messages;
  assert.equal(messages.length, 2);
  assert.ok(messages.every(function (m) { return Object.keys(m).join(',') === 'summary' && m.summary.length > 0; }));
  assert.ok(!serialized.includes('one@example.test'));
  assert.ok(!serialized.includes('First subject'));
  assert.ok(Math.ceil(JSON.stringify({ state: request.payload.state, question: request.payload.questions.item_000__pending }).length / 4) <= 20000);
  assert.ok(Math.ceil(serialized.length / 4) <= 32000);
  assert.ok(!serialized.includes('MULTI-TAIL-ONE'));
  assert.ok(!serialized.includes('MULTI-TAIL-TWO'));
});

test('exhausted provider rate limits fail the sent batch and defer remaining candidates', function () {
  const harness = createHarness({
    threadId: 'provider-limit-thread',
    candidateCount: 20,
    fetchStatus: 429,
  });
  harness.evaluate("var c = getJevConfig_(); c.advanced.batchTargetTokens = 1000; commitJevConfig_(c)");
  harness.run();

  const logText = harness.logs.map(function (entry) { return entry.text; }).join('\n');
  assert.equal(harness.counters.fetches, 3);
  assert.ok(harness.counters.threadReads < 20);
  assert.equal(harness.counters.batchModifies, 0);
  assert.match(logText, /Stopping this batch after a rate-limit error/);
  assert.match(logText, /0 succeeded, \d+ failed, \d+ needs review, \d+ deferred\./);
  const summary = /Batch complete: 0 succeeded, (\d+) failed, \d+ needs review, (\d+) deferred\./.exec(logText);
  assert.ok(summary);
  assert.ok(Number(summary[1]) > 0);
  assert.ok(Number(summary[2]) > 0);
  assert.equal(Number(summary[1]) + Number(summary[2]), 20);
});

test('invalid byte array elements still fail decoding', function () {
  const harness = createHarness({ encodedBody: [65, 256, 67], bodySize: 1 });
  const result = harness.run();
  assert.equal(result.summary.needsReview, 1);
  assert.equal(harness.counters.batchModifies, 1);
  assert.deepEqual(harness.counters.batchModifyCalls[0].addLabelIds, ['created-label-Jev-Needs-Review']);
  assert.equal(harness.counters.fetches, 0);
});

test('invalid declared byte array size still fails decoding', function () {
  const harness = createHarness({ encodedBody: [65, 66, 67], bodySize: -1 });
  const result = harness.run();
  assert.equal(result.summary.needsReview, 1);
  assert.equal(harness.counters.batchModifies, 1);
  assert.deepEqual(harness.counters.batchModifyCalls[0].addLabelIds, ['created-label-Jev-Needs-Review']);
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
  assert.match(logText, /Batch complete: 0 succeeded, 1 failed, 0 needs review, 2 deferred\./);
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
  assert.match(logText, /Batch complete: 0 succeeded, 1 failed, 0 needs review, 2 deferred\./);
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
  const harness = createHarness({ candidateCount: 2, fetchSequence: [{ status: 400 }, {}, {}] });
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
  settings.fallbackLabel = 'Jev-Custom-Fallback';
  const result = saveUiSettings(harness, { expectedRevision: state.revision, settings: settings, apiKeyAction: 'replace', apiKey: 'new-private-api-key' });
  assert.equal(result.ok, true);
  assert.equal(result.apiKeyConfigured, true);
  assert.equal(result.settings.fallbackLabel, 'Jev-Custom-Fallback');
  assert.ok(!JSON.stringify(result).includes('new-private-api-key'));
  const refreshed = harness.getUiState();
  assert.equal(refreshed.revision, state.revision + 1);
  assert.equal(refreshed.settings.fallbackLabel, 'Jev-Custom-Fallback');
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
  const harness = createHarness({ candidateCount: 17, fetchStatus: 429 });
  harness.evaluate("var config = getJevConfig_(); config.advanced.gmailSpacingMs = 10000; config.advanced.batchTargetTokens = 32000; config.advanced.providerAttempts = 5; config.advanced.initialRetryDelayMs = 5000; commitJevConfig_(config)");
  const result = harness.runNow();
  assert.equal(result.ok, true);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.succeeded, 0);
  assert.equal(result.summary.deferred, 17);
  assert.ok(harness.counters.fetches < 5, 'retry sequence should stop before another request when its wait reaches the deadline');
});


test('an existing review marker holds new eligible replies before local summarization', function () {
  const harness = createHarness({ existingReviewLabel: true, messageSpecsByThread: { [FIXTURE_THREAD_ID]: [
    { id: 'held-message-private', labelIds: ['INBOX', 'label-needs-review'], body: 'Old held message.' },
    { id: 'new-message-private', body: 'New reply must remain local.' },
    { id: 'sent-private', labelIds: ['SENT'], body: 'Sent reply.' },
  ] } });
  harness.evaluate('summarizeJevMessage_ = function () { throw new Error("must not summarize held threads"); }');
  const result = harness.run();
  assert.equal(result.summary.needsReview, 1);
  assert.equal(harness.counters.fetches, 0);
  assert.deepEqual(harness.counters.batchModifyCalls, [{ ids: ['held-message-private', 'new-message-private'], addLabelIds: ['label-needs-review'] }]);
});

test('review label failures log only bounded identifier-free metadata', function () {
  for (const setting of ['labelCreateError', 'reviewModifyError']) {
    const options = { threadBodies: { [FIXTURE_THREAD_ID]: '<div></div>' } };
    options[setting] = new Error(FIXTURE_THREAD_ID + ' eligible-message-' + FIXTURE_THREAD_ID + ' private exception');
    const harness = createHarness(options);
    harness.run();
    const text = harness.logs.map(function (entry) { return entry.text; }).join('\n');
    assert.ok(!text.includes(FIXTURE_THREAD_ID));
    assert.ok(!text.includes('eligible-message-'));
    assert.ok(!text.includes('private exception'));
    assert.match(text, /Manual review labeling failed/);
    assert.match(text, /label_resolution|gmail_labeling/);
  }
});
