'use client';

import { Wind } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getApproxLocation } from '@/lib/actions';

const WeatherWidget = () => {
  const [data, setData] = useState({
    temperature: 0,
    condition: '',
    location: '',
    humidity: 0,
    windSpeed: 0,
    icon: '',
    temperatureUnit: 'C',
    windSpeedUnit: 'm/s',
  });

  const [loading, setLoading] = useState(true);

  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const updateWeather = async () => {
      if (pending) return;
      pending = true;
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15_000),
      ]);
      try {
        let location;
        const permission = navigator.permissions
          ? await navigator.permissions
              .query({ name: 'geolocation' })
              .catch(() => undefined)
          : undefined;
        if (navigator.geolocation && permission?.state === 'granted') {
          const position = await new Promise<GeolocationPosition>(
            (resolve, reject) => {
              navigator.geolocation.getCurrentPosition(resolve, reject, {
                timeout: 10_000,
                maximumAge: 300_000,
              });
            },
          );
          const response = await fetch(
            `https://api-bdc.io/data/reverse-geocode-client?latitude=${position.coords.latitude}&longitude=${position.coords.longitude}&localityLanguage=en`,
            { signal },
          );
          if (!response.ok) throw new Error('Location service unavailable');
          const place = await response.json();
          location = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            city: place.locality,
          };
        } else {
          location = await getApproxLocation(signal);
        }
        const response = await fetch('/api/weather', {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lat: location.latitude,
            lng: location.longitude,
            measureUnit: localStorage.getItem('measureUnit') ?? 'Metric',
          }),
        });
        if (!response.ok) throw new Error('Weather service unavailable');
        const weather = await response.json();
        if (!controller.signal.aborted) {
          setData({
            temperature: weather.temperature,
            condition: weather.condition,
            location: location.city,
            humidity: weather.humidity,
            windSpeed: weather.windSpeed,
            icon: weather.icon,
            temperatureUnit: weather.temperatureUnit,
            windSpeedUnit: weather.windSpeedUnit,
          });
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void updateWeather();
    const intervalId = setInterval(updateWeather, 30_000);
    return () => {
      controller.abort();
      clearInterval(intervalId);
    };
  }, [refresh]);

  return (
    <div className="bg-light-secondary dark:bg-dark-secondary rounded-2xl border border-light-200 dark:border-dark-200 shadow-sm shadow-light-200/10 dark:shadow-black/25 flex flex-row items-center w-full h-24 min-h-[96px] max-h-[96px] px-3 py-2 gap-3">
      {error ? (
        <div className="flex w-full items-center justify-between gap-3">
          <p role="status" className="text-sm text-black/70 dark:text-white/70">
            Weather unavailable.
          </p>
          <button
            type="button"
            aria-label="Retry weather"
            onClick={() => {
              setError(false);
              setLoading(true);
              setRefresh((value) => value + 1);
            }}
            className="min-h-11 px-3 text-sm text-black dark:text-white underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Retry
          </button>
        </div>
      ) : loading ? (
        <>
          <div className="flex flex-col items-center justify-center w-16 min-w-16 max-w-16 h-full animate-pulse">
            <div className="h-10 w-10 rounded-full bg-light-200 dark:bg-dark-200 mb-2" />
            <div className="h-4 w-10 rounded bg-light-200 dark:bg-dark-200" />
          </div>
          <div className="flex flex-col justify-between flex-1 h-full py-1 animate-pulse">
            <div className="flex flex-row items-center justify-between">
              <div className="h-3 w-20 rounded bg-light-200 dark:bg-dark-200" />
              <div className="h-3 w-12 rounded bg-light-200 dark:bg-dark-200" />
            </div>
            <div className="h-3 w-16 rounded bg-light-200 dark:bg-dark-200 mt-1" />
            <div className="flex flex-row justify-between w-full mt-auto pt-1 border-t border-light-200 dark:border-dark-200">
              <div className="h-3 w-16 rounded bg-light-200 dark:bg-dark-200" />
              <div className="h-3 w-8 rounded bg-light-200 dark:bg-dark-200" />
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col items-center justify-center w-16 min-w-16 max-w-16 h-full">
            <img
              src={`/weather-ico/${data.icon}.svg`}
              alt={data.condition}
              className="h-10 w-auto"
            />
            <span className="text-base font-semibold text-black dark:text-white">
              {data.temperature}°{data.temperatureUnit}
            </span>
          </div>
          <div className="flex flex-col justify-between flex-1 h-full py-2">
            <div className="flex flex-row items-center justify-between">
              <span className="text-sm font-semibold text-black dark:text-white">
                {data.location}
              </span>
              <span className="flex items-center text-xs text-black/60 dark:text-white/60 font-medium">
                <Wind className="w-3 h-3 mr-1" />
                {data.windSpeed} {data.windSpeedUnit}
              </span>
            </div>
            <span className="text-xs text-black/50 dark:text-white/50 italic">
              {data.condition}
            </span>
            <div className="flex flex-row justify-between w-full mt-auto pt-2 border-t border-light-200/50 dark:border-dark-200/50 text-xs text-black/50 dark:text-white/50 font-medium">
              <span>Humidity {data.humidity}%</span>
              <span className="font-semibold text-black/70 dark:text-white/70">
                Now
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default WeatherWidget;
