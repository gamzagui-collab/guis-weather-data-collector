#!/usr/bin/env python3
"""Publish a locally verified v3 point-window index to the Preview R2 bucket.

The script never calls NOAA and never deletes or overwrites an immutable object.
Credential values and signed URLs are intentionally absent from output.
"""

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
NAMESPACE = "horizons/144h/"


def sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def descriptor(value: dict, code: str) -> dict:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("key"), str)
        or not value["key"].startswith(NAMESPACE)
        or not isinstance(value.get("bytes"), int)
        or value["bytes"] < 1
        or not isinstance(value.get("sha256"), str)
        or len(value["sha256"]) != 64
    ):
        raise RuntimeError(code)
    return value


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def required_environment() -> tuple[str, str, str, str]:
    account = os.environ.get("R2_ACCOUNT_ID", "")
    access = os.environ.get("R2_ACCESS_KEY_ID", "")
    secret = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    bucket = os.environ.get("R2_BUCKET", "")
    if not account or not access or not secret or bucket != BUCKET:
        raise RuntimeError("R2_V3_ENVIRONMENT_INVALID")
    return account, access, secret, bucket


def client_for(account: str, access: str, secret: str):
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=access,
        aws_secret_access_key=secret,
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 2, "mode": "standard"}),
    )


def not_found(error: ClientError) -> bool:
    return str(error.response.get("Error", {}).get("Code", "")) in {"404", "NoSuchKey", "NotFound"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-store", required=True)
    parser.add_argument("--index-store", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if not args.execute:
        raise RuntimeError("R2_V3_REMOTE_EXECUTION_FLAG_REQUIRED")

    source_root = Path(args.source_store).resolve()
    index_root = Path(args.index_store).resolve()
    latest = read_json(source_root / "horizons/144h/latest.json")
    run_id = latest.get("runId", "")
    root_key = f"horizons/144h/runs/{run_id}/indexes/v3/manifest.json"
    root_path = index_root / Path(root_key)
    root = read_json(root_path)
    if (
        root.get("schemaVersion") != "weather.gfs.point-window-index-manifest.v3"
        or root.get("status") != "COMPLETE"
        or root.get("runId") != run_id
        or root.get("sourceManifest") != latest.get("manifest")
    ):
        raise RuntimeError("R2_V3_LOCAL_MANIFEST_INVALID")

    expected: dict[str, dict] = {}
    for window in root.get("windows", []):
        item = descriptor(window.get("contracts"), "R2_V3_CONTRACT_DESCRIPTOR_INVALID")
        expected[item["key"]] = item
    point_keys: set[str] = set()
    for spatial in root.get("spatialCatalogs", []):
        spatial_descriptor = descriptor(spatial, "R2_V3_SPATIAL_DESCRIPTOR_INVALID")
        expected[spatial_descriptor["key"]] = spatial_descriptor
        spatial_value = read_json(index_root / Path(spatial_descriptor["key"]))
        for point in spatial_value.get("points", []):
            point_descriptor = descriptor(point.get("timeline"), "R2_V3_POINT_DESCRIPTOR_INVALID")
            expected[point_descriptor["key"]] = point_descriptor
            point_keys.add(point_descriptor["key"])
    root_body = root_path.read_bytes()
    expected[root_key] = {"key": root_key, "bytes": len(root_body), "sha256": sha256(root_body)}
    if len(point_keys) != root.get("pointObjectCount") or len(expected) != root.get("objectCount") + 1:
        raise RuntimeError("R2_V3_LOCAL_OBJECT_SET_INVALID")
    for key, item in expected.items():
        body = (index_root / Path(key)).read_bytes()
        if len(body) != item["bytes"] or sha256(body) != item["sha256"]:
            raise RuntimeError("R2_V3_LOCAL_OBJECT_INTEGRITY_FAILED")

    account, access, secret, bucket = required_environment()
    client = client_for(account, access, secret)
    remote_latest = json.loads(client.get_object(Bucket=bucket, Key="horizons/144h/latest.json")["Body"].read())
    if remote_latest.get("runId") != run_id or remote_latest.get("manifest") != latest.get("manifest"):
        raise RuntimeError("R2_V3_REMOTE_LATEST_MISMATCH")

    def publish(item: tuple[str, dict]) -> tuple[str, str, int]:
        key, expected_item = item
        body = (index_root / Path(key)).read_bytes()
        state = "UPLOADED"
        try:
            head = client.head_object(Bucket=bucket, Key=key)
            exact = int(head.get("ContentLength", -1)) == len(body) and head.get("Metadata", {}).get("sha256") == expected_item["sha256"]
            if not exact:
                raise RuntimeError("R2_V3_IMMUTABLE_OBJECT_CONFLICT")
            state = "REUSED"
        except ClientError as error:
            if not not_found(error):
                raise
            client.put_object(Bucket=bucket, Key=key, Body=body, ContentType="application/json",
                              Metadata={"sha256": expected_item["sha256"]})
        head = client.head_object(Bucket=bucket, Key=key)
        if int(head.get("ContentLength", -1)) != len(body) or head.get("Metadata", {}).get("sha256") != expected_item["sha256"]:
            raise RuntimeError("R2_V3_REMOTE_HEAD_INTEGRITY_FAILED")
        remote = client.get_object(Bucket=bucket, Key=key)["Body"].read()
        if len(remote) != len(body) or sha256(remote) != expected_item["sha256"]:
            raise RuntimeError("R2_V3_REMOTE_BODY_INTEGRITY_FAILED")
        return key, state, len(body)

    children = [(key, item) for key, item in expected.items() if key != root_key]
    results: list[tuple[str, str, int]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        for result in executor.map(publish, children):
            results.append(result)
    results.append(publish((root_key, expected[root_key])))
    uploaded = sum(1 for _, state, _ in results if state == "UPLOADED")
    reused = sum(1 for _, state, _ in results if state == "REUSED")
    print(json.dumps({
        "status": "INDEX_V3_PUBLISHED",
        "runId": run_id,
        "objectCount": len(results),
        "uploadedCount": uploaded,
        "reusedCount": reused,
        "totalBytes": sum(size for _, _, size in results),
        "manifestSha256": expected[root_key]["sha256"],
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
