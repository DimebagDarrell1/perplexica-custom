import { PlayCircle, PlusIcon, VideoIcon } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import Lightbox, { GenericSlide, VideoSlide } from 'yet-another-react-lightbox';
import 'yet-another-react-lightbox/styles.css';
import MediaThumbnail from './MediaThumbnail';

type Video = {
  url: string;
  img_src: string;
  title: string;
  iframe_src: string;
};

declare module 'yet-another-react-lightbox' {
  export interface VideoSlide extends GenericSlide {
    type: 'video-slide';
    src: string;
    iframe_src: string;
    title: string;
  }
  interface SlideTypes {
    'video-slide': VideoSlide;
  }
}

const SearchVideos = ({
  query,
  chatHistory,
  messageId,
}: {
  query: string;
  chatHistory: [string, string][];
  messageId: string;
}) => {
  const [videos, setVideos] = useState<Video[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const videoRefs = useRef<(HTMLIFrameElement | null)[]>([]);
  const slides = useMemo<VideoSlide[]>(
    () =>
      (videos || []).map((video) => ({
        type: 'video-slide',
        iframe_src: video.iframe_src,
        src: video.img_src,
        title: video.title,
      })),
    [videos],
  );

  const search = async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/videos', {
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
      if (!res.ok) throw new Error('Video search failed');
      const data = await res.json();
      if (!Array.isArray(data.videos)) throw new Error('Invalid video results');
      setVideos(
        data.videos.filter(
          (video: Video) =>
            video &&
            typeof video.img_src === 'string' &&
            typeof video.iframe_src === 'string' &&
            typeof video.title === 'string',
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
      {!loading && (videos === null || videos.length === 0) && (
        <button
          id={`search-videos-${messageId}`}
          type="button"
          onClick={search}
          className="border border-dashed border-light-300 dark:border-dark-300 hover:bg-light-200 dark:hover:bg-dark-200 transition px-4 py-3 flex items-center justify-between rounded-lg text-black/80 dark:text-white/80 text-sm w-full"
        >
          <span className="flex items-center gap-2">
            <VideoIcon size={17} aria-hidden="true" />
            {error || videos?.length === 0
              ? 'Retry video search'
              : 'Search videos'}
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
          Video search did not finish. Try again.
        </p>
      )}
      {videos?.length === 0 && (
        <p
          role="status"
          className="mt-2 text-xs text-black/70 dark:text-white/70"
        >
          No videos found. Try another search.
        </p>
      )}
      {loading && (
        <div
          role="status"
          aria-label="Searching videos"
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
      {videos !== null && videos.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-2">
            {videos.slice(0, videos.length > 4 ? 3 : 4).map((video, i) => (
              <button
                type="button"
                aria-label={`Play video: ${video.title}`}
                title={video.title}
                onClick={() => {
                  setCurrentIndex(i);
                  setOpen(true);
                }}
                key={video.iframe_src + i}
                className="relative rounded-lg overflow-hidden hover:opacity-80 transition"
              >
                <MediaThumbnail src={video.img_src} title={video.title} />
                <span className="absolute bg-white/90 dark:bg-black/80 text-black/80 dark:text-white/80 p-1 top-1 right-1 rounded-md">
                  <PlayCircle size={18} aria-hidden="true" />
                </span>
              </button>
            ))}
            {videos.length > 4 && (
              <button
                type="button"
                onClick={() => {
                  setCurrentIndex(3);
                  setOpen(true);
                }}
                className="bg-light-secondary hover:bg-light-200 dark:bg-dark-secondary dark:hover:bg-dark-200 transition aspect-video w-full rounded-lg flex flex-col items-center justify-center gap-2 text-black/80 dark:text-white/80 p-2"
              >
                <VideoIcon
                  size={20}
                  className="text-accent dark:text-accent-dark"
                  aria-hidden="true"
                />
                <span className="text-xs">View {videos.length - 3} more</span>
              </button>
            )}
          </div>
          <Lightbox
            open={open}
            close={() => setOpen(false)}
            slides={slides}
            index={currentIndex}
            on={{
              view: ({ index }) => {
                const previousIframe = videoRefs.current[currentIndex];
                if (index !== currentIndex && previousIframe?.contentWindow) {
                  previousIframe.contentWindow.postMessage(
                    '{"event":"command","func":"pauseVideo","args":""}',
                    '*',
                  );
                }
                setCurrentIndex(index);
              },
            }}
            render={{
              slide: ({ slide }) => {
                if (slide.type !== 'video-slide') return null;
                const index = slides.indexOf(slide);
                return (
                  <div className="h-full w-full flex items-center justify-center">
                    <iframe
                      title={slide.title}
                      src={`${slide.iframe_src}${slide.iframe_src.includes('?') ? '&' : '?'}enablejsapi=1`}
                      ref={(el) => {
                        videoRefs.current[index] = el;
                      }}
                      className="aspect-video max-h-[95vh] w-[95vw] rounded-2xl md:w-[80vw]"
                      allowFullScreen
                      allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
                    />
                  </div>
                );
              },
            }}
          />
        </>
      )}
    </>
  );
};
export default SearchVideos;
