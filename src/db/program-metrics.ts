import { getPool } from './index';

/** Counts are database invariants, including for direct SQL producers. Identity,
 * exemplars and editorial decisions remain with their existing reviewed paths. */
export async function ensureProgramMetrics(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: [{ schema }] } = await client.query<{ schema: string }>('SELECT current_schema() AS schema');
    const searchPath = `pg_catalog, "${schema.replace(/"/g, '""')}", pg_temp`;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('LOCK TABLE scan_entries, programs IN SHARE ROW EXCLUSIVE MODE');
    await client.query(`
      CREATE OR REPLACE FUNCTION wro_program_metric_values(program integer)
      RETURNS TABLE(entry_count integer, approved_count integer, declined_count integer)
      LANGUAGE sql STABLE SET search_path = ${searchPath} AS $body$
        SELECT count(*)::integer,
          count(*) FILTER (WHERE status = 'approved')::integer,
          count(*) FILTER (WHERE status = 'declined')::integer
        FROM scan_entries WHERE program_id = program
      $body$;

      CREATE OR REPLACE FUNCTION wro_guard_program_metrics() RETURNS trigger
      LANGUAGE plpgsql SET search_path = ${searchPath} AS $body$
      BEGIN
        SELECT v.entry_count, v.approved_count, v.declined_count
          INTO NEW.entry_count, NEW.approved_count, NEW.declined_count
          FROM wro_program_metric_values(NEW.id) v;
        IF TG_OP = 'UPDATE' AND
          (NEW.entry_count, NEW.approved_count, NEW.declined_count) IS DISTINCT FROM
          (OLD.entry_count, OLD.approved_count, OLD.declined_count) THEN
          NEW.updated_at := now();
        END IF;
        RETURN NEW;
      END $body$;

      CREATE OR REPLACE FUNCTION wro_refresh_program_metrics(ids integer[] DEFAULT NULL)
      RETURNS integer LANGUAGE plpgsql SET search_path = ${searchPath} AS $body$
      DECLARE changed integer;
      BEGIN
        -- Match org metrics: compatible with foreign-key locks, deterministic
        -- ordering, and a fresh snapshot after any preceding writer commits.
        PERFORM id FROM programs WHERE ids IS NULL OR id = ANY(ids)
          ORDER BY id FOR NO KEY UPDATE;
        UPDATE programs p SET entry_count = v.entry_count,
          approved_count = v.approved_count, declined_count = v.declined_count,
          updated_at = now()
        FROM programs source CROSS JOIN LATERAL wro_program_metric_values(source.id) v
        WHERE p.id = source.id AND (ids IS NULL OR p.id = ANY(ids))
          AND (p.entry_count, p.approved_count, p.declined_count) IS DISTINCT FROM
              (v.entry_count, v.approved_count, v.declined_count);
        GET DIAGNOSTICS changed = ROW_COUNT;
        RETURN changed;
      END $body$;

      -- Only this trusted trigger has owner privileges. Producers need no new
      -- grants, and caller-created temporary tables cannot shadow real tables.
      CREATE OR REPLACE FUNCTION wro_entry_program_metrics() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = ${searchPath} AS $body$
      DECLARE ids integer[];
      BEGIN
        IF TG_OP = 'INSERT' THEN
          SELECT array_agg(DISTINCT program_id) FILTER (WHERE program_id IS NOT NULL) INTO ids FROM new_entries;
        ELSIF TG_OP = 'DELETE' THEN
          SELECT array_agg(DISTINCT program_id) FILTER (WHERE program_id IS NOT NULL) INTO ids FROM old_entries;
        ELSIF TG_OP = 'UPDATE' THEN
          SELECT array_agg(DISTINCT id) FILTER (WHERE id IS NOT NULL) INTO ids FROM (
            SELECT unnest(ARRAY[o.program_id, n.program_id]) id
            FROM old_entries o JOIN new_entries n USING (id)
            WHERE (o.program_id, o.status) IS DISTINCT FROM (n.program_id, n.status)
          ) affected;
        ELSE
          PERFORM wro_refresh_program_metrics();
          RETURN NULL;
        END IF;
        IF ids IS NOT NULL THEN PERFORM wro_refresh_program_metrics(ids); END IF;
        RETURN NULL;
      END $body$;
      REVOKE ALL ON FUNCTION wro_entry_program_metrics() FROM PUBLIC;

      CREATE OR REPLACE TRIGGER wro_program_metrics_guard
        BEFORE INSERT OR UPDATE OF entry_count, approved_count, declined_count ON programs
        FOR EACH ROW EXECUTE FUNCTION wro_guard_program_metrics();
      CREATE OR REPLACE TRIGGER wro_program_metrics_insert AFTER INSERT ON scan_entries
        REFERENCING NEW TABLE AS new_entries FOR EACH STATEMENT EXECUTE FUNCTION wro_entry_program_metrics();
      CREATE OR REPLACE TRIGGER wro_program_metrics_update AFTER UPDATE ON scan_entries
        REFERENCING OLD TABLE AS old_entries NEW TABLE AS new_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wro_entry_program_metrics();
      CREATE OR REPLACE TRIGGER wro_program_metrics_delete AFTER DELETE ON scan_entries
        REFERENCING OLD TABLE AS old_entries FOR EACH STATEMENT EXECUTE FUNCTION wro_entry_program_metrics();
      CREATE OR REPLACE TRIGGER wro_program_metrics_truncate AFTER TRUNCATE ON scan_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wro_entry_program_metrics();
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
