import { SiteFooter } from '@/components/marketing/closing';
import { SiteHeader } from '@/components/marketing/site-header';

export default function LegalLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />
      <main className="container flex-1 py-14">
        <article className="mx-auto flex max-w-2xl flex-col gap-5 text-[15px] leading-relaxed text-pretty [&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:tracking-tight [&_li]:ml-5 [&_li]:list-disc [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1.5 [&_a]:font-medium [&_a]:text-signal [&_a]:underline-offset-4 hover:[&_a]:underline [&_p]:text-muted-foreground [&_li]:text-muted-foreground">
          {children}
        </article>
      </main>
      <SiteFooter />
    </div>
  );
}
