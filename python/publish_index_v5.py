#!/usr/bin/env python3
"""Publish one fixed immutable v5 compact index to Preview R2 without NOAA or deletes."""
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
SOFT_STOP_BYTES = 8 * 1024 * 1024 * 1024

def digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()

def missing(error: ClientError) -> bool:
    return str(error.response.get("Error", {}).get("Code", "")) in {"404", "NoSuchKey", "NotFound"}

def checked(value: dict, code: str) -> dict:
    if (not isinstance(value, dict) or not str(value.get("key", "")).startswith(PREFIX)
            or not isinstance(value.get("bytes"), int) or value["bytes"] < 1
            or len(str(value.get("sha256", ""))) != 64):
        raise RuntimeError(code)
    return value

def bucket_bytes(client) -> int:
    total = 0
    token = None
    while True:
        args = {"Bucket": BUCKET, "MaxKeys": 1000}
        if token:
            args["ContinuationToken"] = token
        page = client.list_objects_v2(**args)
        total += sum(int(item.get("Size", 0)) for item in page.get("Contents", []))
        if not page.get("IsTruncated"):
            return total
        token = page.get("NextContinuationToken")

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--index-store", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if not args.execute or not args.run_id.endswith("Z") or len(args.run_id) != 16:
        raise RuntimeError("R2_V5_REMOTE_EXECUTION_ARGUMENT_INVALID")
    account = os.environ.get("R2_ACCOUNT_ID", "")
    access = os.environ.get("R2_ACCESS_KEY_ID", "")
    secret = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    bucket = os.environ.get("R2_BUCKET", "")
    if not account or not access or not secret or bucket != BUCKET:
        raise RuntimeError("R2_V5_ENVIRONMENT_INVALID")
    root = Path(args.index_store).resolve()
    plan = json.loads((root / "publish-v5.json").read_text(encoding="utf-8"))
    if (plan.get("schemaVersion") != "weather.gfs.compact-index-publish-plan.v5"
            or plan.get("status") != "COMPLETE" or plan.get("runId") != args.run_id):
        raise RuntimeError("R2_V5_PUBLISH_PLAN_INVALID")
    manifest = checked(plan.get("manifest"), "R2_V5_MANIFEST_DESCRIPTOR_INVALID")
    expected: dict[str, dict] = {}
    for raw in plan.get("objects", []):
        item = checked(raw, "R2_V5_OBJECT_DESCRIPTOR_INVALID")
        if item["key"] in expected or not item["key"].startswith(
                f"horizons/144h/runs/{args.run_id}/indexes/v5/"):
            raise RuntimeError("R2_V5_OBJECT_KEY_INVALID")
        path = root / Path(item["key"])
        body = path.read_bytes()
        if len(body) != item["bytes"] or digest(body) != item["sha256"]:
            raise RuntimeError("R2_V5_LOCAL_OBJECT_INTEGRITY_FAILED")
        metadata = item.get("customMetadata") or {"sha256": item["sha256"]}
        if metadata.get("sha256") != item["sha256"] or any(not isinstance(k, str) or not isinstance(v, str)
                for k, v in metadata.items()):
            raise RuntimeError("R2_V5_LOCAL_METADATA_INVALID")
        expected[item["key"]] = {**item, "metadata": metadata, "path": path}
    if manifest["key"] not in expected or len(expected) != 968:
        raise RuntimeError("R2_V5_OBJECT_SET_INVALID")
    client = boto3.client("s3", endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=access, aws_secret_access_key=secret, region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 2, "mode": "standard"}))
    remote_latest = json.loads(client.get_object(Bucket=BUCKET, Key="horizons/144h/latest.json")["Body"].read())
    if remote_latest.get("runId") != args.run_id or remote_latest.get("manifest") != plan.get("sourceManifest"):
        raise RuntimeError("R2_V5_REMOTE_FIXED_RUN_MISMATCH")
    current_bytes = bucket_bytes(client)
    new_bytes = sum(item["bytes"] for item in expected.values())
    if current_bytes + new_bytes >= SOFT_STOP_BYTES:
        raise RuntimeError("R2_V5_STORAGE_SOFT_STOP")

    def publish(entry: tuple[str, dict]) -> tuple[str, str, int]:
        key, item = entry
        body = item["path"].read_bytes()
        state = "UPLOADED"
        try:
            head = client.head_object(Bucket=BUCKET, Key=key)
            metadata = head.get("Metadata", {})
            if int(head.get("ContentLength", -1)) != len(body) or metadata != item["metadata"]:
                raise RuntimeError("R2_V5_IMMUTABLE_OBJECT_CONFLICT")
            state = "REUSED"
        except ClientError as error:
            if not missing(error):
                raise
            client.put_object(Bucket=BUCKET, Key=key, Body=body,
                ContentType=item.get("contentType", "application/octet-stream"), Metadata=item["metadata"])
        head = client.head_object(Bucket=BUCKET, Key=key)
        if int(head.get("ContentLength", -1)) != len(body) or head.get("Metadata", {}) != item["metadata"]:
            raise RuntimeError("R2_V5_REMOTE_HEAD_INTEGRITY_FAILED")
        remote = client.get_object(Bucket=BUCKET, Key=key)["Body"].read()
        if len(remote) != len(body) or digest(remote) != item["sha256"]:
            raise RuntimeError("R2_V5_REMOTE_BODY_INTEGRITY_FAILED")
        return key, state, len(body)

    children = [(key, item) for key, item in expected.items() if key != manifest["key"]]
    results: list[tuple[str, str, int]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        results.extend(executor.map(publish, children))
    results.append(publish((manifest["key"], expected[manifest["key"]])))
    print(json.dumps({"status": "INDEX_V5_PUBLISHED", "runId": args.run_id,
        "objectCount": len(results), "uploadedCount": sum(1 for _, state, _ in results if state == "UPLOADED"),
        "reusedCount": sum(1 for _, state, _ in results if state == "REUSED"),
        "totalBytes": sum(size for _, _, size in results), "bucketBytesBefore": current_bytes,
        "projectedBucketBytes": current_bytes + new_bytes, "manifestSha256": manifest["sha256"]},
        separators=(",", ":")))

if __name__ == "__main__":
    main()
