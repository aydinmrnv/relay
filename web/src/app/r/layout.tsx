import { ReplayFrame } from '@/components/replay/replay-frame';

/** Recordings are public pages: anyone can watch one, and nothing about them needs an account or a database. */
export default function RecordingsLayout({ children }: LayoutProps<'/r'>) {
  return <ReplayFrame>{children}</ReplayFrame>;
}
