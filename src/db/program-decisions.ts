import { getPool } from './index';

/** Only a recorded transition is a decision date; general edits are not. */
export function programLastDecisionSql(alias: string): string {
  return `(ARRAY_AGG(${alias}.status || ' ' || (${alias}.decision_at AT TIME ZONE 'UTC')::date
    ORDER BY ${alias}.decision_at DESC, ${alias}.id DESC)
    FILTER (WHERE ${alias}.status IN ('approved', 'declined') AND ${alias}.decision_at IS NOT NULL))[1]`;
}

/** Existing rows intentionally retain unknown dates. Install through migration owner only. */
export async function ensureProgramDecisions(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: [{ schema }] } = await client.query<{ schema: string }>('SELECT current_schema() AS schema');
    const searchPath = `pg_catalog, "${schema.replace(/"/g, '""')}", pg_temp`;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('LOCK TABLE scan_entries, programs IN SHARE ROW EXCLUSIVE MODE');
    await client.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS decision_at timestamptz;
      -- Preserve the old edit-date labels once, separately from reliable dates.
      DO $archive$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='programs'::regclass
          AND attname='legacy_last_decision' AND NOT attisdropped) THEN
          ALTER TABLE programs ADD COLUMN legacy_last_decision text;
          UPDATE programs SET legacy_last_decision=last_decision WHERE last_decision IS NOT NULL;
        END IF;
      END $archive$;
      CREATE OR REPLACE FUNCTION wro_stamp_entry_decision() RETURNS trigger
      LANGUAGE plpgsql SET search_path = ${searchPath} AS $body$
      BEGIN
        IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
          NEW.decision_at := CASE WHEN NEW.status IN ('approved','declined') THEN clock_timestamp() ELSE NULL END;
        ELSE
          NEW.decision_at := OLD.decision_at;
        END IF;
        RETURN NEW;
      END $body$;
      CREATE OR REPLACE TRIGGER wro_entry_decision_stamp
        BEFORE INSERT OR UPDATE OF status, decision_at ON scan_entries
        FOR EACH ROW EXECUTE FUNCTION wro_stamp_entry_decision();

      CREATE OR REPLACE FUNCTION wro_program_decision_value(program integer) RETURNS text
      LANGUAGE sql STABLE SET search_path = ${searchPath} AS $body$
        SELECT ${programLastDecisionSql('e')} FROM scan_entries e WHERE e.program_id=program
      $body$;
      CREATE OR REPLACE FUNCTION wro_guard_program_decision() RETURNS trigger
      LANGUAGE plpgsql SET search_path = ${searchPath} AS $body$
      BEGIN
        NEW.last_decision := wro_program_decision_value(NEW.id);
        IF TG_OP='UPDATE' AND NEW.last_decision IS DISTINCT FROM OLD.last_decision THEN
          NEW.updated_at := now();
        END IF;
        RETURN NEW;
      END $body$;
      CREATE OR REPLACE FUNCTION wro_refresh_program_decisions(ids integer[] DEFAULT NULL)
      RETURNS integer LANGUAGE plpgsql SET search_path = ${searchPath} AS $body$
      DECLARE changed integer;
      BEGIN
        PERFORM id FROM programs WHERE ids IS NULL OR id=ANY(ids) ORDER BY id FOR NO KEY UPDATE;
        UPDATE programs p SET last_decision=wro_program_decision_value(p.id),updated_at=now()
        WHERE (ids IS NULL OR p.id=ANY(ids)) AND p.last_decision IS DISTINCT FROM wro_program_decision_value(p.id);
        GET DIAGNOSTICS changed = ROW_COUNT;
        RETURN changed;
      END $body$;
      CREATE OR REPLACE FUNCTION wro_entry_program_decisions() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = ${searchPath} AS $body$
      DECLARE ids integer[];
      BEGIN
        IF TG_OP='INSERT' THEN
          SELECT array_agg(DISTINCT program_id) FILTER (WHERE program_id IS NOT NULL) INTO ids FROM new_entries;
        ELSIF TG_OP='DELETE' THEN
          SELECT array_agg(DISTINCT program_id) FILTER (WHERE program_id IS NOT NULL) INTO ids FROM old_entries;
        ELSIF TG_OP='UPDATE' THEN
          SELECT array_agg(DISTINCT id) FILTER (WHERE id IS NOT NULL) INTO ids FROM (
            SELECT unnest(ARRAY[o.program_id,n.program_id]) id FROM old_entries o JOIN new_entries n USING(id)
            WHERE (o.program_id,o.status,o.decision_at) IS DISTINCT FROM (n.program_id,n.status,n.decision_at)
          ) affected;
        ELSE
          PERFORM wro_refresh_program_decisions(); RETURN NULL;
        END IF;
        IF ids IS NOT NULL THEN PERFORM wro_refresh_program_decisions(ids); END IF;
        RETURN NULL;
      END $body$;
      REVOKE ALL ON FUNCTION wro_entry_program_decisions() FROM PUBLIC;
      CREATE OR REPLACE TRIGGER wro_program_decision_guard
        BEFORE INSERT OR UPDATE OF last_decision ON programs
        FOR EACH ROW EXECUTE FUNCTION wro_guard_program_decision();
      CREATE OR REPLACE TRIGGER wro_program_decisions_insert AFTER INSERT ON scan_entries
        REFERENCING NEW TABLE AS new_entries FOR EACH STATEMENT EXECUTE FUNCTION wro_entry_program_decisions();
      CREATE OR REPLACE TRIGGER wro_program_decisions_update AFTER UPDATE ON scan_entries
        REFERENCING OLD TABLE AS old_entries NEW TABLE AS new_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wro_entry_program_decisions();
      CREATE OR REPLACE TRIGGER wro_program_decisions_delete AFTER DELETE ON scan_entries
        REFERENCING OLD TABLE AS old_entries FOR EACH STATEMENT EXECUTE FUNCTION wro_entry_program_decisions();
      CREATE OR REPLACE TRIGGER wro_program_decisions_truncate AFTER TRUNCATE ON scan_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wro_entry_program_decisions();
    `);
    await client.query('SELECT wro_refresh_program_decisions()');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
}
