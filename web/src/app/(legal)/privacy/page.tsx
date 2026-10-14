import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '@/lib/brand';
import { OPERATOR, REPO_URL, SUPPORT_EMAIL } from '@/lib/links';

export const metadata: Metadata = {
  title: 'Privacy',
  description: `What ${BRAND.name} keeps, where, why, and how to get rid of it.`,
  alternates: { canonical: '/privacy' },
};

const UPDATED = 'October 6, 2026';

export default function PrivacyPage() {
  const name = BRAND.name;
  return (
    <>
      <h1>Privacy</h1>
      <p>
        Last updated {UPDATED}. This is the plain version: what {name} keeps, why, and how to get rid of it. {name} is run by {OPERATOR}; “we” below means {OPERATOR}. Write to{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> about anything here.
      </p>

      <h2>Before you sign in</h2>
      <p>
        The site, the guide and shared workflows can be read without an account, and reading them stores nothing about you on our servers beyond the request logs any web host keeps. The studio itself needs an account. Your
        browser remembers your choice of light or dark theme.
      </p>

      <h2>What we keep with your account</h2>
      <ul>
        <li>
          Your account itself — name, email address, password or the Google or GitHub sign-in you chose — is held by Clerk, our sign-in provider. In our own database you are a Clerk user id.
        </li>
        <li>What you build in the studio: workflow definitions and their saved versions, and your settings.</li>
        <li>
          The records of your runs: test runs, and runs on your own runner. A run’s record has its phases, costs and summary, and for a real run the progress lines the engine reported, which can include file names and
          branch names from your repository.
        </li>
        <li>
          Your projects and the answers you gave when setting one up: the repositories you named, where each runs, your choice of agents and review, and whether you said its files are installed. To find a repository you name,
          your browser asks GitHub’s public API about it directly, with no sign-in of yours; that request goes from your browser to GitHub, not through us, and a private repository simply cannot be seen.
        </li>
        <li>
          The credential of any app you connect: a Slack or Discord webhook, or the API key or token you paste for another app. It is encrypted before it is stored, never sent back to your browser, and deleted when you
          disconnect the app, clear your workspace or delete your account.
        </li>
        <li>Share links you create, each with a public copy of the workflow and the name shown as its author, which is your Clerk display name at the time.</li>
        <li>Counters of how often your account, or for public pages an IP address, has made certain requests, kept for a day, so that nobody can flood the service.</li>
        <li>Clerk keeps session records, with the IP address and browser that signed in, so you can see and end sessions from Settings and so sign-in attempts can be protected against abuse.</li>
      </ul>
      <p>Values typed into a node’s secret fields stay in the browser they were typed in: they are not saved to your account, not shared, and not written into an export.</p>

      <h2>What the studio never has</h2>
      <ul>
        <li>
          Your source code. The studio’s servers never receive it: agents work in a checkout on the runner you picked — your own computer, your own CI runner, or a Relay Cloud machine — and only the workflow and the
          run’s record come back.
        </li>
        <li>
          Your Claude, ChatGPT or GitHub credentials for the coding agents. The CLIs sign in on the runner and keep the credentials in their own files there; the studio only asks them whether they are signed in, and
          has no route that reads a credential file.
        </li>
      </ul>

      <h2>If you use Relay Cloud</h2>
      <p>
        Relay Cloud is a Linux machine we run for you, one per person, on Microsoft Azure. This is the exception to the section above: your coding agents’ sign-ins and a checkout of the repositories you name sit on that
        machine’s disk, on infrastructure we operate, and stay there between runs. Nobody else’s runs touch it, and it cannot be reached from the internet. Remove the machine from Settings and its disk, with everything
        on it, is deleted. Nothing from it is copied into the studio’s database.
      </p>

      <h2>Public share links</h2>
      <p>
        When you share a workflow, a copy of it becomes public at its link, with your name as the author. Before it is published, secret fields, links, email addresses, logins and your repository name are removed from
        its settings, its name, its description and its node labels; read the public page once to be sure nothing you would rather keep private is left in the wording. Stop sharing at any time and the link stops
        working. Shared pages count views and remixes; they are not listed in search engines.
      </p>

      <h2>Cookies and browser storage</h2>
      <ul>
        <li>Cookies: only Clerk’s, which keep you signed in. There are no advertising or analytics cookies.</li>
        <li>
          Local storage, in your own browser: a copy of your workspace so the studio opens quickly and works offline, changes waiting to be saved, your theme, and — if you paired your computer — the token relay
          connect gave this browser. Signing out clears all of it.
        </li>
      </ul>

      <h2>Who else is involved</h2>
      <ul>
        <li>Vercel hosts the service.</li>
        <li>The database is PostgreSQL, run for us by a managed database provider.</li>
        <li>Clerk handles accounts, sign-in and account emails.</li>
        <li>Microsoft Azure runs Relay Cloud machines, for the people who use Relay Cloud.</li>
        <li>An app you connect, such as Slack, Discord, Linear or Sentry: the webhook or token you paste is sent to that app, and to nobody else, to be checked. Test messages are posted through a webhook when you ask for one.</li>
      </ul>
      <p>They process data only to run the service. We do not sell data, show ads, or use analytics trackers.</p>

      <h2>Keeping and deleting</h2>
      <p>
        We keep your data while your account exists. <Link href="/settings#data">Settings → Your data</Link> downloads your workflows, runs and settings as one file. <Link href="/settings#account">Settings → Account</Link>{' '}
        deletes your account: your Relay Cloud machine, if you have one, is removed first, then everything in the studio’s database, then your sign-in at Clerk, all at once. If the machine cannot be removed you are
        told, and can write to us to have it removed. Workflows you exported to a repository are yours and stay there. Backups of the database are overwritten on the provider’s own schedule.
      </p>

      <h2>Age</h2>
      <p>You must be at least 13 to create an account.</p>

      <h2>Questions</h2>
      <p>
        Write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>, or open an issue on{' '}
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
        . If this policy changes in a way that matters, we will say so in the studio before it takes effect.
      </p>
    </>
  );
}
