import { getPool } from './index';

/** Derived organization fields belong to linked queued/approved entries, not
 * profile sightings. Enforce this for every writer, including direct SQL.
 * Install only through the separate migration-owner command. */
export async function ensureOrgMetrics(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: [{ schema }] } = await client.query<{ schema: string }>('SELECT current_schema() AS schema');
    const searchPath = `pg_catalog, "${schema.replace(/"/g, '""')}", pg_temp`;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('LOCK TABLE scan_entries, org_profiles IN SHARE ROW EXCLUSIVE MODE');
    await client.query(`
      CREATE OR REPLACE FUNCTION wro_org_metric_values(org integer)
      RETURNS TABLE(entry_count integer, avg_quality_score numeric, tier text)
      LANGUAGE sql STABLE SET search_path = ${searchPath} AS $body$
        SELECT n, average, CASE
          WHEN n >= 5 AND average >= 60 THEN 'Tier 1 - Official'
          WHEN n >= 2 OR average >= 50 THEN 'Tier 2 - Secondary'
          ELSE 'Tier 3 - Monitor' END
        FROM (SELECT count(*)::integer n, round(avg(quality_score)::numeric, 1) average
          FROM scan_entries WHERE org_id = org AND status IN ('queued', 'approved')) s
      $body$;

      CREATE OR REPLACE FUNCTION wro_guard_org_metrics() RETURNS trigger
      LANGUAGE plpgsql SET search_path = ${searchPath} AS $body$
      BEGIN
        SELECT v.entry_count, v.avg_quality_score, v.tier
          INTO NEW.entry_count, NEW.avg_quality_score, NEW.tier
          FROM wro_org_metric_values(NEW.id) v;
        IF TG_OP = 'UPDATE' AND
          (NEW.entry_count, NEW.avg_quality_score, NEW.tier) IS DISTINCT FROM
          (OLD.entry_count, OLD.avg_quality_score, OLD.tier) THEN
          NEW.updated_at := now();
        END IF;
        RETURN NEW;
      END $body$;

      CREATE OR REPLACE FUNCTION wro_refresh_org_metrics(ids integer[] DEFAULT NULL)
      RETURNS integer LANGUAGE plpgsql SET search_path = ${searchPath} AS $body$
      DECLARE changed integer;
      BEGIN
        -- NO KEY UPDATE is compatible with an entry's foreign-key KEY SHARE.
        -- Lock first, then aggregate in a fresh READ COMMITTED statement so a
        -- waiter includes the preceding writer's committed changes.
        PERFORM id FROM org_profiles WHERE ids IS NULL OR id = ANY(ids)
          ORDER BY id FOR NO KEY UPDATE;
        UPDATE org_profiles o SET entry_count = v.entry_count,
          avg_quality_score = v.avg_quality_score, tier = v.tier, updated_at = now()
        FROM org_profiles source CROSS JOIN LATERAL wro_org_metric_values(source.id) v
        WHERE o.id = source.id AND (ids IS NULL OR o.id = ANY(ids))
          AND (o.entry_count, o.avg_quality_score, o.tier) IS DISTINCT FROM
              (v.entry_count, v.avg_quality_score, v.tier);
        GET DIAGNOSTICS changed = ROW_COUNT;
        RETURN changed;
      END $body$;

      -- Only the entry trigger runs as the migration owner: restricted entry
      -- writers need no direct UPDATE grant on organization profiles. Resolve
      -- every object in the trusted install schema before temporary objects.
      CREATE OR REPLACE FUNCTION wro_entry_org_metrics() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = ${searchPath} AS $body$
      DECLARE ids integer[];
      BEGIN
        IF TG_OP = 'INSERT' THEN
          SELECT array_agg(DISTINCT org_id) FILTER (WHERE org_id IS NOT NULL) INTO ids FROM new_entries;
        ELSIF TG_OP = 'DELETE' THEN
          SELECT array_agg(DISTINCT org_id) FILTER (WHERE org_id IS NOT NULL) INTO ids FROM old_entries;
        ELSIF TG_OP = 'UPDATE' THEN
          SELECT array_agg(DISTINCT id) FILTER (WHERE id IS NOT NULL) INTO ids FROM (
            SELECT unnest(ARRAY[o.org_id, n.org_id]) id
            FROM old_entries o JOIN new_entries n USING (id)
            WHERE (o.org_id, o.status, o.quality_score) IS DISTINCT FROM
                  (n.org_id, n.status, n.quality_score)
          ) affected;
        ELSE
          PERFORM wro_refresh_org_metrics(); -- TRUNCATE, including maintenance
          RETURN NULL;
        END IF;
        IF ids IS NOT NULL THEN PERFORM wro_refresh_org_metrics(ids); END IF;
        RETURN NULL;
      END $body$;

      REVOKE ALL ON FUNCTION wro_entry_org_metrics() FROM PUBLIC;

      CREATE OR REPLACE TRIGGER wro_org_metrics_guard
        BEFORE INSERT OR UPDATE OF entry_count, avg_quality_score, tier ON org_profiles
        FOR EACH ROW EXECUTE FUNCTION wro_guard_org_metrics();
      CREATE OR REPLACE TRIGGER wro_org_metrics_insert AFTER INSERT ON scan_entries
        REFERENCING NEW TABLE AS new_entries FOR EACH STATEMENT EXECUTE FUNCTION wro_entry_org_metrics();
      CREATE OR REPLACE TRIGGER wro_org_metrics_update AFTER UPDATE ON scan_entries
        REFERENCING OLD TABLE AS old_entries NEW TABLE AS new_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wro_entry_org_metrics();
      CREATE OR REPLACE TRIGGER wro_org_metrics_delete AFTER DELETE ON scan_entries
        REFERENCING OLD TABLE AS old_entries FOR EACH STATEMENT EXECUTE FUNCTION wro_entry_org_metrics();
      CREATE OR REPLACE TRIGGER wro_org_metrics_truncate AFTER TRUNCATE ON scan_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wro_entry_org_metrics();
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
