'use client';

import { useEffect, useState } from 'react';
import { useChat } from '@/lib/hooks/useChat';
import { cn } from '@/lib/utils';

type JevStatus = { enabled: boolean; configured: boolean; provider: string };

const JevToggle = () => {
  const {
    useJev,
    setUseJev,
    optimizationMode,
    setOptimizationMode,
    fileIds,
    loading,
  } = useChat();
  const [status, setStatus] = useState<JevStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    let controller: AbortController;
    const refresh = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch('/api/jev', { signal: controller.signal });
        if (!response.ok) throw new Error('Status unavailable');
        const data = await response.json();
        if (active) {
          setStatus(data);
          setUnavailable(false);
        }
      } catch (error) {
        if (
          active &&
          !(error instanceof Error && error.name === 'AbortError')
        ) {
          setStatus(null);
          setUnavailable(true);
        }
      }
    };
    void refresh();
    window.addEventListener('server-config-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      controller?.abort();
      window.removeEventListener('server-config-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const ready = status?.enabled && status.configured;
  const speed = optimizationMode === 'speed';
  const files = fileIds.length > 0;
  const available = ready && !speed && !files;
  const selected = available && useJev;
  const hint = unavailable
    ? 'Could not check setup. Reload to retry.'
    : !status
      ? 'Checking setup...'
      : !ready
        ? 'Set up Jev in Settings > Search.'
        : files
          ? 'Jev stays off for uploaded files.'
          : speed
            ? 'Requires Balanced or Quality mode.'
            : 'Optional source ranking. Uses API credits.';

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-black/70 dark:text-white/70">
      <button
        type="button"
        aria-label="Use Jev source ranking"
        aria-pressed={selected}
        disabled={!available || loading}
        title={hint}
        onClick={() => setUseJev(!useJev)}
        className={cn(
          'min-h-11 shrink-0 rounded-lg px-3 text-xs transition disabled:cursor-not-allowed',
          selected
            ? 'bg-accent text-white'
            : 'bg-light-200 dark:bg-dark-200 text-black/80 dark:text-white/80',
        )}
      >
        Jev {selected ? 'on' : 'off'}
      </button>
      <span className="flex-1 min-w-[120px]">{hint}</span>
      {ready && speed && !files && (
        <button
          type="button"
          disabled={loading}
          onClick={() => setOptimizationMode('balanced')}
          className="min-h-11 underline underline-offset-4 text-accent dark:text-accent-dark"
        >
          Use Balanced
        </button>
      )}
    </div>
  );
};

export default JevToggle;
