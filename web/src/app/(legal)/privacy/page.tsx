import type { Metadata } from 'next';
import Link from 'next/link';
import { DEFAULT_BRAND } from '@/lib/brand';
import { REPO_URL } from '@/lib/links';

export const metadata: Metadata = { title: 'Privacy' };

const UPDATED = 'September 24, 2026';

export default function PrivacyPage() {
  const name = DEFAULT_BRAND.name;
  return (
    <>
      <h1>Privacy</h1>
      <p>Last updated {UPDATED}. This is the plain version: what {name} keeps, why, and how to get rid of it.</p>

      <h2>Without an account</h2>
      <p>Everything you make as a guest — workflows, test runs, settings — stays in your browser’s local storage. It is not sent to us.</p>

      <h2>With an account</h2>
      <ul>
        <li>Your name and email address, and a scrypt hash of your password — never the password itself. If you sign in with GitHub, your GitHub account id and public profile name and picture.</li>
        <li>What you build in the studio: workflow definitions, the records of test runs and runs on your machine (phases, costs, summaries), settings, saved versions, and share links you create.</li>
        <li>Session records, with the IP address and browser that signed in, so you can see and end sessions from Settings, and so sign-in attempts can be rate limited.</li>
      </ul>

      <h2>What we never have</h2>
      <ul>
        <li>Your source code. Agents run on your machine or on your own CI runner; the studio only keeps the workflow and the run’s summary.</li>
        <li>Your Claude, ChatGPT or GitHub tokens for the coding agents. Those CLIs sign in on your machine, and the studio only asks them whether they are signed in.</li>
      </ul>

      <h2>Public share links</h2>
      <p>When you share a workflow, a copy of it becomes public at its link, with your name as the author. Settings that look like secrets, allowlisted logins and your repository name are removed from that copy first. Stop sharing at any time and the link stops working.</p>

      <h2>Who else is involved</h2>
      <p>The service is hosted on Vercel, its database is a managed Postgres provider, and account emails (password resets, confirmations) are sent through Resend. They process data only to run the service. We do not sell data, show ads, or use analytics trackers.</p>

      <h2>Keeping and deleting</h2>
      <p>
        We keep your data while your account exists. <Link href="/settings#data">Settings → Your data</Link> downloads all of it as one file; <Link href="/settings#account">Settings → Account</Link> deletes your account and everything in it immediately.
      </p>

      <h2>Age</h2>
      <p>You must be at least 13 to create an account.</p>

      <h2>Questions</h2>
      <p>
        Open an issue on <a href={REPO_URL}>GitHub</a>, or write to the maintainer listed there. If this policy changes in a way that matters, we will say so in the studio before it takes effect.
      </p>
    </>
  );
}
