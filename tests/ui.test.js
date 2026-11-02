const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function extractFunction(name) {
  const start = script.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'missing function ' + name);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = script.indexOf('{', start); i < script.length; i += 1) {
    const c = script[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth += 1;
    if (c === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error('unterminated function ' + name);
}

function makeImportContext() {
  let fileText = '';
  const status = { className: '', textContent: '' };
  const context = {
    draft: { marker: 'previous draft', providers: [{ id: 'provider-1', apiKeyConfigured: true }] },
    providerKeys: { 'provider-1': 'pending-secret' },
    providerActions: { 'provider-1': 'replace' },
    $: () => status,
    setStatus: (el, msg, kind) => { el.textContent = msg; el.className = 'status' + (kind ? ' ' + kind : ''); },
    fillSettings: () => {},
    updateBadge: () => {},
    FileReader: class { readAsText() { this.result = fileText; this.onload(); } },
    setFileText: value => { fileText = JSON.stringify(value); },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('validLegacyEndpoint') + extractFunction('importSettings'), context);
  return { context, status };
}

function validSettings() {
  return {
    enabled: true, scope: 'INBOX', intervalMinutes: 5,
    providers: [{ id: 'profile-1', apiUrl: 'https://api.example.test/v1', model: 'model-a' }],
    defaultThreshold: 0.7, fallbackLabel: 'Jev-Uncategorized',
    schedule: { weekdays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00', timeZone: 'America/New_York' },
    categories: [],
    advanced: { maxThreadsToFetch: 20, maxThreadsToClassify: 10, batchTargetTokens: 4000, maxRequestTokens: 8000, maxStateQuestionTokens: 4000, providerAttempts: 2, initialRetryDelayMs: 500, gmailSpacingMs: 1000, cooldownMinutes: [15, 30, 60] },
  };
}

test('clean settings snapshots stay clean; form changes and pending key actions mark dirty', () => {
  const context = { original: null, providerActions: {}, providerKeys: {}, clone: value => JSON.parse(JSON.stringify(value)), getFormSettings: () => ({ enabled: true, scope: 'INBOX' }) };
  vm.createContext(context);
  vm.runInContext(extractFunction('stable') + extractFunction('dirty'), context);
  context.original = { enabled: true, scope: 'INBOX' };
  assert.equal(vm.runInContext('dirty()', context), false, 'load/save baseline is clean');
  context.getFormSettings = () => ({ enabled: false, scope: 'INBOX' });
  assert.equal(vm.runInContext('dirty()', context), true, 'a form edit is dirty');
  context.getFormSettings = () => ({ enabled: true, scope: 'INBOX' });
  assert.equal(vm.runInContext('dirty()', context), false, 'reverting a form edit clears dirty');
  context.providerActions = { 'profile-1': 'clear' };
  assert.equal(vm.runInContext('dirty()', context), true, 'a pending key action remains dirty');
  context.providerActions = {};
  context.providerKeys = { 'profile-1': 'pending-secret' };
  assert.equal(vm.runInContext('dirty()', context), true, 'a pending key value remains dirty');
});

test('load and save normalize legacy fields in the dirty-state baseline', async () => {
  const settings = validSettings();
  settings.apiUrl = 'https://legacy.example.test/v1';
  settings.model = 'legacy-model';
  const formSettings = validSettings();
  const context = {
    clone: value => JSON.parse(JSON.stringify(value)),
    original: null, draft: null, revision: 0, keyConfigured: false, busy: false,
    providerKeys: {}, providerActions: {},
    state: { ok: true, revision: 1, settings, apiKeyConfigured: true, triggerHealth: { healthy: true }, cooldown: { active: false }, lastRuns: [] },
    saveResult: { ok: true, revision: 2, settings, apiKeyConfigured: true },
    $: () => ({ className: '' }),
    setBusy: () => {}, setStatus: () => {}, fillSettings: () => {}, renderDashboard: () => {},
    text: () => {}, updateBadge: () => {}, refreshDashboard: async () => {},
    getFormSettings: () => formSettings,
    invoke: async name => name === 'getJevUiState' ? context.state : context.saveResult,
  };
  vm.createContext(context);
  vm.runInContext('let original=null,draft=null,revision=0,keyConfigured=false,busy=false,providerKeys={},providerActions={};' +
    'const clone=' + context.clone.toString() + ';' +
    'const comparableSettings=' + extractFunction('comparableSettings') + ';' +
    extractFunction('stable') + extractFunction('dirty') +
    'const setBusy=globalThis.setBusy, setStatus=globalThis.setStatus, fillSettings=globalThis.fillSettings, renderDashboard=globalThis.renderDashboard, text=globalThis.text, updateBadge=globalThis.updateBadge, refreshDashboard=globalThis.refreshDashboard, getFormSettings=globalThis.getFormSettings, invoke=globalThis.invoke;' +
    'async ' + extractFunction('load') + 'async ' + extractFunction('save') +
    'globalThis.runLoad=load;globalThis.runSave=save;globalThis.isDirty=dirty;', context);
  await context.runLoad();
  assert.equal(context.isDirty(), false, 'load baseline omits legacy top-level fields');
  await context.runSave();
  assert.equal(context.isDirty(), false, 'successful save baseline omits legacy top-level fields');
});

test('legacy import retains a configured key by matching profile ID', () => {
  const { context, status } = makeImportContext();
  const settings = validSettings();
  settings.providers = undefined;
  settings.apiUrl = 'https://api.example.test/v1';
  settings.model = 'legacy-model';
  context.setFileText({ schemaVersion: 1, settings });
  vm.runInContext("importSettings({size:1})", context);
  assert.equal(context.draft.providers[0].id, 'provider-1');
  assert.equal(context.draft.providers[0].apiKeyConfigured, true);
  assert.equal(context.providerKeys['provider-1'], 'pending-secret');
  assert.equal(context.providerActions['provider-1'], 'replace');
  assert.match(status.textContent, /Import preview loaded/);
});

test('malformed legacy imports report the bad field and preserve draft and pending key state', () => {
  const { context, status } = makeImportContext();
  const priorDraft = context.draft;
  const priorKeys = context.providerKeys;
  const priorActions = context.providerActions;
  const cases = [
    [{ model: 'legacy-model' }, /endpoint/i],
    [{ apiUrl: 'http://api.example.test/v1', model: 'legacy-model' }, /endpoint/i],
    [{ apiUrl: 'https://', model: 'legacy-model' }, /endpoint/i],
    [{ apiUrl: 'https://api.example.test/path with space', model: 'legacy-model' }, /endpoint/i],
    [{ apiUrl: 'https://api.example.test/v1#fragment', model: 'legacy-model' }, /endpoint/i],
    [{ apiUrl: 'https://user@api.example.test/v1', model: 'legacy-model' }, /endpoint/i],
    [{ apiUrl: 'https://api.example.test\\path', model: 'legacy-model' }, /endpoint/i],
    [{ apiUrl: 42, model: 'legacy-model' }, /endpoint/i],
    [{ apiUrl: 'https://api.example.test/v1' }, /model/i],
    [{ apiUrl: 'https://api.example.test/v1', model: '' }, /model/i],
    [{ apiUrl: 'https://api.example.test/v1', model: '   ' }, /model/i],
    [{ apiUrl: 'https://api.example.test/v1', model: 42 }, /model/i],
  ];
  for (const [providerFields, message] of cases) {
    const settings = validSettings();
    settings.providers = undefined;
    settings.apiUrl = providerFields.apiUrl;
    settings.model = providerFields.model;
    context.setFileText({ schemaVersion: 1, settings });
    vm.runInContext("importSettings({size:1})", context);
    assert.equal(context.draft, priorDraft);
    assert.equal(context.providerKeys, priorKeys);
    assert.equal(context.providerActions, priorActions);
    assert.equal(context.providerKeys['provider-1'], 'pending-secret');
    assert.equal(context.providerActions['provider-1'], 'replace');
    assert.match(status.textContent, message);
    assert.doesNotMatch(status.textContent, /Provider profiles must be a list/);
  }
});
