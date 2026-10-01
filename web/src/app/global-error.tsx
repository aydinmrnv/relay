'use client';

/**
 * The last resort: the root layout itself threw, so there are no providers,
 * no stylesheet and no theme. It brings its own document and its own few
 * styles, and follows the system's light or dark setting.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <title>Relay hit an error</title>
        <style>{`
          .ge { min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 2rem; font-family: ui-sans-serif, system-ui, sans-serif; background: #faf9f7; color: #1a1815; }
          .ge div { max-width: 28rem; text-align: center; }
          .ge h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
          .ge p { font-size: .9rem; line-height: 1.5; margin: 0 0 1rem; opacity: .75; }
          .ge button, .ge a { font: inherit; font-size: .875rem; padding: .5rem .9rem; border-radius: .5rem; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; text-decoration: none; margin: 0 .25rem; }
          @media (prefers-color-scheme: dark) { .ge { background: #11100e; color: #f5f4f1; } }
        `}</style>
        <main className="ge">
          <div role="alert">
            <h1>Relay hit an error</h1>
            <p>Something went wrong before the page could be drawn. Your saved work is not affected.{error.digest === undefined ? '' : ` Reference: ${error.digest}.`}</p>
            <button type="button" onClick={() => retry()}>
              Try again
            </button>
            {/* A plain link on purpose: the router went down with the layout, and a full page load is the way back. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/">Back to the site</a>
          </div>
        </main>
      </body>
    </html>
  );
}
