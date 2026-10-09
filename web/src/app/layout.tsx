import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import { shadcn } from '@clerk/ui/themes';
import { BRAND } from '@/lib/brand';
import { Providers } from '@/components/providers';
import { authCapabilities, CLERK_CONFIGURED, PUBLIC_URL } from '@/server/env';
import './globals.css';

// globals.css maps `--font-sans` / `--font-mono` into the Tailwind theme.
const geistSans = Geist({ variable: '--font-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  // Absolute URLs for the social card, so share links preview properly.
  metadataBase: new URL(PUBLIC_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000')),
  // The home page says what the product is; every other page says what the page is.
  title: { default: `${BRAND.name} — Automations for your repo, on your GitHub Actions`, template: `%s · ${BRAND.name}` },
  description: BRAND.tagline,
  applicationName: BRAND.name,
  // No title here: each page's own title becomes its og:title, instead of every page unfurling as "Relay".
  // The image itself is app/opengraph-image.png, drawn by scripts/gen-brand.mjs, with its alt text beside it.
  openGraph: { description: BRAND.tagline, siteName: BRAND.name, type: 'website' },
  twitter: { card: 'summary_large_image' },
};

/** The browser's own chrome, in the page's background for either theme. */
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf9f7' },
    { media: '(prefers-color-scheme: dark)', color: '#11100e' },
  ],
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
            // The theme takes its input fill from `--input`, which here is the colour of a border: fields came out
            // solid grey and read as disabled. They are the page's own background, like every other field in the studio.
            appearance={{ theme: shadcn, variables: { colorInput: 'var(--background)', colorInputForeground: 'var(--foreground)' } }}
            signInUrl="/sign-in"
            signUpUrl="/sign-up"
            signInFallbackRedirectUrl="/dashboard"
            signUpFallbackRedirectUrl="/onboarding"
            afterSignOutUrl="/"
            // `/sign-in` also makes accounts (`withSignUp`), so it should not greet everyone with "Welcome back".
            localization={{ signIn: { start: { subtitleCombined: 'Sign in, or create a free account.' } } }}
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
