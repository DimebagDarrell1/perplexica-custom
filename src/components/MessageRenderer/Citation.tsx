import { safeLink } from '@/lib/web/safeLinks';

const Citation = ({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) => {
  const url = safeLink(href);
  if (!url)
    return (
      <span
        title={href?.startsWith('file_id://') ? 'Uploaded file' : undefined}
        className="px-1 text-xs"
      >
        [{children}]
      </span>
    );
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="bg-light-secondary dark:bg-dark-secondary px-1 rounded ml-1 no-underline text-xs text-black/70 dark:text-white/70 relative"
    >
      {children}
    </a>
  );
};

export default Citation;
