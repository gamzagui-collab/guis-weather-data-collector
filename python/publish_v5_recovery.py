#!/usr/bin/env python3
"""Publish only a verified missing v5 publication spec, then swap 144H latest last."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

BUCKET = "guis-weather-gfs-preview"

def digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()

def missing(error: ClientError) -> bool:
    return str(error.response.get("Error", {}).get("Code", "")) in {"404", "NoSuchKey", "NotFound"}

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--store", required=True)
    parser.add_argument("--plan", required=True)
    args = parser.parse_args()
    if not args.execute:
        raise RuntimeError("R2_V5_RECOVERY_EXECUTION_FLAG_REQUIRED")
    account = os.environ.get("R2_ACCOUNT_ID", "")
    access = os.environ.get("R2_ACCESS_KEY_ID", "")
    secret = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    if not account or not access or not secret or os.environ.get("R2_BUCKET") != BUCKET:
        raise RuntimeError("R2_V5_RECOVERY_ENVIRONMENT_INVALID")
    root = Path(args.store).resolve()
    plan = json.loads(Path(args.plan).resolve().read_text(encoding="utf-8"))
    if plan.get("status") == "ALREADY_COMPLETE":
        print(json.dumps({"status": "R2_V5_RECOVERY_ALREADY_COMPLETE", "runId": plan.get("runId")}))
        return
    if plan.get("schemaVersion") != "weather.gfs.v5-publication-recovery.v1" or plan.get("status") != "READY":
        raise RuntimeError("R2_V5_RECOVERY_PLAN_INVALID")
    client = boto3.client("s3", endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=access, aws_secret_access_key=secret, region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 2, "mode": "standard"}))

    def local_body(item: dict, default_path: str | None = None) -> bytes:
        path = root / Path(item.get("localPath") or default_path or item["key"])
        body = path.read_bytes()
        if len(body) != item.get("bytes") or digest(body) != item.get("sha256"):
            raise RuntimeError("R2_V5_RECOVERY_LOCAL_OBJECT_INTEGRITY_FAILED")
        return body

    publication = plan["publication"]
    latest = plan["latest"]
    publication_body = local_body(publication)
    latest_body = local_body(latest)
    expected_sha = plan.get("expectedLatest", {}).get("sha256")
    run_id = plan.get("runId")

    current_body = client.get_object(Bucket=BUCKET, Key=latest["key"])["Body"].read()
    current_sha = digest(current_body)
    current = json.loads(current_body)
    if current_sha == latest["sha256"]:
        existing = client.get_object(Bucket=BUCKET, Key=publication["key"])["Body"].read()
        if len(existing) != len(publication_body) or digest(existing) != publication["sha256"]:
            raise RuntimeError("R2_V5_RECOVERY_IDEMPOTENT_PUBLICATION_MISMATCH")
        print(json.dumps({"status": "R2_V5_RECOVERY_ALREADY_PUBLISHED", "runId": run_id,
            "latestSha256": current_sha, "publicationSha256": publication["sha256"]}, separators=(",", ":")))
        return
    if current.get("runId") != run_id:
        raise RuntimeError("R2_V5_RECOVERY_LATEST_REGRESSION_BLOCKED")
    if current_sha != expected_sha:
        raise RuntimeError("R2_V5_RECOVERY_LATEST_RACE")

    publication_state = "UPLOADED"
    try:
        response = client.get_object(Bucket=BUCKET, Key=publication["key"])
        existing = response["Body"].read()
        if len(existing) != len(publication_body) or digest(existing) != publication["sha256"]:
            raise RuntimeError("R2_V5_RECOVERY_IMMUTABLE_PUBLICATION_CONFLICT")
        publication_state = "REUSED"
    except ClientError as error:
        if not missing(error):
            raise
        client.put_object(Bucket=BUCKET, Key=publication["key"], Body=publication_body,
            ContentType="application/json", Metadata={"sha256": publication["sha256"]})
    remote_publication = client.get_object(Bucket=BUCKET, Key=publication["key"])["Body"].read()
    if len(remote_publication) != len(publication_body) or digest(remote_publication) != publication["sha256"]:
        raise RuntimeError("R2_V5_RECOVERY_REMOTE_PUBLICATION_INTEGRITY_FAILED")

    before_swap = client.get_object(Bucket=BUCKET, Key=latest["key"])["Body"].read()
    if digest(before_swap) != expected_sha:
        raise RuntimeError("R2_V5_RECOVERY_LATEST_RACE")
    client.put_object(Bucket=BUCKET, Key=latest["key"], Body=latest_body,
        ContentType="application/json", Metadata={"sha256": latest["sha256"]})
    remote_latest = client.get_object(Bucket=BUCKET, Key=latest["key"])["Body"].read()
    if len(remote_latest) != len(latest_body) or digest(remote_latest) != latest["sha256"]:
        raise RuntimeError("R2_V5_RECOVERY_REMOTE_LATEST_INTEGRITY_FAILED")
    print(json.dumps({"status": "R2_V5_PUBLICATION_RECOVERED", "runId": run_id,
        "publicationState": publication_state, "publicationSha256": publication["sha256"],
        "previousLatestSha256": expected_sha, "latestSha256": latest["sha256"]}, separators=(",", ":")))

if __name__ == "__main__":
    main()
