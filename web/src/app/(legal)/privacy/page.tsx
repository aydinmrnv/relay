import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '@/lib/brand';
import { REPO_URL } from '@/lib/links';

export const metadata: Metadata = { title: 'Privacy' };

const UPDATED = 'September 24, 2026';

export default function PrivacyPage() {
  const name = BRAND.name;
  return (
    <>
      <h1>Privacy</h1>
      <p>Last updated {UPDATED}. This is the plain version: what {name} keeps, why, and how to get rid of it.</p>

      <h2>Without an account</h2>
      <p>
        Everything you make as a guest — workflows, test runs, settings — stays in your browser’s local storage. It is not sent to us. A real run on your own computer goes from your browser to relay connect on 127.0.0.1 and never reaches our servers either.
      </p>

      <h2>With an account</h2>
      <ul>
        <li>Your account itself — name, email address, password or the Google or GitHub sign-in you chose — is held by Clerk, our sign-in provider. The studio only keeps your Clerk user id.</li>
        <li>What you build in the studio: workflow definitions, the records of test runs and of runs on your runner (phases, costs, summaries), settings, saved versions, and share links you create.</li>
        <li>Clerk keeps session records, with the IP address and browser that signed in, so you can see and end sessions from Settings and so sign-in attempts can be protected against abuse.</li>
      </ul>

      <h2>What we never have</h2>
      <ul>
        <li>Your source code, in the studio. Agents work in a checkout on the runner you picked — your own computer, a Relay Cloud machine, or your own CI runner — and only the workflow and the run’s summary come back to us.</li>
        <li>Your Claude, ChatGPT or GitHub tokens for the coding agents. The CLIs sign in on the runner and keep the credentials in their own files there, and the studio only asks them whether they are signed in. Relay’s code has no route that reads a credential file.</li>
      </ul>

      <h2>If you use Relay Cloud</h2>
      <p>
        Relay Cloud is a Linux machine we run for you, one per person. Your sign-ins and a checkout of the repositories you name sit on that machine’s disk, on infrastructure we operate, and stay there between runs — remove the machine and the disk goes with it. Nobody else’s runs touch it: the hub routes a request only to the machine belonging to the signed-in person who made it, and a machine cannot be reached from the internet. Nothing is copied onto the studio’s database.
      </p>

      <h2>Public share links</h2>
      <p>When you share a workflow, a copy of it becomes public at its link, with your name as the author. Settings that look like secrets, allowlisted logins and your repository name are removed from that copy first. Stop sharing at any time and the link stops working.</p>

      <h2>Who else is involved</h2>
      <p>The service is hosted on Vercel, its database is a managed Postgres provider, and accounts, sign-in and account emails are handled by Clerk. They process data only to run the service. We do not sell data, show ads, or use analytics trackers.</p>

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
