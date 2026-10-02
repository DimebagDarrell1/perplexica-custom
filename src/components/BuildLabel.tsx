import { cn } from '@/lib/utils';

const BuildLabel = ({ compact = false }: { compact?: boolean }) => {
  const version = process.env.NEXT_PUBLIC_VERSION || 'development';
  const release = version.match(/-dorian\.(\d+)$/)?.[1];

  return (
    <span
      title={`Dorian's Perplexica, version ${version}`}
      aria-label={`Dorian's Perplexica, version ${version}`}
      className={cn(
        'text-accent dark:text-accent-dark',
        compact
          ? 'text-[10px] leading-4 text-center'
          : 'inline-flex rounded-md bg-accent/10 dark:bg-accent-dark/10 px-2.5 py-1.5 text-xs',
      )}
    >
      {compact ? `Custom ${release || 'dev'}` : `Custom build ${version}`}
    </span>
  );
};

export default BuildLabel;
