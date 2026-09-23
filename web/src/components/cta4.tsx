import { ArrowRight, Check } from "lucide-react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";

interface Button {
  text: string;
  url: string;
  icon?: React.ReactNode;
}
interface Buttons {
  primary?: Button;
  secondary?: Button;
}

interface CtaSimpleFeaturesProps {
  heading: string;
  description?: string;
  buttons?: Buttons;
  features: string[];
  className?: string;
}

type Cta4Props = CtaSimpleFeaturesProps;
type Props = Partial<Cta4Props>;

const defaultProps: Cta4Props = {
  heading: "Call to Action",
  description:
    "Get access to our collection of pre-built blocks and components today.",
  buttons: {
    primary: {
      text: "Get Started",
      url: "#",
    },
  },
  features: [
    "Easy Integration",
    "24/7 Support",
    "Customizable Design",
    "Scalable Performance",
    "Hundreds of Blocks",
  ],
};

const Cta4 = (props: Props) => {
  const { heading, description, buttons, features, className } = {
    ...defaultProps,
    ...props,
  };

  return (
    <section className={cn("py-32", className)}>
      <div className="container mx-auto">
        <div className="flex justify-center">
          <div className="max-w-5xl">
            <div className="flex flex-col items-start justify-between gap-8 rounded-lg bg-muted px-6 py-10 md:flex-row lg:px-20 lg:py-16">
              <div className="md:w-1/2">
                <h4 className="mb-1 text-2xl font-bold md:text-3xl">
                  {heading}
                </h4>
                <p className="text-muted-foreground">{description}</p>
                {buttons?.primary && (
                  <Button className="mt-6" render={<a href={buttons.primary.url} />} nativeButton={false}>{buttons.primary.text}<ArrowRight className="size-4" /></Button>
                )}
              </div>
              <div className="md:w-1/3">
                <ul className="flex flex-col space-y-2 text-sm font-medium">
                  {features.map((item, idx) => (
                    <li className="flex items-center" key={idx}>
                      <Check className="mr-4 size-4 shrink-0" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export { Cta4 };
