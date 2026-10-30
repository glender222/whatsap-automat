import React, { useState } from 'react';

interface AvatarCircleProps {
  src?: string | null;
  alt?: string;
  size?: number; // px
}

const DEFAULT_AVATAR = (
  <svg width="100%" height="100%" viewBox="0 0 40 40" fill="none">
    <circle cx="20" cy="20" r="20" fill="#f3f4f6"/>
    <circle cx="20" cy="15" r="7" fill="#cfd8dc"/>
    <ellipse cx="20" cy="29" rx="12" ry="7" fill="#cfd8dc"/>
  </svg>
);

const _failedAvatarSrcs = new Set<string>();

const AvatarCircle: React.FC<AvatarCircleProps> = ({ src, alt, size = 40 }) => {
  const [errored, setErrored] = useState(false);
  // Reset errored state and manage preloading when src changes so images can reattempt load
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  React.useEffect(() => {
    setErrored(false);
    setLoadedSrc(null);

    if (!src) return;

    let mounted = true;
    const img = new window.Image();
    // Optional: img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!mounted) return;
      setLoadedSrc(src);
    };
    img.onerror = () => {
      if (!mounted) return;
      // Avoid spamming the console for the same failing URL repeatedly.
      if (!src || _failedAvatarSrcs.has(src)) {
        setErrored(true);
        return;
      }
      _failedAvatarSrcs.add(src);
      // Use debug instead of warn so normal user consoles aren't noisy
      console.debug('Avatar image failed to preload:', src);
      setErrored(true);
    };
    // Kick off loading
    img.src = src;

    return () => {
      mounted = false;
      img.onload = null;
      img.onerror = null;
      // help GC
      try { img.src = ''; } catch (e) { /* ignore */ }
    };
  }, [src]);

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        overflow: "hidden",
        background: "#f3f4f6",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {loadedSrc && !errored
        ? (
          <img
            src={loadedSrc}
            alt={alt}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            onError={() => {
              if (!loadedSrc || _failedAvatarSrcs.has(loadedSrc)) {
                setErrored(true);
                return;
              }
              _failedAvatarSrcs.add(loadedSrc);
              console.debug('Avatar image failed to load at render time:', loadedSrc);
              setErrored(true);
            }}
          />
        )
        : DEFAULT_AVATAR
      }
    </div>
  );
};

export default AvatarCircle;