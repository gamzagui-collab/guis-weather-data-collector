#!/usr/bin/env python3
"""Snapshot one fixed existing 144H Source+v5 publication from Preview R2 without writes."""
from __future__ import annotations
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import boto3
from botocore.config import Config

BUCKET = "guis-weather-gfs-preview"
LATEST_KEY = "horizons/144h/latest.json"

def digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--store", required=True)
    parser.add_argument("--inventory", required=True)
    args = parser.parse_args()
    if len(args.run_id) != 16 or not args.run_id.endswith("Z"):
        raise RuntimeError("R2_V5_RECOVERY_RUN_ID_INVALID")
    account = os.environ.get("R2_ACCOUNT_ID", "")
    access = os.environ.get("R2_ACCESS_KEY_ID", "")
    secret = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    if not account or not access or not secret or os.environ.get("R2_BUCKET") != BUCKET:
        raise RuntimeError("R2_V5_RECOVERY_ENVIRONMENT_INVALID")
    root = Path(args.store).resolve()
    root.mkdir(parents=True, exist_ok=True)
    client = boto3.client("s3", endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=access, aws_secret_access_key=secret, region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 2, "mode": "standard"}))

    def fetch(key: str) -> dict:
        response = client.get_object(Bucket=BUCKET, Key=key)
        body = response["Body"].read()
        target = root / Path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        metadata = {str(k): str(v) for k, v in (response.get("Metadata") or {}).items()}
        actual = digest(body)
        if metadata.get("sha256") and metadata["sha256"] != actual:
            raise RuntimeError("R2_V5_RECOVERY_REMOTE_METADATA_SHA_MISMATCH")
        return {"key": key, "bytes": len(body), "sha256": actual,
            "contentType": response.get("ContentType") or "application/octet-stream",
            "customMetadata": metadata}

    latest_descriptor = fetch(LATEST_KEY)
    latest = json.loads((root / LATEST_KEY).read_text(encoding="utf-8"))
    if latest.get("runId") != args.run_id:
        raise RuntimeError("R2_V5_RECOVERY_FIXED_RUN_MISMATCH")
    source_manifest_descriptor = latest.get("manifest") or {}
    source_manifest_actual = fetch(str(source_manifest_descriptor.get("key", "")))
    if any(source_manifest_actual.get(field) != source_manifest_descriptor.get(field)
           for field in ("key", "bytes", "sha256")):
        raise RuntimeError("R2_V5_RECOVERY_SOURCE_MANIFEST_MISMATCH")
    source_manifest = json.loads((root / source_manifest_actual["key"]).read_text(encoding="utf-8"))
    v2_key = f"horizons/144h/runs/{args.run_id}/indexes/v2/manifest.json"
    v5_key = f"horizons/144h/runs/{args.run_id}/indexes/v5/manifest.json"
    source_keys = [source_manifest["grid"]["key"], v2_key,
                   *[item["key"] for item in source_manifest["forecasts"]]]
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as executor:
        list(executor.map(fetch, source_keys))
    v5_manifest_descriptor = fetch(v5_key)
    v5_manifest = json.loads((root / v5_key).read_text(encoding="utf-8"))
    v5_keys = [*[window["catalog"]["key"] for window in v5_manifest["windows"]],
        *[f"horizons/144h/runs/{args.run_id}/indexes/v5/points/p{point_id:04d}.bin"
          for point_id in range(int(v5_manifest["grid"]["pointCount"]))]]
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as executor:
        v5_inventory = list(executor.map(fetch, v5_keys))
    v5_inventory.append(v5_manifest_descriptor)
    publication_key = ((latest.get("indexes") or {}).get("v5") or {}).get("publication", {}).get("key")
    if publication_key:
        fetch(str(publication_key))
    inventory_path = Path(args.inventory).resolve()
    inventory_path.parent.mkdir(parents=True, exist_ok=True)
    inventory_path.write_text(json.dumps(v5_inventory, separators=(",", ":")) + "\n", encoding="utf-8")
    result = {"status": "R2_V5_RECOVERY_SNAPSHOT_VERIFIED", "runId": args.run_id,
        "latestSha256": latest_descriptor["sha256"], "sourceObjectCount": len(source_keys) + 2,
        "v5ObjectCount": len(v5_inventory),
        "v5TotalBytes": sum(item["bytes"] for item in v5_inventory)}
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as stream:
            stream.write(f"latest_sha256={latest_descriptor['sha256']}\n")
            stream.write(f"run_id={args.run_id}\n")
    print(json.dumps(result, separators=(",", ":")))

if __name__ == "__main__":
    main()
