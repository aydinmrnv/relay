import { Fragment } from 'react';

/**
 * The little markup the glossary uses, drawn rather than printed: `**bold**`,
 * backticks for something typed, and a blank line between paragraphs. The
 * glossary stays plain strings, so it can be read without React; this is the
 * one place those strings become elements.
 */
export function RichText({ text, className, inline: inSentence = false }: { text: string; className?: string; inline?: boolean }) {
  // Inside a sentence there are no paragraphs to make: a <p> inside a <p> is not HTML.
  if (inSentence) return <span className={className}>{inline(text)}</span>;
  const paragraphs = text.split(/\n\s*\n/);
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <p key={index} className={className}>
          {inline(paragraph)}
        </p>
      ))}
    </>
  );
}

function inline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={index} className="font-medium text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}
