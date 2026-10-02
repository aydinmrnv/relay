import { CheckIcon, CopyIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { toast } from 'sonner';

/** An animated copy button, in the theme's colours and at toolbar size. */
export function CopyConfirmButton({
  value,
  copyText = 'Copy',
  copiedText = 'Copied',
  onCopied,
  disabled = false,
  className = '',
}: {
  value: string;
  copyText?: string;
  copiedText?: string;
  onCopied?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // No permission, or a page that is not focused: say so rather than animate a copy that did not happen.
      toast.error('Could not copy', { description: 'The browser refused access to the clipboard. Select the text and copy it by hand.' });
      return;
    }
    setCopied(true);
    onCopied?.();
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <motion.button
      type="button"
      whileTap={disabled ? undefined : { scale: 0.97 }}
      onClick={() => void handleCopy()}
      disabled={disabled}
      aria-label={copied ? copiedText : copyText}
      className={`relative flex h-6 items-center justify-center gap-1.5 overflow-hidden rounded-full px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${copied ? 'bg-success text-white' : 'bg-foreground text-background hover:bg-foreground/85'} ${className}`}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={copied ? 'check' : 'copy'}
          initial={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
          transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </motion.span>
      </AnimatePresence>
      <AnimatedText from={copyText} to={copiedText} isCopied={copied} small />
    </motion.button>
  );
}

const AnimatedText = ({
  from,
  to,
  isCopied,
  small = false,
}: {
  from: string;
  to: string;
  isCopied: boolean;
  small?: boolean;
}) => {
  const activeText = isCopied ? to : from;

  return (
    <div className={`flex tracking-tight will-change-transform ${small ? 'text-xs' : 'text-lg'}`}>
      <AnimatePresence mode="popLayout" initial={false}>
        {activeText.split('').map((char, index) => {
          const displayChar = char === ' ' ? '\u00A0' : char;

          return (
            <motion.span
              key={char + index}
              layout
              initial={{ opacity: 0, y: 5, scale: 0.7 }}
              animate={{
                opacity: 1,
                y: 0,
                scale: 1,
                transition: {
                  type: 'spring',
                  stiffness: 200,
                  damping: 20,
                  delay: 0.03 * index,
                },
              }}
              exit={{ opacity: 0, y: -5, scale: 0.7 }}
            >
              {displayChar}
            </motion.span>
          );
        })}
      </AnimatePresence>
    </div>
  );
};
