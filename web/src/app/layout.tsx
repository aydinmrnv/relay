import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import { shadcn } from '@clerk/ui/themes';
import { DEFAULT_BRAND } from '@/lib/brand';
import { Providers } from '@/components/providers';
import { authCapabilities, CLERK_CONFIGURED, PUBLIC_URL } from '@/server/env';
import './globals.css';

// globals.css maps `--font-sans` / `--font-mono` into the Tailwind theme.
const geistSans = Geist({ variable: '--font-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  // Absolute URLs for the social card, so share links preview properly.
  metadataBase: new URL(PUBLIC_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000')),
  title: { default: DEFAULT_BRAND.name, template: `%s · ${DEFAULT_BRAND.name}` },
  description: DEFAULT_BRAND.tagline,
  // The image itself is app/opengraph-image.png, drawn by scripts/gen-brand.mjs.
  openGraph: { title: DEFAULT_BRAND.name, description: DEFAULT_BRAND.tagline, siteName: DEFAULT_BRAND.name, type: 'website' },
  twitter: { card: 'summary_large_image' },
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  const studio = (
    <Providers capabilities={authCapabilities()} clerk={CLERK_CONFIGURED}>
      {children}
    </Providers>
  );
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground">
        {CLERK_CONFIGURED ? (
          <ClerkProvider
            appearance={{ theme: shadcn }}
            signInUrl="/sign-in"
            signUpUrl="/sign-up"
            signInFallbackRedirectUrl="/dashboard"
            signUpFallbackRedirectUrl="/onboarding"
            afterSignOutUrl="/"
          >
            {studio}
          </ClerkProvider>
        ) : (
          studio
        )}
      </body>
    </html>
  );
}
