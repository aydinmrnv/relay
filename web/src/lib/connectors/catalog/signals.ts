// Things that break, and chores nobody schedules: CI, deploys, errors and crashes, flaky tests, security findings, finished feature flags.
//
// Every trigger here hands on a task rather than a raw event: a red build
// arrives as "fix this failing job" with the failing step and the end of its
// log, a crash as its stack trace, an advisory with the version that fixes it.
// That is what lets it feed the pipeline directly. The filters are the ones
// that keep a workflow from waking an agent for noise: the branch, the first
// failure rather than every repeat, a minimum severity or user count.
import { defineConnector, FIELDS, PORTS, taskSample, type Connector } from '../types';

const SEVERITY = FIELDS.select('severity', 'Minimum severity', [{ value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'critical', label: 'Critical' }], 'high');
const BRANCH = FIELDS.text('branch', 'Branch', 'main');
const FIRST_ONLY = FIELDS.bool('firstFailureOnly', 'Only the first failure', true, 'A branch that stays red fires once, not on every push after it, so one fix is in flight rather than five.');
const ENVIRONMENT = FIELDS.text('environment', 'Environment', 'production');
const MIN_USERS = FIELDS.number('minUsers', 'Only once it affects at least (users)', 5, 0, 100000, 1);

const failingBuild = (id: string, title: string, url: string, log: string, extra: Record<string, unknown> = {}) =>
  taskSample(id, title, url, `The job failed on main after 3f2a1c0 ("Retry webhook deliveries with backoff", by alice).\n\nLast lines of the log:\n${log}`, { branch: 'main', commit: '3f2a1c0', author: 'alice', labels: ['ci'], ...extra });
const JEST_LOG = '  ● webhook client › retries a 503 twice, then gives up\n    expect(received).toBe(expected)\n    Expected: 3\n    Received: 4\n      at Object.<anonymous> (src/webhooks/client.test.ts:88:27)\nTests: 1 failed, 412 passed';
const crash = (id: string, title: string, url: string, stack: string, extra: Record<string, unknown> = {}) =>
  taskSample(id, title, url, `First seen in release 2026.9.3, ${extra['users'] ?? 38} users affected, ${extra['events'] ?? 214} events in the last 24 hours.\n\nStack trace:\n${stack}`, { labels: ['error'], environment: 'production', users: 38, events: 214, ...extra });
const JS_STACK = 'TypeError: Cannot read properties of undefined (reading \'currency\')\n  at formatTotal (src/checkout/totals.ts:41:18)\n  at CheckoutSummary (src/checkout/Summary.tsx:67:9)\n  at renderWithHooks (react-dom.production.js:1:7634)';
const finding = (id: string, title: string, url: string, body: string, extra: Record<string, unknown> = {}) => taskSample(id, title, url, body, { labels: ['security'], severity: 'high', ...extra });

export const SIGNAL_CONNECTORS: Connector[] = [
  /* ---------------------------------------------------------------- */
  /* CI                                                                */
  /* ---------------------------------------------------------------- */
  defineConnector({
    id: 'github-actions',
    name: 'GitHub Actions',
    category: 'ci-cd',
    description: 'Workflow runs on GitHub Actions. A red run on main arrives as a task: the failing job, the step and the end of its log.',
    auth: 'app',
    icon: { si: 'SiGithubactions', color: '#2088FF' },
    docsUrl: 'https://docs.github.com/actions',
    tags: ['ci', 'build failed', 'tests failing', 'main is red'],
    popular: true,
    uses: [
      'main goes red and a fix PR is waiting before anyone has opened the log.',
      'Re-run a job once to rule out a flaky runner before waking an agent.',
    ],
    triggers: [
      {
        id: 'workflow-failed',
        name: 'Workflow run failed',
        description: 'A workflow fails on a branch. Hands on the failing job, step and log tail as the task.',
        outputs: PORTS.issueOut,
        fields: [FIELDS.text('workflow', 'Workflow', 'ci.yml'), BRANCH, FIRST_ONLY],
        sample: failingBuild('ci.yml#9913', 'CI failing on main: test (ubuntu-latest, 22)', 'https://github.com/acme/api/actions/runs/9913', JEST_LOG, { workflow: 'ci.yml', job: 'test (ubuntu-latest, 22)' }),
      },
    ],
    actions: [
      { id: 'rerun-failed-jobs', name: 'Re-run failed jobs', description: 'Re-run only the failed jobs, to rule out a flaky runner before spending on a fix.', inputs: PORTS.anyIn },
      { id: 'dispatch-workflow', name: 'Run a workflow', description: 'Start a workflow_dispatch workflow, such as the end-to-end suite against the new branch.', inputs: PORTS.anyIn, fields: [FIELDS.text('workflow', 'Workflow', 'e2e.yml', true), FIELDS.template('ref', 'Ref', '{{run.branch}}')] },
    ],
  }),
  defineConnector({
    id: 'gitlab-ci',
    name: 'GitLab CI',
    category: 'ci-cd',
    description: 'Pipelines on GitLab CI/CD. A failed pipeline on the default branch arrives as a task with the failing job\'s trace.',
    auth: 'token',
    icon: { si: 'SiGitlab', color: '#FC6D26' },
    docsUrl: 'https://docs.gitlab.com/ee/api/pipelines.html',
    tags: ['ci', 'pipeline failed'],
    uses: ['A failed pipeline on main gets a fix proposed as a merge request.'],
    triggers: [{ id: 'pipeline-failed', name: 'Pipeline failed', description: 'A pipeline fails on a ref.', outputs: PORTS.issueOut, fields: [FIELDS.text('ref', 'Ref', 'main'), FIRST_ONLY], sample: failingBuild('pipeline#61024', 'Pipeline failing on main: test:unit', 'https://gitlab.com/acme/api/-/pipelines/61024', JEST_LOG, { job: 'test:unit' }) }],
    actions: [{ id: 'retry-pipeline', name: 'Retry failed jobs', description: 'Retry the failed jobs once before spending on a fix.', inputs: PORTS.anyIn }],
  }),
  defineConnector({
    id: 'circleci',
    name: 'CircleCI',
    category: 'ci-cd',
    description: 'Workflows on CircleCI. A failed workflow on a branch arrives as a task with the failing step\'s output.',
    auth: 'token',
    icon: { si: 'SiCircleci', color: '#343434' },
    docsUrl: 'https://circleci.com/docs/api/v2/',
    tags: ['ci', 'build failed'],
    uses: ['A red build on main gets a fix PR and a message in #builds.'],
    triggers: [{ id: 'workflow-failed', name: 'Workflow failed', description: 'A workflow fails on a branch.', outputs: PORTS.issueOut, fields: [BRANCH, FIRST_ONLY], sample: failingBuild('build-and-test#772', 'CI failing on main: build-and-test', 'https://app.circleci.com/pipelines/github/acme/api/772/workflows/3d4e', JEST_LOG, { job: 'build-and-test' }) }],
    actions: [{ id: 'rerun-from-failed', name: 'Rerun from failed', description: 'Rerun the workflow from the failed job.', inputs: PORTS.anyIn }],
  }),
  defineConnector({
    id: 'buildkite',
    name: 'Buildkite',
    category: 'ci-cd',
    description: 'Builds on Buildkite. A failed build on a branch arrives as a task with the failing step\'s log.',
    auth: 'token',
    icon: { si: 'SiBuildkite', color: '#14CC80' },
    docsUrl: 'https://buildkite.com/docs/apis/rest-api',
    tags: ['ci', 'build failed'],
    uses: ['A red build on main gets a fix PR, one at a time however often it fails.'],
    triggers: [{ id: 'build-failed', name: 'Build failed', description: 'A build fails on a branch.', outputs: PORTS.issueOut, fields: [FIELDS.text('pipeline', 'Pipeline', 'api'), BRANCH, FIRST_ONLY], sample: failingBuild('api#2202', 'Build failing on main: :jest: unit tests', 'https://buildkite.com/acme/api/builds/2202', JEST_LOG, { job: ':jest: unit tests' }) }],
    actions: [{ id: 'retry-job', name: 'Retry failed jobs', description: 'Retry the failed jobs once before spending on a fix.', inputs: PORTS.anyIn }],
  }),
  defineConnector({
    id: 'jenkins',
    name: 'Jenkins',
    category: 'ci-cd',
    description: 'Builds on a Jenkins controller. A failed or unstable build arrives as a task with the console tail.',
    auth: 'token',
    icon: { si: 'SiJenkins', color: '#D24939' },
    docsUrl: 'https://www.jenkins.io/doc/book/using/remote-access-api/',
    tags: ['ci', 'self-hosted', 'build failed'],
    uses: ['A broken main-branch job gets a fix PR proposed overnight.'],
    triggers: [{ id: 'build-failed', name: 'Build failed', description: 'A job build fails or turns unstable.', outputs: PORTS.issueOut, fields: [FIELDS.text('job', 'Job', 'api/main'), FIRST_ONLY], sample: failingBuild('api/main#513', 'Jenkins api/main failing: unit tests', 'https://ci.acme.dev/job/api/job/main/513/', JEST_LOG) }],
    actions: [],
  }),
  defineConnector({
    id: 'bitrise',
    name: 'Bitrise',
    category: 'ci-cd',
    description: 'Mobile builds on Bitrise. A failed build arrives as a task with the failing step\'s log.',
    auth: 'token',
    icon: { si: 'SiBitrise', color: '#683D87' },
    docsUrl: 'https://api-docs.bitrise.io/',
    tags: ['ci', 'mobile', 'ios', 'android'],
    uses: ['A failing mobile build on main gets a fix PR before the morning stand-up.'],
    triggers: [{ id: 'build-failed', name: 'Build failed', description: 'A build fails on a branch.', outputs: PORTS.issueOut, fields: [FIELDS.text('workflow', 'Workflow', 'primary'), BRANCH, FIRST_ONLY], sample: failingBuild('primary#7a9d', 'Bitrise primary failing on main: Xcode Test', 'https://app.bitrise.io/build/7a9d', "Test Case '-[FeedTests testEmptyStateShowsRetry]' failed (0.214 seconds).\nFeedTests.swift:48: XCTAssertTrue failed") }],
    actions: [],
  }),
  defineConnector({
    id: 'xcode-cloud',
    name: 'Xcode Cloud',
    category: 'ci-cd',
    description: 'Apple\'s CI in App Store Connect. A failed build arrives as a task with the failing test or build error.',
    auth: 'api-key',
    icon: { lucide: 'CloudCog', color: '#1575F9' },
    docsUrl: 'https://developer.apple.com/documentation/appstoreconnectapi/xcode_cloud_workflows_and_builds',
    tags: ['ci', 'ios', 'apple'],
    uses: ['A failing iOS build gets a fix PR. The agents need a Mac to build it, so run this one on a machine of your own.'],
    triggers: [{ id: 'build-failed', name: 'Build failed', description: 'A workflow build fails.', outputs: PORTS.issueOut, fields: [FIELDS.text('workflow', 'Workflow', 'Default'), BRANCH], sample: failingBuild('build-45', 'Xcode Cloud failing on main: Test - iOS', 'https://appstoreconnect.apple.com/teams/1/apps/2/ci/builds/45', "FeedViewController.swift:112:9: error: value of type 'FeedItem' has no member 'thumbnailURL'") }],
    actions: [],
  }),

  /* ---------------------------------------------------------------- */
  /* Deploys                                                           */
  /* ---------------------------------------------------------------- */
  defineConnector({
    id: 'vercel',
    name: 'Vercel',
    category: 'hosting',
    description: 'Deployments on Vercel. A production build that fails arrives as a task with the build error.',
    auth: 'oauth',
    icon: { si: 'SiVercel', color: '#000000' },
    docsUrl: 'https://vercel.com/docs/rest-api',
    tags: ['deploy failed', 'build error'],
    popular: true,
    uses: ['A production build that broke on a type error gets a fix PR instead of a red deploy page.'],
    triggers: [{ id: 'deployment-failed', name: 'Deployment failed', description: 'A deployment errors during build.', outputs: PORTS.issueOut, fields: [FIELDS.text('project', 'Project', 'web'), FIELDS.select('target', 'Target', [{ value: 'production', label: 'Production only' }, { value: 'any', label: 'Production and previews' }], 'production')], sample: taskSample('dpl_8f2d', 'Production build failing: web', 'https://vercel.com/acme/web/deployments/dpl_8f2d', "Build failed after 3f2a1c0.\n\n./src/app/settings/page.tsx:22:7\nType error: Property 'plan' does not exist on type 'Account'.", { branch: 'main', labels: ['deploy'] }) }],
    actions: [],
  }),
  defineConnector({
    id: 'netlify',
    name: 'Netlify',
    category: 'hosting',
    description: 'Site deploys on Netlify. A failed production deploy arrives as a task with the build log.',
    auth: 'oauth',
    icon: { si: 'SiNetlify', color: '#00C7B7' },
    docsUrl: 'https://docs.netlify.com/api/get-started/',
    tags: ['deploy failed', 'build error'],
    uses: ['A failed production deploy gets a fix PR instead of waiting for someone to read the log.'],
    triggers: [{ id: 'deploy-failed', name: 'Deploy failed', description: 'A site deploy fails.', outputs: PORTS.issueOut, fields: [FIELDS.text('site', 'Site', 'acme-web')], sample: taskSample('66a2', 'Production deploy failing: acme-web', 'https://app.netlify.com/sites/acme-web/deploys/66a2', "Build failed after 3f2a1c0.\n\nerror during build:\nCould not resolve './components/Hero' from src/pages/index.astro", { branch: 'main', labels: ['deploy'] }) }],
    actions: [],
  }),

  /* ---------------------------------------------------------------- */
  /* Errors and crashes                                                */
  /* ---------------------------------------------------------------- */
  defineConnector({
    id: 'sentry',
    name: 'Sentry',
    category: 'observability',
    description: 'Errors in production. A new or regressed issue arrives as a task with its stack trace, release and how many people it hits.',
    auth: 'app',
    icon: { si: 'SiSentry', color: '#362D59' },
    docsUrl: 'https://docs.sentry.io/api/',
    tags: ['errors', 'exceptions', 'regressions'],
    popular: true,
    uses: [
      'A regression in the last release gets a fix PR linked on the Sentry issue.',
      'Errors that need a product decision become a ticket with the stack trace, not a PR.',
      'Assign a Sentry issue to the bot to ask for a fix by hand.',
    ],
    triggers: [
      { id: 'issue-created', name: 'New issue', description: 'A new error group appears in an environment, once it affects enough people to matter.', outputs: PORTS.issueOut, fields: [FIELDS.text('project', 'Project', 'web'), ENVIRONMENT, MIN_USERS], sample: crash('WEB-2417', "TypeError: Cannot read properties of undefined (reading 'currency')", 'https://acme.sentry.io/issues/2417/', JS_STACK) },
      { id: 'issue-regressed', name: 'Issue regressed', description: 'An issue marked resolved comes back, usually because of the latest release.', outputs: PORTS.issueOut, fields: [FIELDS.text('project', 'Project', 'web'), ENVIRONMENT], sample: crash('WEB-1877', 'ChunkLoadError: Loading chunk 42 failed', 'https://acme.sentry.io/issues/1877/', 'ChunkLoadError: Loading chunk 42 failed.\n  at __webpack_require__.f.j (runtime.js:1:4410)\n  at lazyRoute (src/routes.tsx:18:22)', { regression: true, labels: ['error', 'regression'] }) },
      { id: 'issue-assigned', name: 'Assigned to the bot', description: 'Someone assigns a Sentry issue to the bot: a fix asked for by hand.', outputs: PORTS.issueOut, fields: [FIELDS.text('assignee', 'Assigned to', 'relay-bot')], sample: crash('WEB-2420', 'Unhandled promise rejection in SyncWorker', 'https://acme.sentry.io/issues/2420/', 'Error: sync token expired\n  at SyncWorker.flush (src/sync/worker.ts:93:11)', { assignee: 'relay-bot' }) },
    ],
    actions: [
      { id: 'link-pr', name: 'Link pull request', description: 'Comment the fixing PR on the Sentry issue, so whoever opens it next sees a fix is in review.', inputs: PORTS.changeIn, fields: [FIELDS.template('body', 'Comment', 'Fix in review: {{run.prUrl}}')] },
      { id: 'resolve-issue', name: 'Resolve in next release', description: 'Mark the issue resolved in the next release, so it reopens as a regression if the fix did not hold.', inputs: PORTS.anyIn, fields: [FIELDS.bool('inNextRelease', 'Resolve in next release', true)] },
      { id: 'add-comment', name: 'Comment', description: 'Comment on the issue, e.g. why it was sent to a person instead.', inputs: PORTS.anyIn, fields: [FIELDS.template('body', 'Comment', 'Not fixed automatically: this needs a person. Ticket filed with the stack trace.')] },
      { id: 'assign-issue', name: 'Assign', description: 'Assign the issue to the team that owns the code.', inputs: PORTS.anyIn, fields: [FIELDS.text('assignee', 'Assignee', 'team:platform')] },
    ],
  }),
  defineConnector({
    id: 'bugsnag',
    name: 'Bugsnag',
    category: 'observability',
    description: 'Errors and crashes in Bugsnag. A new or reopened error arrives as a task with its stack trace.',
    auth: 'token',
    icon: { lucide: 'Bug', color: '#4949E4' },
    docsUrl: 'https://bugsnagapiv2.docs.apiary.io/',
    tags: ['errors', 'crashes', 'stability'],
    uses: ['A new crash in the latest release gets a fix PR, and the error is marked fixed once it ships.'],
    triggers: [
      { id: 'new-error', name: 'New error', description: 'An error is seen for the first time in a release stage.', outputs: PORTS.issueOut, fields: [FIELDS.text('releaseStage', 'Release stage', 'production'), MIN_USERS], sample: crash('bs_5f1a', "TypeError: Cannot read properties of undefined (reading 'currency')", 'https://app.bugsnag.com/acme/web/errors/5f1a', JS_STACK) },
      { id: 'error-reopened', name: 'Error reopened', description: 'An error marked fixed happens again.', outputs: PORTS.issueOut, fields: [FIELDS.text('releaseStage', 'Release stage', 'production')], sample: crash('bs_5f1b', 'ChunkLoadError: Loading chunk 42 failed', 'https://app.bugsnag.com/acme/web/errors/5f1b', 'ChunkLoadError: Loading chunk 42 failed.\n  at lazyRoute (src/routes.tsx:18:22)', { regression: true }) },
    ],
    actions: [
      { id: 'add-comment', name: 'Comment', description: 'Comment the fixing PR on the error.', inputs: PORTS.anyIn, fields: [FIELDS.template('body', 'Comment', 'Fix in review: {{run.prUrl}}')] },
      { id: 'mark-fixed', name: 'Mark as fixed', description: 'Mark the error fixed, so it reopens if it comes back.', inputs: PORTS.anyIn },
    ],
  }),
  defineConnector({
    id: 'rollbar',
    name: 'Rollbar',
    category: 'observability',
    description: 'Errors in Rollbar. A new or reactivated item arrives as a task with its traceback.',
    auth: 'token',
    icon: { lucide: 'Activity', color: '#3569F3' },
    docsUrl: 'https://docs.rollbar.com/reference',
    tags: ['errors', 'exceptions'],
    uses: ['A new production error gets a fix PR commented on the Rollbar item.'],
    triggers: [
      { id: 'new-item', name: 'New item', description: 'An error is seen for the first time in an environment.', outputs: PORTS.issueOut, fields: [ENVIRONMENT], sample: crash('rb_8812', "KeyError: 'currency'", 'https://app.rollbar.com/a/acme/fix/item/api/8812', 'Traceback (most recent call last):\n  File "app/checkout/totals.py", line 41, in format_total\n    code = order["currency"]\nKeyError: \'currency\'') },
      { id: 'reactivated-item', name: 'Item reactivated', description: 'A resolved item happens again.', outputs: PORTS.issueOut, fields: [ENVIRONMENT], sample: crash('rb_8813', 'TimeoutError in payments client', 'https://app.rollbar.com/a/acme/fix/item/api/8813', 'TimeoutError: payments-service did not answer in 5s\n  File "app/payments/client.py", line 77, in charge', { regression: true }) },
    ],
    actions: [
      { id: 'add-comment', name: 'Comment', description: 'Comment the fixing PR on the item.', inputs: PORTS.anyIn, fields: [FIELDS.template('body', 'Comment', 'Fix in review: {{run.prUrl}}')] },
      { id: 'resolve-item', name: 'Resolve item', description: 'Resolve the item, so it reactivates if the fix did not hold.', inputs: PORTS.anyIn },
    ],
  }),
  defineConnector({
    id: 'datadog',
    name: 'Datadog',
    category: 'observability',
    description: 'Error Tracking and Test Optimization in Datadog. New error issues and newly flaky tests arrive as tasks.',
    auth: 'api-key',
    icon: { si: 'SiDatadog', color: '#632CA6' },
    docsUrl: 'https://docs.datadoghq.com/api/',
    tags: ['errors', 'flaky tests', 'apm'],
    uses: [
      'A new error in a service gets a fix PR with the trace attached.',
      'A test Datadog marks flaky gets a PR that makes it deterministic, not one that adds a retry.',
    ],
    triggers: [
      { id: 'error-tracking-issue', name: 'New error issue', description: 'Error Tracking opens a new issue for a service.', outputs: PORTS.issueOut, fields: [FIELDS.text('service', 'Service', 'api'), ENVIRONMENT], sample: crash('err_2231', 'NullPointerException in InvoiceRenderer', 'https://app.datadoghq.com/error-tracking/issue/2231', 'java.lang.NullPointerException: Cannot invoke "Money.getCurrency()" because "total" is null\n  at com.acme.billing.InvoiceRenderer.render(InvoiceRenderer.java:58)') },
      { id: 'flaky-test', name: 'New flaky test', description: 'Test Optimization flags a test as newly flaky on the default branch.', outputs: PORTS.issueOut, fields: [FIELDS.text('service', 'Test service', 'api')], sample: taskSample('flaky_91', 'Flaky: webhook client › retries a 503 twice, then gives up', 'https://app.datadoghq.com/ci/test-runs?query=flaky', 'Failed 7 of the last 120 runs on main with the same assertion (expected 3 attempts, got 4). Passes on retry. Suspected: real timers in a retry-with-backoff test.', { labels: ['flaky'] }) },
    ],
    actions: [],
  }),
  defineConnector({
    id: 'firebase',
    name: 'Firebase Crashlytics',
    category: 'observability',
    description: 'Mobile crashes in Crashlytics. A new or regressed crash arrives as a task with the symbolicated stack.',
    auth: 'api-key',
    icon: { si: 'SiFirebase', color: '#DD2C00' },
    docsUrl: 'https://firebase.google.com/docs/crashlytics',
    tags: ['crashes', 'ios', 'android', 'mobile'],
    uses: ['A new crash in the latest app version gets a fix PR before the next release train.'],
    triggers: [
      { id: 'crashlytics-new-issue', name: 'New crash', description: 'Crashlytics opens a new fatal issue.', outputs: PORTS.issueOut, fields: [FIELDS.text('app', 'App', 'com.acme.app'), MIN_USERS], sample: crash('crash-7a1', 'NSInvalidArgumentException in FeedViewController', 'https://console.firebase.google.com/project/acme/crashlytics/app/ios:com.acme.app/issues/7a1', "*** -[__NSArrayM insertObject:atIndex:]: object cannot be nil\n  0 FeedViewController.swift:112 FeedViewController.insert(_:)\n  1 FeedViewController.swift:88 FeedViewController.reload()") },
      { id: 'crashlytics-regressed', name: 'Crash regressed', description: 'A closed crash issue comes back in a new version.', outputs: PORTS.issueOut, fields: [FIELDS.text('app', 'App', 'com.acme.app')], sample: crash('crash-6f2', 'IllegalStateException in CheckoutFragment', 'https://console.firebase.google.com/project/acme/crashlytics/app/android:com.acme.app/issues/6f2', 'java.lang.IllegalStateException: Fragment not attached to a context.\n  at CheckoutFragment.onPaymentResult(CheckoutFragment.kt:141)', { regression: true }) },
    ],
    actions: [],
  }),

  /* ---------------------------------------------------------------- */
  /* Tests                                                             */
  /* ---------------------------------------------------------------- */
  defineConnector({
    id: 'cypress',
    name: 'Cypress Cloud',
    category: 'testing',
    description: 'End-to-end runs recorded in Cypress Cloud. A newly flaky test arrives as a task with its failure history.',
    auth: 'api-key',
    icon: { si: 'SiCypress', color: '#69D3A7' },
    docsUrl: 'https://docs.cypress.io/cloud/features/flaky-test-management',
    tags: ['e2e', 'flaky tests'],
    uses: ['A test that started flaking gets a PR that fixes the race, instead of a retry count that hides it.'],
    triggers: [{ id: 'flaky-detected', name: 'Flaky test detected', description: 'Cypress Cloud flags a test as flaky above a rate.', outputs: PORTS.issueOut, fields: [FIELDS.number('minFlakePct', 'Only above flake rate (%)', 5, 1, 100, 1)], sample: taskSample('cy_4410', 'Flaky: checkout › applies a coupon', 'https://cloud.cypress.io/projects/ab12cd/tests/4410', 'Flaky in 9% of the last 200 runs. Fails with "Timed out retrying after 4000ms: expected \'$42.00\' to equal \'$37.80\'": the total is read before the coupon request resolves.', { labels: ['flaky', 'e2e'] }) }],
    actions: [],
  }),

  /* ---------------------------------------------------------------- */
  /* Security                                                          */
  /* ---------------------------------------------------------------- */
  defineConnector({
    id: 'dependabot',
    name: 'Dependabot',
    category: 'security',
    description: 'Vulnerable dependencies on GitHub. For the alerts Dependabot cannot fix on its own: the patched version is a major upgrade and code has to change with it.',
    auth: 'app',
    icon: { si: 'SiDependabot', color: '#025E8C' },
    docsUrl: 'https://docs.github.com/code-security/dependabot',
    tags: ['vulnerabilities', 'dependencies', 'cve'],
    uses: ['An advisory that needs a breaking upgrade gets a PR that upgrades and fixes what the upgrade broke.'],
    triggers: [{ id: 'alert-created', name: 'Alert Dependabot can\'t fix', description: 'A Dependabot alert opens and no security update could be opened for it.', outputs: PORTS.issueOut, fields: [SEVERITY, FIELDS.bool('onlyWithoutUpdate', 'Only when Dependabot has no PR for it', true, 'Dependabot already opens simple version bumps. This keeps agents for the upgrades that need code changes.')], sample: finding('GHSA-9wv6-86v2-598j', 'path-to-regexp: ReDoS in route matching (needs 0.1.x → 8.x)', 'https://github.com/acme/api/security/dependabot/17', 'Advisory GHSA-9wv6-86v2-598j (high). path-to-regexp 0.1.7 is vulnerable; the first patched line is 8.0.0. Dependabot could not open an update: express 4 pins the old major.\n\nUpgrade to a patched version and change the call sites that break.') }],
    actions: [],
  }),
  defineConnector({
    id: 'codeql',
    name: 'GitHub code scanning',
    category: 'security',
    description: 'CodeQL and other code scanning alerts on GitHub. A new alert arrives as a task with the rule, the file and the data flow.',
    auth: 'app',
    icon: { lucide: 'FileSearch', color: '#2F6FED' },
    docsUrl: 'https://docs.github.com/code-security/code-scanning',
    tags: ['codeql', 'sast', 'xss', 'sql injection'],
    uses: ['A new high-severity alert gets a fix PR reviewed by the security team, reviewed by both agents at the thorough level first.'],
    triggers: [{ id: 'alert-created', name: 'Alert created', description: 'A code scanning alert opens on the default branch.', outputs: PORTS.issueOut, fields: [SEVERITY], sample: finding('code-scanning#212', 'Reflected cross-site scripting in the search handler', 'https://github.com/acme/api/security/code-scanning/212', 'Rule js/reflected-xss (high). User input from req.query.q flows to res.send() in src/routes/search.ts:31 without escaping.\n\nFix the flow; do not suppress the alert.') }],
    actions: [],
  }),
  defineConnector({
    id: 'snyk',
    name: 'Snyk',
    category: 'security',
    description: 'Vulnerabilities found by Snyk in dependencies and code. A new issue arrives as a task with the path and the fixed version.',
    auth: 'token',
    icon: { si: 'SiSnyk', color: '#4C4A73' },
    docsUrl: 'https://docs.snyk.io/snyk-api',
    tags: ['vulnerabilities', 'sca', 'sast'],
    uses: ['A new high-severity vulnerability gets a PR that upgrades and fixes the breakage, for the cases Snyk\'s own fix PR can\'t cover.'],
    triggers: [{ id: 'new-vulnerability', name: 'New vulnerability', description: 'A new issue is found in a monitored project.', outputs: PORTS.issueOut, fields: [SEVERITY], sample: finding('SNYK-JS-AXIOS-6032459', 'Server-side request forgery in axios', 'https://app.snyk.io/org/acme/project/1b2/issue/SNYK-JS-AXIOS-6032459', 'axios 0.27.2 (via @acme/http-client) is vulnerable; fixed in 1.6.0, a major upgrade. Interceptors in src/http/client.ts use the 0.x config shape.') }],
    actions: [],
  }),
  defineConnector({
    id: 'semgrep',
    name: 'Semgrep',
    category: 'security',
    description: 'Findings from Semgrep scans. A new finding arrives as a task with the rule and the lines it matched.',
    auth: 'token',
    icon: { lucide: 'ScanSearch', color: '#00A67D' },
    docsUrl: 'https://semgrep.dev/docs/',
    tags: ['sast', 'rules'],
    uses: ['A blocking finding on main gets a fix PR, and the finding is marked fixed with the PR attached.'],
    triggers: [{ id: 'finding-created', name: 'New finding', description: 'A new finding appears on the default branch.', outputs: PORTS.issueOut, fields: [SEVERITY], sample: finding('finding-5510', 'SQL built from user input in orders.py', 'https://semgrep.dev/orgs/acme/findings/5510', 'Rule python.django.security.injection.sql (high). app/orders.py:88 formats request.GET["sort"] into a raw query. Use a parameterised query or an allowlist of columns.') }],
    actions: [{ id: 'triage-finding', name: 'Mark fixed', description: 'Mark the finding fixed with a note pointing at the PR.', inputs: PORTS.anyIn, fields: [FIELDS.template('note', 'Note', 'Fixed in {{run.prUrl}}')] }],
  }),

  /* ---------------------------------------------------------------- */
  /* Feature flags                                                     */
  /* ---------------------------------------------------------------- */
  defineConnector({
    id: 'launchdarkly',
    name: 'LaunchDarkly',
    category: 'feature-flags',
    description: 'Flags that finished rolling out. A flag serving one variation to everyone arrives as a task to delete it from the code.',
    auth: 'api-key',
    icon: { lucide: 'ToggleRight', color: '#405BFF' },
    docsUrl: 'https://docs.launchdarkly.com/home/flags/flag-status',
    tags: ['flags', 'cleanup', 'tech debt'],
    uses: ['A flag that has served "on" to everyone for 30 days gets a PR that deletes it and the dead branch.'],
    triggers: [{ id: 'flag-stale', name: 'Flag ready for removal', description: 'A flag has served a single variation to all traffic for a number of days.', outputs: PORTS.issueOut, fields: [FIELDS.text('environment', 'Environment', 'production'), FIELDS.number('days', 'Serving one variation for (days)', 30, 7, 365, 1)], sample: taskSample('new-checkout', 'Remove the feature flag new-checkout', 'https://app.launchdarkly.com/default/production/features/new-checkout', 'new-checkout has served true to 100% of production for 34 days.\n\nDelete the flag checks and keep the true path. Remove the false path, its tests and any code only it used. Leave the flag in LaunchDarkly: it is archived once this ships.', { flagKey: 'new-checkout', labels: ['flag-cleanup'] }) }],
    actions: [{ id: 'archive-flag', name: 'Archive flag', description: 'Archive the flag. Do it after the removal PR has shipped, e.g. from a merged-PR trigger.', inputs: PORTS.anyIn, fields: [FIELDS.template('flag', 'Flag key', '{{issue.flagKey}}')] }],
  }),
  defineConnector({
    id: 'statsig',
    name: 'Statsig',
    category: 'feature-flags',
    description: 'Gates and experiments in Statsig. A finished gate or a decided experiment arrives as a task to remove the losing path.',
    auth: 'api-key',
    icon: { lucide: 'Flag', color: '#194BFF' },
    docsUrl: 'https://docs.statsig.com/console-api/introduction',
    tags: ['flags', 'experiments', 'cleanup'],
    uses: ['An experiment that shipped its winner gets a PR that deletes the losing variant.'],
    triggers: [
      { id: 'gate-stale', name: 'Gate ready for cleanup', description: 'Statsig marks a gate stale: it passes everyone, or no one, and has for a while.', outputs: PORTS.issueOut, sample: taskSample('gate_inbox_v2', 'Remove the gate inbox_v2', 'https://console.statsig.com/acme/gates/inbox_v2', 'inbox_v2 has passed 100% of users for 41 days. Delete the gate checks, keep the passing path and remove the other.', { flagKey: 'inbox_v2', labels: ['flag-cleanup'] }) },
      { id: 'experiment-decision', name: 'Experiment shipped', description: 'An experiment is decided and a winning group is shipped.', outputs: PORTS.issueOut, sample: taskSample('exp_onboarding_copy', 'Remove the losing variant of onboarding_copy', 'https://console.statsig.com/acme/experiments/onboarding_copy', 'Shipped: "short" won over "control". Delete the experiment lookup, keep the short copy and remove the control variant.', { flagKey: 'onboarding_copy', labels: ['flag-cleanup'] }) },
    ],
    actions: [],
  }),
];
