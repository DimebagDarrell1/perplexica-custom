/* eslint-disable @next/next/no-img-element */
import { ImageOff } from 'lucide-react';
import { useState } from 'react';

const MediaThumbnail = ({ src, title }: { src: string; title: string }) => {
  const [failed, setFailed] = useState(false);

  return (
    <span className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-light-secondary dark:bg-dark-secondary">
      {failed ? (
        <span className="flex flex-col items-center gap-1 px-2 text-black/70 dark:text-white/70">
          <ImageOff size={20} aria-hidden="true" />
          <span className="text-[11px]">Preview unavailable</span>
        </span>
      ) : (
        <img
          src={src}
          alt={title}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="aspect-video w-full object-cover"
        />
      )}
    </span>
  );
};

export default MediaThumbnail;
