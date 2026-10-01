import { AppFrame } from '@/components/app/app-frame';

export default function AppLayout({ children }: LayoutProps<'/'>) {
  return <AppFrame>{children}</AppFrame>;
}
