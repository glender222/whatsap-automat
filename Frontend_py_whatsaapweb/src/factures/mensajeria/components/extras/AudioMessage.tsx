import React, { useRef, useEffect, useState } from "react";

interface AudioMessageProps {
  url: string;
  unreadCount?: number;
}

const AudioMessage: React.FC<AudioMessageProps> = ({ url, unreadCount }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !url) return;

    const handleLoadedMetadata = () => {
      setDuration(audio.duration);
      setIsLoaded(true);
      setIsLoading(false);
    };

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };

    const handleCanPlay = () => {
      setIsLoaded(true);
      setIsLoading(false);
    };

    const handleLoadStart = () => {
      setIsLoading(true);
    };

    const handleError = () => {
      setError(true);
      setIsLoading(false);
      setIsLoaded(false);
      console.error('Error cargando audio:', url);
    };

    audio.addEventListener('loadstart', handleLoadStart);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('canplay', handleCanPlay);
    audio.addEventListener('error', handleError);

    return () => {
      audio.removeEventListener('loadstart', handleLoadStart);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('canplay', handleCanPlay);
      audio.removeEventListener('error', handleError);
    };
  }, [url]);

  const formatTime = (seconds: number) => {
    if (!seconds || !isFinite(seconds)) return "0:00";
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec.toString().padStart(2, "0")}`;
  };

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio || error) return;

    try {
      if (isPlaying) {
        audio.pause();
        setIsPlaying(false);
      } else {
        // Cargar el audio si aún no está cargado
        if (!isLoaded && !isLoading) {
          setIsLoading(true);
          audio.load();
        }
        await audio.play();
        setIsPlaying(true);
      }
    } catch (err) {
      console.error('Error playing audio:', err);
      setError(true);
    }
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const newTime = (clickX / rect.width) * duration;
    
    audio.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const progressPercentage = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      className="flex items-center bg-white rounded-xl shadow px-3 py-2 mb-2"
      style={{
        minWidth: 280,
        maxWidth: 340,
        border: "1px solid #eee",
        gap: 8,
      }}
    >
      {/* Audio element (hidden) - preload="metadata" para cargar duración sin descargar todo */}
      <audio ref={audioRef} src={url} preload="metadata" />

      {/* Play/Pause button */}
      <button
        onClick={togglePlay}
        disabled={error}
        style={{
          minWidth: 32,
          minHeight: 32,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "none",
          border: "none",
          marginRight: 8,
          cursor: error ? "not-allowed" : "pointer",
          opacity: error ? 0.3 : 1,
        }}
        aria-label={isPlaying ? "Pausar audio" : "Reproducir audio"}
      >
        {isLoading && !isLoaded ? (
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-500"></div>
        ) : isPlaying ? (
          <svg width="24" height="24" viewBox="0 0 20 20" fill="#888">
            <rect x="4" y="4" width="3" height="12" />
            <rect x="13" y="4" width="3" height="12" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 20 20" fill="#888">
            <polygon points="5,4 15,10 5,16" />
          </svg>
        )}
      </button>

      {/* Progress Bar Container */}
      <div
        style={{
          flex: 1,
          minWidth: 100,
          height: 20,
          marginRight: 8,
          cursor: isLoaded ? "pointer" : "default",
        }}
        onClick={handleProgressClick}
      >
        {/* Progress Bar Background */}
        <div
          style={{
            width: "100%",
            height: "4px",
            backgroundColor: "#e5e7eb",
            borderRadius: "2px",
            position: "relative",
            top: "50%",
            transform: "translateY(-50%)",
          }}
        >
          {/* Progress Bar Fill */}
          <div
            style={{
              width: `${progressPercentage}%`,
              height: "100%",
              backgroundColor: "#38bdf8",
              borderRadius: "2px",
              position: "relative",
            }}
          >
            {/* Progress Handle */}
            <div
              style={{
                position: "absolute",
                right: "-6px",
                top: "50%",
                transform: "translateY(-50%)",
                width: "12px",
                height: "12px",
                backgroundColor: "#38bdf8",
                borderRadius: "50%",
                boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
              }}
            />
          </div>
        </div>
      </div>

      {/* Current Time */}
      <span
        className="text-xs text-gray-700"
        style={{
          minWidth: 38,
          textAlign: "center",
          marginRight: 4,
        }}
      >
        {formatTime(currentTime)}
      </span>

      {/* Total Duration */}
      <span
        className="text-xs text-gray-500"
        style={{
          minWidth: 38,
          textAlign: "center",
          marginRight: 4,
        }}
      >
        {formatTime(duration)}
      </span>

      {/* Unread Count */}
      {typeof unreadCount === "number" && unreadCount > 0 && (
        <span
          className="bg-gray-300 px-3 py-1 rounded-full text-gray-700 text-xs min-w-[28px] text-center"
          style={{
            marginLeft: 4,
            fontWeight: "bold",
            background: "#e0e0e0",
            color: "#4a4a4a",
            minWidth: 28,
          }}
        >
          {unreadCount}
        </span>
      )}
    </div>
  );
};

export default AudioMessage;