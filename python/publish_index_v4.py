#!/usr/bin/env python3
"""Publish an immutable v4 range index to the Preview R2 bucket without NOAA or deletes."""
from __future__ import annotations
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

BUCKET = "guis-weather-gfs-preview"
PREFIX = "horizons/144h/"

def digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()

def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))

def checked(value: dict, code: str) -> dict:
    if (not isinstance(value, dict) or not str(value.get("key", "")).startswith(PREFIX)
            or not isinstance(value.get("bytes"), int) or value["bytes"] < 1
            or len(str(value.get("sha256", ""))) != 64):
        raise RuntimeError(code)
    return value

def missing(error: ClientError) -> bool:
    return str(error.response.get("Error", {}).get("Code", "")) in {"404", "NoSuchKey", "NotFound"}

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-store", required=True)
    parser.add_argument("--index-store", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if not args.execute:
        raise RuntimeError("R2_V4_REMOTE_EXECUTION_FLAG_REQUIRED")
    account = os.environ.get("R2_ACCOUNT_ID", "")
    access = os.environ.get("R2_ACCESS_KEY_ID", "")
    secret = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    bucket = os.environ.get("R2_BUCKET", "")
    if not account or not access or not secret or bucket != BUCKET:
        raise RuntimeError("R2_V4_ENVIRONMENT_INVALID")
    source_root = Path(args.source_store).resolve()
    index_root = Path(args.index_store).resolve()
    latest = read_json(source_root / "horizons/144h/latest.json")
    run_id = latest.get("runId", "")
    root_key = f"horizons/144h/runs/{run_id}/indexes/v4/manifest.json"
    root_path = index_root / Path(root_key)
    root = read_json(root_path)
    if (root.get("schemaVersion") != "weather.gfs.range-index-manifest.v4" or root.get("status") != "COMPLETE"
            or root.get("runId") != run_id or root.get("sourceManifest") != latest.get("manifest")):
        raise RuntimeError("R2_V4_LOCAL_MANIFEST_INVALID")
    expected: dict[str, dict] = {}
    blob_keys: set[str] = set()
    for spatial_item in root.get("spatialCatalogs", []):
        spatial = checked(spatial_item, "R2_V4_SPATIAL_DESCRIPTOR_INVALID")
        expected[spatial["key"]] = spatial
        value = read_json(index_root / Path(spatial["key"]))
        for point in value.get("points", []):
            blob = checked(point.get("blob"), "R2_V4_BLOB_DESCRIPTOR_INVALID")
            expected[blob["key"]] = blob
            blob_keys.add(blob["key"])
    root_body = root_path.read_bytes()
    expected[root_key] = {"key": root_key, "bytes": len(root_body), "sha256": digest(root_body)}
    if len(blob_keys) != root.get("pointBlobCount") or len(expected) != root.get("objectCount") + 1:
        raise RuntimeError("R2_V4_LOCAL_OBJECT_SET_INVALID")
    for key, item in expected.items():
        body = (index_root / Path(key)).read_bytes()
        if len(body) != item["bytes"] or digest(body) != item["sha256"]:
            raise RuntimeError("R2_V4_LOCAL_OBJECT_INTEGRITY_FAILED")
    client = boto3.client("s3", endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=access, aws_secret_access_key=secret, region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 2, "mode": "standard"}))
    remote_latest = json.loads(client.get_object(Bucket=bucket, Key="horizons/144h/latest.json")["Body"].read())
    if remote_latest.get("runId") != run_id or remote_latest.get("manifest") != latest.get("manifest"):
        raise RuntimeError("R2_V4_REMOTE_LATEST_MISMATCH")
    def publish(entry: tuple[str, dict]) -> tuple[str, str, int]:
        key, item = entry
        body = (index_root / Path(key)).read_bytes()
        state = "UPLOADED"
        try:
            head = client.head_object(Bucket=bucket, Key=key)
            if int(head.get("ContentLength", -1)) != len(body) or head.get("Metadata", {}).get("sha256") != item["sha256"]:
                raise RuntimeError("R2_V4_IMMUTABLE_OBJECT_CONFLICT")
            state = "REUSED"
        except ClientError as error:
            if not missing(error):
                raise
            client.put_object(Bucket=bucket, Key=key, Body=body,
                ContentType="application/x-ndjson" if key.endswith(".ndjson") else "application/json",
                Metadata={"sha256": item["sha256"]})
        head = client.head_object(Bucket=bucket, Key=key)
        if int(head.get("ContentLength", -1)) != len(body) or head.get("Metadata", {}).get("sha256") != item["sha256"]:
            raise RuntimeError("R2_V4_REMOTE_HEAD_INTEGRITY_FAILED")
        remote = client.get_object(Bucket=bucket, Key=key)["Body"].read()
        if len(remote) != len(body) or digest(remote) != item["sha256"]:
            raise RuntimeError("R2_V4_REMOTE_BODY_INTEGRITY_FAILED")
        return key, state, len(body)
    children = [(key, item) for key, item in expected.items() if key != root_key]
    results: list[tuple[str, str, int]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        results.extend(executor.map(publish, children))
    results.append(publish((root_key, expected[root_key])))
    print(json.dumps({"status": "INDEX_V4_PUBLISHED", "runId": run_id, "objectCount": len(results),
        "uploadedCount": sum(1 for _, state, _ in results if state == "UPLOADED"),
        "reusedCount": sum(1 for _, state, _ in results if state == "REUSED"),
        "totalBytes": sum(size for _, _, size in results), "manifestSha256": expected[root_key]["sha256"]},
        separators=(",", ":")))

if __name__ == "__main__":
    main()
