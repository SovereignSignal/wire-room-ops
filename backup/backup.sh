#!/usr/bin/env bash
# One-shot Postgres backup for a Railway cron service. Exits 0 on success, non-zero on any failure.
#
# Required env:
#   BACKUP_DATABASE_URL   Postgres URL to dump. Use the PRIVATE host (*.railway.internal), e.g. a
#                         reference to the Postgres service's private URL in the same project.
#   BACKUP_TARGET         Storage target: an s3:// URI for the bucket + prefix,
#                         e.g. s3://wire-room-backups/  or  s3://wire-room-backups/grantswatch/
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY   Credentials for the target.
# Optional env:
#   BACKUP_S3_ENDPOINT    S3-compatible endpoint (R2: https://<account>.r2.cloudflarestorage.com).
#                         Omit for AWS S3.
#   AWS_DEFAULT_REGION    Defaults to "auto" (R2).
#   BACKUP_RETENTION_DAYS Prune backups older than this many days (default 30; 0 disables pruning).
#   BACKUP_DRY_RUN=1      Dump and report, but do not upload or prune.
set -euo pipefail

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required}"
: "${BACKUP_TARGET:?BACKUP_TARGET is required (s3://bucket/prefix/)}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"

case "$BACKUP_TARGET" in
  s3://*) ;;
  *) echo "backup: BACKUP_TARGET must be an s3:// URI" >&2; exit 2 ;;
esac
# Normalise to a trailing slash so the target is always a prefix.
TARGET="${BACKUP_TARGET%/}/"

AWS=(aws s3)
if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
  AWS+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
FILE="backup-${TIMESTAMP}.sql.gz"
OUT="$WORK/$FILE"

echo "backup: pg_dump $(pg_dump --version | awk '{print $NF}') -> ${TARGET}${FILE}"
if ! pg_dump "$BACKUP_DATABASE_URL" --no-owner --no-acl 2>"$WORK/pg_dump.err" | gzip >"$OUT"; then
  echo "backup: pg_dump failed; nothing uploaded" >&2
  cat "$WORK/pg_dump.err" >&2
  exit 1
fi
if grep -qiE 'error|fatal|aborting' "$WORK/pg_dump.err"; then
  echo "backup: pg_dump reported errors; nothing uploaded" >&2
  cat "$WORK/pg_dump.err" >&2
  exit 1
fi
[ -s "$WORK/pg_dump.err" ] && { echo "backup: pg_dump warnings:"; cat "$WORK/pg_dump.err"; }

# A gzip of an empty dump is ~20 bytes; a real dump has at least the SET preamble.
gzip -t "$OUT"
if [ "$(gzip -dc "$OUT" | head -c 4096 | wc -c)" -lt 100 ]; then
  echo "backup: dump is suspiciously small; nothing uploaded" >&2
  exit 1
fi
SIZE="$(du -h "$OUT" | cut -f1)"
echo "backup: created $FILE ($SIZE)"

if [ "${BACKUP_DRY_RUN:-0}" = "1" ]; then
  echo "backup: dry run, skipping upload and prune"
  exit 0
fi

"${AWS[@]}" cp "$OUT" "${TARGET}${FILE}" --only-show-errors
echo "backup: uploaded ${TARGET}${FILE}"

if [ "$RETENTION_DAYS" -gt 0 ] 2>/dev/null; then
  CUTOFF="$(date -u -d "@$(( $(date -u +%s) - RETENTION_DAYS * 86400 ))" +%Y%m%d)"
  PRUNED=0
  while read -r _ _ _ NAME; do
    # Only touch our own objects directly under the prefix; the bucket is shared.
    [[ "$NAME" =~ ^backup-([0-9]{8})-[0-9]{6}\.sql\.gz$ ]] || continue
    if [ "${BASH_REMATCH[1]}" -lt "$CUTOFF" ]; then
      "${AWS[@]}" rm "${TARGET}${NAME}" --only-show-errors
      echo "backup: pruned $NAME"
      PRUNED=$((PRUNED + 1))
    fi
  done < <("${AWS[@]}" ls "$TARGET")
  echo "backup: pruned $PRUNED backup(s) older than $RETENTION_DAYS days"
fi

TOTAL="$("${AWS[@]}" ls "$TARGET" | awk '$4 ~ /^backup-[0-9]{8}-[0-9]{6}\.sql\.gz$/ {n++} END {print n+0}')"
echo "backup: done; $TOTAL backup(s) at $TARGET"
