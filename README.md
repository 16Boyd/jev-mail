# Gmail categorization with Jev

Jev is a Google Apps Script that checks Gmail on a configurable schedule and sends eligible threads to a classification API. By default it uses TypeSafe Jev. The owner configures the script through its private web app; settings persist in Script Properties, so routine configuration changes do not require source edits or another code push.

## Behavior

- The default schedule checks every 5 minutes. Processing is disabled until the owner enables it in the web app.
- By default, each run fetches up to 100 candidate threads and classifies at most 20. Both limits are configurable in Advanced. Remaining threads are considered on later runs.
- Threads are packed into JEV requests in search order. The script estimates the complete serialized request at one token per four JSON characters and sends a request as soon as the configured packing target is reached, including the thread that crosses the threshold. The default target is 16,000 tokens. Any nonempty remainder is sent at the end of the run.
- Each batched request gives every thread a distinct named state entry and a separate question key for each category. Questions explicitly refer to their matching state entry, and the script maps answers back to the local thread list by key before labeling.
- Packing also respects the configured request and state/question token budgets, which default to 32,000 and 20,000 tokens. If an individual thread exceeds the state/question budget, the script deterministically truncates eligible message bodies, with a clear marker, until the combined thread fits. Sender, subject, message order, and IDs remain intact, and classification uses the retained text. A thread still over the limit after body truncation (for example, because metadata alone is too large) is skipped and remains eligible for a later run.
- A script lock prevents overlapping batch runs. Gmail API requests are paced according to the Advanced setting, which defaults to one second.
- Each `runJevBatch` invocation logs Gmail API request-attempt counts by method, published quota-unit costs, estimated Gmail quota units for that invocation, classifier `UrlFetchApp.fetch` attempts, and published per-minute Gmail quota reference limits. Counts include failed calls and provider retry attempts; they do not include hidden transport retries. Unit totals estimate this script's requests only and do not measure other clients or the live project quota. The published limits are references, not guarantees for this Cloud project; Google notes that some projects with Gmail API usage during November 2025 through April 2026 may retain previous quota settings.
- The **Mailbox scope** setting of `INBOX` selects threads with inbox mail. `ALL` also searches archived mail. Both modes exclude sent messages, drafts, Spam, and Trash; those messages are omitted even when they are part of an otherwise eligible thread.
- The configured API provider receives every eligible incoming message in each selected thread, with its sender, subject, and plain-text body. HTML-only bodies are converted to text. Oversized threads have their combined eligible message bodies truncated to fit the configured state/question budget (20,000 tokens by default); attachments are not sent.
- The classifier uses the enabled categories and their configured thresholds. A category applies only when its Noul probability is strictly greater than its threshold. A successfully classified thread gets `JEV` and either the labels for categories that pass or the separate `Jev-Uncategoried` fallback label when no category passes. The fallback is not a classifier category and has no question of its own. Failed or invalid classification results receive no result labels and are left eligible for a later run.
- The script never archives mail. It adds labels only to eligible incoming messages and does not remove existing labels. Sent messages are never sent to the provider or labeled. Email content is sent for classification and is not stored by this script.

Categories:

- Jev-Pending
- Jev-People & Personal
- Jev-Work & Career
- Jev-Home & Services
- Jev-Health & Benefits
- Jev-Money & Official Records
- Jev-Transactions & Bookings
- Jev-Accounts & Security
- Jev-News & Promotions

`Jev-Uncategoried` is a separate fallback label, not one of the categories above. Category and fallback label changes apply to future processing; the script does not remove previously applied labels.

## Deploy from a cloned repository with clasp

This is a standalone Apps Script project. [`clasp`](https://developers.google.com/apps-script/guides/clasp) uploads its source to Apps Script. The owner authorizes the script once, then deploys a private web app that runs as that owner. Settings changes made in the web app do not require pushing source code. Code changes still require `clasp push` and an update to the deployed web app version.

### Prerequisites

1. Install [Node.js 20 or later](https://nodejs.org/).
2. Enable the [Apps Script API](https://script.google.com/home/usersettings) for the Google account that will own the script.
3. Install clasp and sign in with that account:

   ```sh
   npm install -g @google/clasp
   clasp login
   ```

4. Clone this repository and open a terminal in the repository root. You may need repository access if it is private:

   ```sh
   git clone https://github.com/jasonb194/jev-mail.git
   cd jev-mail
   ```

There is no local web server or `npm start` command. Apps Script hosts the running app; this clone is its source and deployment workspace. No `npm install` is needed for the app. `npm test`, if run, is for diagnostics only.

### Create a script project and push the code

Create a new standalone GAS project with clasp, but run `clasp create` in a separate, empty temporary directory. It downloads starter files into its current directory, which could overwrite this repository's tracked source files if run here.

From the cloned repository root, these PowerShell commands create the remote project in a unique temporary folder, copy only its local project binding into the clone, then push this repository's source:

```powershell
$repoRoot = (Get-Location).Path
$bootstrapDir = Join-Path $env:TEMP ("jev-mail-clasp-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $bootstrapDir | Out-Null
Push-Location $bootstrapDir
try {
  clasp create --title "Jev Mail" --type standalone
  if ($LASTEXITCODE -ne 0) { throw "clasp create failed." }
}
finally { Pop-Location }
Copy-Item (Join-Path $bootstrapDir ".clasp.json") (Join-Path $repoRoot ".clasp.json")
clasp show-file-status
if ($LASTEXITCODE -ne 0) { throw "clasp show-file-status failed." }
clasp push
```

On macOS or Linux, from the repository root, use a separate temporary directory for project creation and copy only its generated `.clasp.json` back:

```sh
repo_root="$PWD"
bootstrap_dir="$(mktemp -d)"
(
  cd "$bootstrap_dir" &&
  clasp create --title "Jev Mail" --type standalone
) &&
cp "$bootstrap_dir/.clasp.json" "$repo_root/.clasp.json" &&
clasp show-file-status &&
clasp push
```

Do not copy the temporary directory's `Code.gs` or `appsscript.json`; this repository's files are the source of truth. Review the files shown by `clasp show-file-status` before pushing. If clasp asks whether to overwrite `appsscript.json`, confirm only when the listed local manifest is the one you intend to upload. `.clasp.json` contains this clone's private Apps Script project ID, is per-user, and is ignored by Git; do not commit or share it. The repository does not provide a reusable script ID or API key.

`clasp push` uploads the project source and manifest. The manifest already declares Gmail API v1 and the needed OAuth scopes. If you link the script to a standard Google Cloud project, enable the Gmail API in that Cloud project too.

### Authorize and deploy the web app

1. From the repository root, open the GAS project:

   ```sh
   clasp open-script
   ```

2. In the Apps Script editor, run `initializeJevProperties`. Choose the Google account that owns the mailbox and approve the requested permissions. Initialization preserves existing values and migrates the six legacy settings when present. New installations start paused; an existing `JEV_ENABLED` value is preserved.
3. In the Apps Script editor, choose **Deploy > New deployment**, select **Web app**, set **Execute as** to **Me** (`USER_DEPLOYING`) and **Who has access** to **Only myself** (`MYSELF`), then deploy. Complete Google's authorization flow and open the deployed web app as the same account. Do not choose an access option that permits other users to open this mailbox settings page.
4. In **Providers**, configure one to five ordered profiles, each with an HTTPS endpoint, model, and API key, plus mailbox scope. Keys are stored in the owner's Script Properties and are never returned to the page or included in settings exports. Keep the key out of the repository. Saving a configuration change does not require another source push.
5. Configure categories, the `Jev-Uncategoried` fallback label, schedule, and advanced settings. The default schedule is every five minutes, all seven days, full day, in `America/New_York`. Save changes, inspect any validation or schedule status, then enable scheduled processing when ready. Initialization installs a timer trigger, but a fresh installation remains paused until processing is enabled; existing setting values are preserved.

The manifest requests Gmail access (`gmail.modify`), permission to manage Apps Script triggers (`script.scriptapp`), and permission to call the configured API (`script.external_request`). Google's [`gmail.modify` scope](https://developers.google.com/workspace/gmail/api/auth/scopes) includes composing and sending mail, but this code only reads messages and applies labels; it does not send or archive mail. The installable trigger and web app run as the account that deployed them.

To update the running app after changing source, run `clasp push` from the repository root. In Apps Script, choose **Deploy > Manage deployments**, select the active web app, click **Edit**, select or create **New version**, and click **Deploy**. A source push alone does not update the deployed web app. Settings changes saved in the web app need no deployment update. See Google's [deployment guide](https://developers.google.com/apps-script/concepts/deployments) for details.

## Configure settings in the web app

The web app has five sections:

- **Dashboard:** processing state, trigger health, active cooldown, recent run summaries, **Run now**, and trigger repair.
- **Providers:** one to five ordered HTTPS endpoint/model/API-key profiles and `INBOX` or `ALL` mailbox scope. Move profiles to set fallback order; profile IDs preserve keys when profile settings change.
- **Schedule:** pause/resume, polling interval (1, 5, 10, 15, or 30 minutes), weekdays (Monday through Sunday), active hours, and timezone. Start time is inclusive and end time is exclusive. Equal start and end times mean all day. Overnight windows belong to the weekday on which they start.
- **Categories:** add, edit, reorder, disable, or remove categories; change labels and descriptions; set the default confidence threshold (0.75 by default) and per-category overrides. Thresholds are between 0 and 1, and a score must be greater than the threshold. The `Jev-Uncategoried` label is configured separately. It applies only after a valid classification when no enabled category passes its threshold.
- **Advanced:** fetched and classified thread limits, token budgets, provider attempts and retry delay, Gmail pacing, and quota cooldown durations.

The default categories and settings match the project's current defaults. Advanced defaults are 100 fetched threads (range 1–100), 20 classified threads (1–fetch limit), a 16,000-token request packing target (1,000–request budget), 32,000-token request budget (maximum 32,000), 20,000-token state/question budget (maximum 20,000 and no greater than the request budget), three provider attempts (1–5), 1,000 ms initial retry delay (250–5,000 ms), 1,000 ms Gmail spacing (1,000–10,000 ms), and 15/30/60-minute cooldowns (three nondecreasing values from 15–1,440 minutes). The script cooperatively stops starting work after four minutes and reports deferred threads. Limits are enforced before saving.

The settings panel supports API-key keep, replace, and clear actions, plus configuration import and export. Clearing the last configured key requires pausing scheduled processing first. Import accepts older single-provider exports and converts them to one profile. Keys stay with profile IDs already configured in this installation; profiles with new IDs need their keys entered before enabling processing. Exports omit API keys and internal runtime state. Saving requires the revision currently loaded in the page. If another tab has saved newer settings, reload before applying the draft. If processing holds the script lock, a save, schedule repair, or manual run reports busy; retry after the run ends. A settings save can succeed while trigger reconciliation is pending; the page reports this as “settings saved; schedule pending” and offers trigger repair.

Each provider profile uses its complete HTTPS endpoint, model, and API key. The provider must accept the same JSON request and Bearer API-key authentication; provider-specific request or authentication formats are not configurable in this script.

**Run now** uses saved settings and bypasses pause and active-hour/day restrictions. It still requires a configured API key and at least one enabled category, and respects the script lock and active quota cooldown. Manual runs do not change the saved schedule. Scheduled runs honor the enabled state, active schedule, key, enabled-category requirement, and cooldown. The dashboard shows trigger health, cooldown, and up to 20 recent run summaries, including outcome and processed/deferred counts.

Configuration is stored in versioned chunks in the owner's Script Properties. On first initialization, legacy values for `JEV_API_KEY`, `JEV_ENABLED`, `JEV_SCOPE`, `JEV_INTERVAL_MINUTES`, `JEV_MODEL`, and `JEV_API_URL` are migrated without resetting them. Thereafter, the web app's saved configuration is authoritative. Avoid editing configuration storage properties directly; use the web app. Trigger IDs and runtime status are maintained separately from user settings.

## Failures and retries

Configuration, Gmail search, Jev request, and invalid-response failures are logged with bounded diagnostics. For a failed thread, the log includes its thread ID, processing phase (`thread_read`, `classification`, `label_resolution`, or `gmail_labeling`), a bounded safe error category/name and message, a validated numeric HTTP status when available, and a fixed stack-omission marker. HTTP 4xx and 5xx failures also include the provider response body, capped at 2,000 characters. Provider text can include content echoed from the request. Every configured provider API key is redacted when it appears exactly in the body; other reflected content may appear. Raw provider and Gmail exception text and stacks are not emitted. A body decoding failure may also include only allowlisted shape metrics: the eligible message's 1-based position, MIME part path, normalized MIME type, and encoded data length. The script does not directly log request payloads, email body text, encoded body data, headers, or subjects; a provider may echo portions of those values in its response body.

To inspect a per-thread failure, open the Apps Script project and select **Executions**, then open the execution that ran at that time and inspect its logs. Per-thread errors are caught so the batch can continue, so the overall execution may be marked completed. Run `npm test` in this repository for local diagnostic coverage; the tests use stubbed Apps Script services and do not contact Gmail or the classification API.

The script validates every expected answer in a JEV response before applying labels to any thread in that request. After validation, it applies each thread's category labels and `JEV` label only to that thread's eligible messages in one Gmail batch request. Failed threads remain unmarked and eligible for a later run. Threads with more than 1,000 eligible messages are skipped before labeling because Gmail's batch-label request limit is 1,000 message IDs; they remain candidates and will be skipped on later runs.

If creating a Gmail label reports a conflict, the script refreshes the label list and reuses the label ID only if the exact requested name is present. A conflict that remains unresolved is treated as a thread failure.

If Gmail reports a recognized quota or rate-limit error, the script stops the current batch without retrying the failed Gmail operation. It persists the configured cooldowns across trigger invocations; the defaults are 15, 30, and 60 minutes. Triggers skip Gmail processing while the cooldown is active. A successful run, including a run with no candidates, clears the cooldown state. Gmail quota is shared with other clients, so pacing and cooldowns cannot guarantee that quota errors never occur.

The run metrics use the Gmail API's published costs: `threads.list` 10 units, `threads.get` 40, `labels.list` 1, `labels.create` 5, and `messages.batchModify` 50. The published per-minute references are 1,200,000 units per project and 6,000 units per user per project. See Google's [Gmail API quota documentation](https://developers.google.com/workspace/gmail/api/reference/quota). The logged per-run totals are estimates for this script's observed API call attempts only; they are not a measurement of total project consumption or a statement of this project's active quota configuration.

Provider HTTP 429 and 529 responses are retried per profile with exponential delays based on the configured initial retry delay (1 second by default). If one profile remains rate-limited or fails, JEV tries the next keyed profile; the successful profile is preferred for later batches in that run. If no profile succeeds and any profile returned 429 or 529, the request's threads are left unmarked, the run stops, and remaining candidates are deferred to a later trigger. Other request or answer-validation failures leave that request's threads unmarked while later batches continue. HTTP 4xx and 5xx logs include the bounded provider response body as described above.
