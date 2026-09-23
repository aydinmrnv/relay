"use client";

import type { ReactNode } from "react";
import Marquee from "react-fast-marquee";
import { cn } from "cn";

// shadcnblocks logos3, adapted: a logo may be a rendered icon rather than an image URL,
// so the marquee can show connector marks without a network request.
type LogosSimpleStaticLogo = Logo & {
  href?: string;
};
interface Logo {
  src?: string;
  alt: string;
  srcDark?: string;
  className?: string;
  icon?: ReactNode;
  label?: string;
}

interface LogosSimpleStaticProps {
  heading: string;
  logos: LogosSimpleStaticLogo[];
  className?: string;
}

type Props = Partial<LogosSimpleStaticProps>;

const defaultProps: LogosSimpleStaticProps = {
  heading: "Trusted by these companies",
  logos: [],
};

const Logos3 = (props: Props) => {
  const { heading, logos, className } = {
    ...defaultProps,
    ...props,
  };

  return (
    <section className={cn("py-32", className)}>
      <div className="container flex flex-col items-center text-center">
        <h2 className="text-2xl font-semibold tracking-tight">{heading}</h2>
      </div>
      <div className="mt-8 lg:mt-12">
        <Marquee gradient gradientWidth={64} autoFill pauseOnHover speed={50}>
          {logos.map((logo, index) => (
            <div
              key={`${logo.alt}-${index}`}
              className="mx-6 flex h-12 items-center justify-center gap-2 text-muted-foreground lg:mx-8"
              title={logo.alt}
            >
              {logo.icon !== undefined ? (
                <>
                  {logo.icon}
                  {logo.label !== undefined ? (
                    <span className="text-sm font-medium">{logo.label}</span>
                  ) : null}
                </>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logo.src} alt={logo.alt} className={cn("h-7 w-auto", logo.className)} />
              )}
            </div>
          ))}
        </Marquee>
      </div>
    </section>
  );
};

export { Logos3 };
