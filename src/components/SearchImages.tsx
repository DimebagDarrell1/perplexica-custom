import { ImagesIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import Lightbox from 'yet-another-react-lightbox';
import 'yet-another-react-lightbox/styles.css';
import MediaThumbnail from './MediaThumbnail';

type Image = { url: string; img_src: string; title: string };

const SearchImages = ({
  query,
  chatHistory,
  messageId,
}: {
  query: string;
  chatHistory: [string, string][];
  messageId: string;
}) => {
  const [images, setImages] = useState<Image[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  const search = async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(45_000),
        body: JSON.stringify({
          query,
          chatHistory,
          chatModel: {
            providerId: localStorage.getItem('chatModelProviderId'),
            key: localStorage.getItem('chatModelKey'),
          },
        }),
      });
      if (!res.ok) throw new Error('Image search failed');
      const data = await res.json();
      if (!Array.isArray(data.images)) throw new Error('Invalid image results');
      setImages(
        data.images.filter(
          (image: Image) =>
            image &&
            typeof image.img_src === 'string' &&
            typeof image.title === 'string',
        ),
      );
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {!loading && (images === null || images.length === 0) && (
        <button
          id={`search-images-${messageId}`}
          type="button"
          onClick={search}
          className="border border-dashed border-light-300 dark:border-dark-300 hover:bg-light-200 dark:hover:bg-dark-200 transition px-4 py-3 flex items-center justify-between rounded-lg text-black/80 dark:text-white/80 text-sm w-full"
        >
          <span className="flex items-center gap-2">
            <ImagesIcon size={17} aria-hidden="true" />
            {error || images?.length === 0
              ? 'Retry image search'
              : 'Search images'}
          </span>
          <PlusIcon
            className="text-accent dark:text-accent-dark"
            size={17}
            aria-hidden="true"
          />
        </button>
      )}
      {error && (
        <p
          role="alert"
          className="mt-2 text-xs text-black/70 dark:text-white/70"
        >
          Image search did not finish. Try again.
        </p>
      )}
      {images?.length === 0 && (
        <p
          role="status"
          className="mt-2 text-xs text-black/70 dark:text-white/70"
        >
          No images found. Try another search.
        </p>
      )}
      {loading && (
        <div
          role="status"
          aria-label="Searching images"
          className="grid grid-cols-2 gap-2"
        >
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="bg-light-secondary dark:bg-dark-secondary w-full rounded-lg animate-pulse aspect-video"
            />
          ))}
        </div>
      )}
      {images !== null && images.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-2">
            {images.slice(0, images.length > 4 ? 3 : 4).map((image, i) => (
              <button
                type="button"
                aria-label={`Open image: ${image.title}`}
                title={image.title}
                onClick={() => {
                  setIndex(i);
                  setOpen(true);
                }}
                key={image.img_src + i}
                className="rounded-lg overflow-hidden hover:opacity-80 transition cursor-zoom-in"
              >
                <MediaThumbnail src={image.img_src} title={image.title} />
              </button>
            ))}
            {images.length > 4 && (
              <button
                type="button"
                onClick={() => {
                  setIndex(3);
                  setOpen(true);
                }}
                className="bg-light-secondary hover:bg-light-200 dark:bg-dark-secondary dark:hover:bg-dark-200 transition aspect-video w-full rounded-lg flex flex-col items-center justify-center gap-2 text-black/80 dark:text-white/80 p-2"
              >
                <ImagesIcon
                  size={20}
                  className="text-accent dark:text-accent-dark"
                  aria-hidden="true"
                />
                <span className="text-xs">View {images.length - 3} more</span>
              </button>
            )}
          </div>
          <Lightbox
            open={open}
            close={() => setOpen(false)}
            index={index}
            slides={images.map((image) => ({
              src: image.img_src,
              alt: image.title,
            }))}
          />
        </>
      )}
    </>
  );
};
export default SearchImages;
