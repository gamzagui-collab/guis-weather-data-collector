#!/usr/bin/env python3
"""Offline ecCodes decoder for official GFS surface APCP subsets.

Network access is deliberately absent. Exact duplicate GRIB messages are
removed; different accumulation contracts are preserved independently.
"""

import argparse
import hashlib
import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from eccodes import codes_get, codes_get_array, codes_get_message, codes_grib_new_from_file, codes_release


SOURCE_UNITS = {"kg m-2", "kg m**-2"}


def safe_get(handle, key, default=None):
    try:
        return codes_get(handle, key)
    except Exception:
        return default


def instant(date_value, time_value):
    value = str(int(date_value)).zfill(8) + str(int(time_value)).zfill(4)
    return datetime.strptime(value, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)


def iso(value):
    return value.isoformat().replace("+00:00", "Z")


def duration(hours):
    return f"PT{int(hours)}H" if float(hours).is_integer() else f"PT{hours}H"


def raw_number(value):
    return format(float(value), ".12g")


def decode_file(path):
    frames, duplicates, seen = [], [], {}
    file_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    with path.open("rb") as stream:
        index = 0
        while True:
            handle = codes_grib_new_from_file(stream)
            if handle is None:
                break
            index += 1
            try:
                message_hash = hashlib.sha256(codes_get_message(handle)).hexdigest()
                short_name = str(safe_get(handle, "shortName", ""))
                if short_name not in ("tp", "APCP") and not (
                    safe_get(handle, "parameterCategory") == 1 and safe_get(handle, "parameterNumber") == 8
                ):
                    continue
                if message_hash in seen:
                    duplicates.append({"messageIndex": index, "messageSha256": message_hash,
                                       "duplicateOfMessageIndex": seen[message_hash]})
                    continue
                seen[message_hash] = index
                source_unit = str(safe_get(handle, "units", ""))
                if source_unit not in SOURCE_UNITS:
                    raise RuntimeError("Unverified APCP source unit")
                if safe_get(handle, "stepUnits") not in (1, "h") or str(safe_get(handle, "stepType", "")) != "accum":
                    raise RuntimeError("Unsupported APCP time contract")
                start_step, end_step = float(safe_get(handle, "startStep")), float(safe_get(handle, "endStep"))
                if not math.isfinite(start_step) or not math.isfinite(end_step) or end_step <= start_step:
                    raise RuntimeError("Invalid APCP accumulation interval")
                run = instant(safe_get(handle, "dataDate"), safe_get(handle, "dataTime"))
                valid = instant(safe_get(handle, "validityDate"), safe_get(handle, "validityTime"))
                if valid != run + timedelta(hours=end_step):
                    raise RuntimeError("GRIB valid time mismatch")
                latitudes = list(codes_get_array(handle, "latitudes"))
                longitudes = list(codes_get_array(handle, "longitudes"))
                values = list(codes_get_array(handle, "values"))
                if not (len(latitudes) == len(longitudes) == len(values)):
                    raise RuntimeError("GRIB coordinate/value length mismatch")
                bitmap = int(safe_get(handle, "bitmapPresent", 0) or 0)
                missing_value = float(safe_get(handle, "missingValue", 9999.0))
                normalized, positive, zero, missing = [], 0, 0, 0
                minimum, maximum = None, None
                for point_id, source_value in enumerate(values):
                    value = float(source_value)
                    is_missing = not math.isfinite(value) or (bitmap and value == missing_value)
                    if is_missing:
                        normalized.append({"pointId": point_id, "rawValue": None,
                                           "quantitativeValue": None, "status": "MISSING"})
                        missing += 1
                        continue
                    if value < 0:
                        raise RuntimeError("Negative APCP rejected")
                    normalized.append({"pointId": point_id, "rawValue": raw_number(value),
                                       "quantitativeValue": value, "status": "AVAILABLE"})
                    positive += int(value > 0)
                    zero += int(value == 0)
                    minimum = value if minimum is None else min(minimum, value)
                    maximum = value if maximum is None else max(maximum, value)
                frames.append({
                    "messageIndex": index, "messageSha256": message_hash, "sourceDataSha256": file_hash,
                    "modelRunAt": iso(run), "validAt": iso(valid), "forecastHour": int(end_step),
                    "accumulationStart": iso(run + timedelta(hours=start_step)),
                    "accumulationEnd": iso(run + timedelta(hours=end_step)),
                    "accumulationPeriod": duration(end_step - start_step), "stepRange": str(safe_get(handle, "stepRange")),
                    "sourceUnit": source_unit, "unit": "mm",
                    "conversion": "1 kg m-2 liquid-water equivalent = 1 mm",
                    "packing": {key: safe_get(handle, key) for key in (
                        "packingType", "bitsPerValue", "binaryScaleFactor", "decimalScaleFactor",
                        "referenceValue", "bitmapPresent", "numberOfMissing")},
                    "grid": {"type": safe_get(handle, "gridType"), "Ni": int(safe_get(handle, "Ni")),
                             "Nj": int(safe_get(handle, "Nj")),
                             "resolutionDegrees": float(safe_get(handle, "iDirectionIncrementInDegrees")),
                             "points": [{"id": i, "latitude": float(latitudes[i]), "longitude": float(longitudes[i])}
                                        for i in range(len(values))]},
                    "values": normalized,
                    "statistics": {"availableCount": len(values) - missing, "missingCount": missing,
                                   "zeroCount": zero, "positiveCount": positive, "minimum": minimum, "maximum": maximum}
                })
            finally:
                codes_release(handle)
    if not frames:
        raise RuntimeError(f"No surface APCP in {path.name}")
    return frames, duplicates


def forecast_hour_from_path(path):
    match = re.search(r"-f(\d{3})\.grib2$", path.name)
    if not match:
        raise RuntimeError(f"Unrecognized forecast-hour filename: {path.name}")
    return int(match.group(1))


def build_dataset(paths, fetched_at, bounds, expected_forecast_hours=None):
    frames, duplicate_messages, grid, run = [], [], None, None
    for path in paths:
        decoded, duplicates = decode_file(path)
        duplicate_messages.extend({"file": path.name, **item} for item in duplicates)
        for frame in decoded:
            if run is None:
                run = frame["modelRunAt"]
            elif run != frame["modelRunAt"]:
                raise RuntimeError("Mixed GFS runs")
            candidate_grid = frame.pop("grid")
            if grid is None:
                grid = candidate_grid
            elif grid != candidate_grid:
                raise RuntimeError("Grid mismatch")
            frame["sourceFile"] = path.name
            frames.append(frame)
    frames.sort(key=lambda item: (item["forecastHour"], item["accumulationStart"], item["accumulationEnd"]))
    contracts = {(item["forecastHour"], item["accumulationStart"], item["accumulationEnd"]) for item in frames}
    if len(contracts) != len(frames):
        raise RuntimeError("Duplicate accumulation contract")
    units = {item["sourceUnit"] for item in frames}
    if len(units) != 1:
        raise RuntimeError("Mixed source units")
    source_file_hours = sorted({forecast_hour_from_path(path) for path in paths})
    actual_hours = sorted({item["forecastHour"] for item in frames})
    expected_hours = sorted(set(expected_forecast_hours or source_file_hours))
    if source_file_hours != expected_hours or actual_hours != expected_hours:
        raise RuntimeError("Incomplete forecast-hour coverage")
    coverage = {
        "kind": "FORECAST_HOUR_SET",
        "label": "48H" if expected_hours == list(range(1, 49)) else "CUSTOM",
        "startForecastHour": expected_hours[0],
        "endForecastHour": expected_hours[-1],
        "expectedForecastHours": expected_hours,
        "collectedForecastHours": actual_hours,
        "complete": True
    }
    return {
        "schemaVersion": "weather.gfs.grid.v1", "provider": "NOAA/NCEP", "model": "GFS", "broker": None,
        "source": "NOAA/NCEP NOMADS", "sourceUrl": "https://nomads.ncep.noaa.gov/",
        "product": "GFS 0.25 degree GRIB2 surface APCP", "variable": "precipitation",
        "modelRunAt": run, "publishedAt": None, "fetchedAt": fetched_at, "sourceUnit": next(iter(units)), "unit": "mm",
        "area": {"name": "Republic of Korea", "bounds": bounds}, "coverage": coverage,
        "grid": grid, "frames": frames,
        "duplicateMessagesRemoved": duplicate_messages, "missingForecastHours": [], "status": "AVAILABLE"
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--fetched-at", required=True)
    parser.add_argument("--bounds", nargs=4, type=float, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-forecast-hours", required=True)
    args = parser.parse_args()
    fetched = datetime.fromisoformat(args.fetched_at.replace("Z", "+00:00"))
    if fetched.tzinfo is None:
        raise RuntimeError("fetchedAt requires timezone")
    bounds = {"left": args.bounds[0], "right": args.bounds[1], "bottom": args.bounds[2], "top": args.bounds[3]}
    expected_hours = [int(item) for item in args.expected_forecast_hours.split(",") if item]
    if not expected_hours or len(expected_hours) != len(set(expected_hours)):
        raise RuntimeError("Invalid expected forecast hours")
    dataset = build_dataset(args.files, iso(fetched.astimezone(timezone.utc)), bounds, expected_hours)
    encoded = json.dumps(dataset, ensure_ascii=False, separators=(",", ":")) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(encoded, encoding="utf-8")
    print(json.dumps({"modelRunAt": dataset["modelRunAt"], "frames": len(dataset["frames"]),
                      "gridPoints": len(dataset["grid"]["points"]), "bytes": len(encoded.encode("utf-8"))}))


if __name__ == "__main__":
    main()
