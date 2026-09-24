import type { Metadata } from 'next';
import Link from 'next/link';
import { DEFAULT_BRAND } from '@/lib/brand';
import { REPO_URL } from '@/lib/links';

export const metadata: Metadata = { title: 'Terms' };

const UPDATED = 'September 24, 2026';

export default function TermsPage() {
  const name = DEFAULT_BRAND.name;
  return (
    <>
      <h1>Terms</h1>
      <p>Last updated {UPDATED}. Short, because the product is simple: you design workflows here; the agents do their work on computers you control.</p>

      <h2>The service</h2>
      <p>
        {name} is in beta and free. It may change, have outages, or lose features while it grows. Keep a copy of anything important — <Link href="/settings#data">Settings → Your data</Link> downloads everything — and export workflows you depend on to your repository, where they run without us.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>You must be at least 13, and give an email address you can receive mail at.</li>
        <li>Keep your password to yourself. You are responsible for what happens under your account.</li>
        <li>One person per account; create as many workflows as you need.</li>
      </ul>

      <h2>Your content</h2>
      <p>Workflows you make are yours. You give us permission to store and show them to you, and — only when you create a share link — to show that copy publicly and let others remix it. Remixes belong to whoever made them.</p>

      <h2>Acceptable use</h2>
      <ul>
        <li>No using {name} to attack, spam, or break into systems you do not own, or to break the terms of the coding agents and services you connect.</li>
        <li>No trying to get at other people’s accounts or data, or to overload the service.</li>
        <li>Shared workflows must not contain anything you do not have the right to share.</li>
      </ul>
      <p>We may suspend accounts that break these rules.</p>

      <h2>Agents and your code</h2>
      <p>Coding agents can be wrong. {name} makes them review each other and stops unattended runs at a draft pull request, but you decide what gets merged. Test runs in the studio are simulations, and spend forecasts are estimates, not quotes; what the agents cost is between you and their vendors.</p>

      <h2>No warranty</h2>
      <p>The service is provided as is, without warranties of any kind. To the extent the law allows, we are not liable for indirect or consequential losses, or for anything an agent does in your repository.</p>

      <h2>Open source</h2>
      <p>
        The {name} CLI and this studio are developed in the open on <a href={REPO_URL}>GitHub</a>, under the license in that repository.
      </p>

      <h2>Changes</h2>
      <p>If these terms change in a way that matters, we will say so in the studio first. Using {name} after that means you accept the new terms; deleting your account means you do not have to.</p>
    </>
  );
}
