const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeConfigHarness(initialProperties, options) {
  const settings = options || {};
  const properties = Object.assign({}, initialProperties || {});
  let setCount = 0;
  const context = {
    console: { log() {}, error() {} },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperties() { return Object.assign({}, properties); },
          getProperty(key) { return Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : null; },
          setProperty(key, value) {
            setCount += 1;
            if (settings.failSetAt === setCount) throw new Error('injected property write failure');
            properties[key] = String(value);
          },
          deleteProperty(key) { delete properties[key]; },
        };
      },
    },
    Utilities: {
      newBlob(value) { return { getBytes() { return Array.from(Buffer.from(String(value), 'utf8')); } }; },
      formatDate(date, timeZone, pattern) {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone,
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(date).reduce((out, item) => { out[item.type] = item.value; return out; }, {});
        if (pattern === 'u') return String({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday]);
        if (pattern === 'HH:mm') return parts.hour + ':' + parts.minute;
        if (pattern === 'yyyy-MM-dd') return parts.year + '-' + parts.month + '-' + parts.day;
        throw new Error('Unsupported format pattern: ' + pattern);
      },
    },
    Date,
    Math,
    JSON,
    Number,
    String,
    Object,
    Array,
    Error,
  };
  vm.createContext(context);
  const source = ['Categories.gs', 'Config.gs'].map((file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n');
  vm.runInContext(source, context, { filename: 'jev-config.js' });
  return {
    evaluate(script) { return vm.runInContext(script, context); },
    properties,
    failAfterWrites(count) { settings.failSetAt = setCount + count; },
  };
}

function defaultConfig(harness) {
  return JSON.parse(harness.evaluate('JSON.stringify(createDefaultJevConfig_())'));
}

test('legacy properties migrate without losing existing provider and schedule values', function () {
  const harness = makeConfigHarness({
    JEV_API_KEY: 'legacy-key',
    JEV_ENABLED: 'false',
    JEV_SCOPE: 'ALL',
    JEV_INTERVAL_MINUTES: '15',
    JEV_MODEL: 'legacy-model',
    JEV_API_URL: 'https://provider.example/v2',
  });
  const config = JSON.parse(harness.evaluate('JSON.stringify(getJevConfig_())'));
  assert.equal(config.apiKey, 'legacy-key');
  assert.equal(config.enabled, false);
  assert.equal(config.scope, 'ALL');
  assert.equal(config.intervalMinutes, 15);
  assert.equal(config.model, 'legacy-model');
  assert.equal(config.apiUrl, 'https://provider.example/v2');
  assert.deepEqual(JSON.parse(JSON.stringify(config.providers)), [{ id: 'provider-1', apiUrl: 'https://provider.example/v2', model: 'legacy-model', apiKey: 'legacy-key' }]);
  assert.equal(config.fallbackLabel, 'Jev-Uncategoried');
  assert.equal(config.categories.length, 9);
});

test('provider profiles preserve ordered identities and validate count, IDs, URLs, models, and keys', function () {
  const harness = makeConfigHarness();
  const config = defaultConfig(harness);
  config.providers = [
    { id: 'first_profile', apiUrl: 'https://one.example/v1', model: ' model-one ', apiKey: ' key-one ' },
    { id: 'second-profile', apiUrl: 'https://two.example/v2', model: 'model-two', apiKey: '' },
  ];
  const normalized = JSON.parse(harness.evaluate('JSON.stringify(validateJevConfig_(' + JSON.stringify(config) + '))'));
  assert.deepEqual(normalized.providers.map((p) => p.id), ['first_profile', 'second-profile']);
  assert.equal(normalized.providers[0].model, 'model-one');
  assert.equal(normalized.providers[0].apiKey, 'key-one');
  assert.equal(normalized.model, 'model-one');

  const invalid = JSON.parse(JSON.stringify(config));
  invalid.providers = Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, apiUrl: 'https://p.example/v1', model: 'm', apiKey: '' }));
  assert.throws(() => harness.evaluate('validateJevConfig_(' + JSON.stringify(invalid) + ')'), /validation failed/);
  for (const badProfiles of [
    [{ id: 'same', apiUrl: 'https://a.example', model: 'm', apiKey: '' }, { id: 'same', apiUrl: 'https://b.example', model: 'm', apiKey: '' }],
    [{ id: 'bad id', apiUrl: 'https://a.example', model: 'm', apiKey: '' }],
    [{ id: 'constructor', apiUrl: 'https://a.example', model: 'm', apiKey: '' }],
    [{ id: 'p', apiUrl: 'http://a.example', model: 'm', apiKey: '' }],
    [{ id: 'p', apiUrl: 'https://a.example', model: ' ', apiKey: '' }],
    [{ id: 'p', apiUrl: 'https://a.example', model: 'm', apiKey: null }],
  ]) {
    const candidate = defaultConfig(harness);
    candidate.providers = badProfiles;
    assert.throws(() => harness.evaluate('validateJevConfig_(' + JSON.stringify(candidate) + ')'), /validation failed/);
  }
});

test('legacy top-level credentials synthesize a stable provider profile when profiles are absent', function () {
  const harness = makeConfigHarness();
  const config = defaultConfig(harness);
  delete config.providers;
  config.apiUrl = 'https://legacy.example/v1';
  config.model = 'legacy-model';
  config.apiKey = 'legacy-secret';
  const migrated = JSON.parse(harness.evaluate('JSON.stringify(validateJevConfig_(' + JSON.stringify(config) + '))'));
  assert.equal(migrated.providers.length, 1);
  assert.equal(migrated.providers[0].id, 'provider-1');
  assert.equal(migrated.providers[0].apiUrl, config.apiUrl);
  assert.equal(migrated.providers[0].model, config.model);
  assert.equal(migrated.providers[0].apiKey, config.apiKey);
});

test('UTF-8 configuration chunks stay within the per-property byte limit', function () {
  const harness = makeConfigHarness();
  const value = '📬é漢字'.repeat(5000);
  const result = harness.evaluate("JSON.stringify(splitJevUtf8_('📬é漢字'.repeat(5000)).map(function (chunk) { return utf8BytesJev_(chunk); }))");
  const sizes = JSON.parse(result);
  assert.ok(sizes.length > 1);
  assert.ok(sizes.every((size) => size <= 8192));
});

test('configuration commit stores UTF-8 chunks then switches the head and round-trips', function () {
  const harness = makeConfigHarness();
  const config = defaultConfig(harness);
  config.revision = 1;
  config.categories[0].description = '銀行📬'.repeat(900);
  harness.evaluate('commitJevConfig_(' + JSON.stringify(config) + ')');
  const head = JSON.parse(harness.properties.JEV_CONFIG_HEAD);
  assert.equal(head.revision, 1);
  assert.ok(head.byteLength <= 65536);
  for (let i = 0; i < head.chunks; i += 1) {
    const chunk = harness.properties['JEV_CONFIG_' + head.generation + '_' + i];
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= 8192);
  }
  const restored = JSON.parse(harness.evaluate('JSON.stringify(getJevConfig_())'));
  assert.equal(restored.categories[0].description, config.categories[0].description);
  assert.equal(restored.revision, 1);
});

test('failed generation writes leave the prior committed configuration readable', function () {
  const harness = makeConfigHarness();
  const first = defaultConfig(harness);
  first.revision = 1;
  harness.evaluate('commitJevConfig_(' + JSON.stringify(first) + ')');
  const originalHead = harness.properties.JEV_CONFIG_HEAD;
  const second = JSON.parse(JSON.stringify(first));
  second.revision = 2;
  second.model = 'new-model';
  second.categories[0].description = '銀行📬'.repeat(1500);
  harness.failAfterWrites(2);
  assert.throws(() => harness.evaluate('commitJevConfig_(' + JSON.stringify(second) + ')'), /injected property write failure/);
  assert.equal(harness.properties.JEV_CONFIG_HEAD, originalHead);
  const restored = JSON.parse(harness.evaluate('JSON.stringify(getJevConfig_())'));
  assert.equal(restored.revision, 1);
});

test('settings larger than 64 KB are rejected before committing', function () {
  const harness = makeConfigHarness();
  const config = defaultConfig(harness);
  config.categories[0].description = 'x'.repeat(70000);
  assert.throws(() => harness.evaluate('commitJevConfig_(' + JSON.stringify(config) + ')'), /64 KB/);
  assert.equal(harness.properties.JEV_CONFIG_HEAD, undefined);
});

test('corrupt committed heads and missing chunks fail closed', function () {
  const invalidHead = makeConfigHarness({ JEV_CONFIG_HEAD: '{broken' });
  assert.throws(() => invalidHead.evaluate('getJevConfig_()'), /corrupt/);
  const missingChunk = makeConfigHarness({ JEV_CONFIG_HEAD: JSON.stringify({ schemaVersion: 1, generation: 'generation123', chunks: 1, byteLength: 12 }) });
  assert.throws(() => missingChunk.evaluate('getJevConfig_()'), /corrupt/);
});

test('configuration revisions must be nonnegative integers and agree with the head', function () {
  const harness = makeConfigHarness();
  const invalid = defaultConfig(harness);
  invalid.revision = -1;
  assert.throws(() => harness.evaluate('validateJevConfig_(' + JSON.stringify(invalid) + ')'), /validation failed/);
  invalid.revision = 1.5;
  assert.throws(() => harness.evaluate('validateJevConfig_(' + JSON.stringify(invalid) + ')'), /validation failed/);

  const config = defaultConfig(harness);
  config.revision = 3;
  harness.evaluate('commitJevConfig_(' + JSON.stringify(config) + ')');
  const head = JSON.parse(harness.properties.JEV_CONFIG_HEAD);
  head.revision = 2;
  harness.properties.JEV_CONFIG_HEAD = JSON.stringify(head);
  assert.throws(() => harness.evaluate('getJevConfig_()'), /corrupt/);
});

test('category threshold validation and fallback label uniqueness are enforced', function () {
  const harness = makeConfigHarness();
  const config = defaultConfig(harness);
  config.categories[0].threshold = 1.1;
  assert.throws(() => harness.evaluate('validateJevConfig_(' + JSON.stringify(config) + ')'), /validation failed/);
  config.categories[0].threshold = null;
  config.fallbackLabel = config.categories[0].label;
  assert.throws(() => harness.evaluate('validateJevConfig_(' + JSON.stringify(config) + ')'), /validation failed/);
  config.fallbackLabel = 'Jev-Uncategoried';
  config.categories[0].label = 'TRASH';
  assert.throws(() => harness.evaluate('validateJevConfig_(' + JSON.stringify(config) + ')'), /validation failed/);
  config.categories[0].label = 'Jev-Pending';
  config.fallbackLabel = 'SPAM';
  assert.throws(() => harness.evaluate('validateJevConfig_(' + JSON.stringify(config) + ')'), /validation failed/);
});

test('schedule windows use the starting weekday for overnight ranges and handle full days', function () {
  const harness = makeConfigHarness();
  const config = defaultConfig(harness);
  config.schedule = { weekdays: [1], startTime: '22:00', endTime: '02:00', timeZone: 'America/New_York' };
  assert.equal(harness.evaluate("isJevScheduleEligible_(" + JSON.stringify(config) + ", new Date('2026-09-29T02:00:00Z'))"), true, 'Monday 22:00 local belongs to selected start day');
  assert.equal(harness.evaluate("isJevScheduleEligible_(" + JSON.stringify(config) + ", new Date('2026-09-29T07:00:00Z'))"), false, 'Tuesday 03:00 local falls outside the window');
  config.schedule = { weekdays: [2], startTime: '00:00', endTime: '00:00', timeZone: 'America/New_York' };
  assert.equal(harness.evaluate("isJevScheduleEligible_(" + JSON.stringify(config) + ", new Date('2026-09-29T16:00:00Z'))"), true, 'equal times represent the full selected day');
});

test('schedule eligibility follows local wall time across both daylight-saving transitions', function () {
  const harness = makeConfigHarness();
  const config = defaultConfig(harness);
  config.schedule = { weekdays: [7], startTime: '01:15', endTime: '02:30', timeZone: 'America/New_York' };
  assert.equal(harness.evaluate("isJevScheduleEligible_(" + JSON.stringify(config) + ", new Date('2026-11-01T05:30:00Z'))"), true, 'first repeated 01:30 is in the fall-back window');
  assert.equal(harness.evaluate("isJevScheduleEligible_(" + JSON.stringify(config) + ", new Date('2026-11-01T06:30:00Z'))"), true, 'second repeated 01:30 is in the fall-back window');
  assert.equal(harness.evaluate("isJevScheduleEligible_(" + JSON.stringify(config) + ", new Date('2026-03-08T06:30:00Z'))"), true, '01:30 before the spring-forward jump is in the window');
  assert.equal(harness.evaluate("isJevScheduleEligible_(" + JSON.stringify(config) + ", new Date('2026-03-08T07:30:00Z'))"), false, '03:30 after the spring-forward jump is outside the window');
});
