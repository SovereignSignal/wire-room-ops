# Railway cron backup service: pg_dump -> gzip -> S3-compatible storage (Cloudflare R2 today).
# pg_dump 18 can dump both wire-room-db (PG 17) and grants-dot-watch (PG 18).
FROM postgres:18-alpine
RUN apk add --no-cache aws-cli bash coreutils
COPY backup/backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
ENTRYPOINT []
CMD ["/usr/local/bin/backup.sh"]
