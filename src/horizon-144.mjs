export const GFS_144H_NAMESPACE = "horizons/144h";
export const GFS_144H_INDEX_VERSION = "v2";
export const GFS_144H_TIME_WINDOW_HOURS = 24;

export const GFS_144H_FORECAST_HOURS = Object.freeze([
  ...Array.from({ length: 120 }, (_, index) => index + 1),
  ...Array.from({ length: 8 }, (_, index) => 123 + index * 3)
]);

export const GFS_144H_SOURCE_CADENCE = Object.freeze([
  Object.freeze({ startForecastHour: 1, endForecastHour: 120, intervalHours: 1 }),
  Object.freeze({ startForecastHour: 123, endForecastHour: 144, intervalHours: 3 })
]);

export function assertGfs144ForecastHours(hours) {
  if (JSON.stringify(hours) !== JSON.stringify(GFS_144H_FORECAST_HOURS)) {
    throw new Error("GFS_144H_FORECAST_HOURS_INVALID");
  }
  return hours;
}

export function gfs144WindowForForecastHour(forecastHour) {
  if (!GFS_144H_FORECAST_HOURS.includes(forecastHour)) throw new Error("GFS_144H_WINDOW_HOUR_INVALID");
  const startForecastHour = Math.floor((forecastHour - 1) / GFS_144H_TIME_WINDOW_HOURS) * GFS_144H_TIME_WINDOW_HOURS + 1;
  const endForecastHour = Math.min(144, startForecastHour + GFS_144H_TIME_WINDOW_HOURS - 1);
  return {
    id: `h${String(startForecastHour).padStart(3, "0")}-h${String(endForecastHour).padStart(3, "0")}`,
    startForecastHour,
    endForecastHour
  };
}

export function gfs144Windows() {
  return [1, 25, 49, 73, 97, 121].map((startForecastHour) => ({
    id: `h${String(startForecastHour).padStart(3, "0")}-h${String(Math.min(144, startForecastHour + 23)).padStart(3, "0")}`,
    startForecastHour,
    endForecastHour: Math.min(144, startForecastHour + 23),
    forecastHours: GFS_144H_FORECAST_HOURS.filter((hour) => hour >= startForecastHour && hour <= startForecastHour + 23)
  }));
}

export function gfs144ScopedKey(relative) {
  const value = String(relative || "");
  if (!value || value.startsWith("/") || value.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(value)) {
    throw new Error("GFS_144H_KEY_INVALID");
  }
  return `${GFS_144H_NAMESPACE}/${value}`;
}
