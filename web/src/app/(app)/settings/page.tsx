import type { Metadata } from 'next';
import { SettingsView } from '@/components/settings/settings-view';

export const metadata: Metadata = { title: 'Settings' };

/** Name, coding agents, how exports run, appearance and your data. Saved to your account, or in this browser for a guest. */
export default function SettingsPage() {
  return <SettingsView />;
}
