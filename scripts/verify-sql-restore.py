"""Check every public COPY table in a plain pg_dump against an isolated restore."""
import argparse
import json
import os
import re
import subprocess

COPY = re.compile(r'^COPY public\.([a-z_][a-z0-9_]*|"(?:[^"]|"")+") \(.*\) FROM stdin;$')


def copy_counts(lines):
    counts = {}
    current = None
    complete = False
    for line in lines:
        line = line.rstrip('\n')
        if current is not None:
            if line == r'\.':
                current = None
            else:
                counts[current] += 1
        elif line.startswith('COPY '):
            match = COPY.fullmatch(line)
            if not match:
                raise ValueError('Unsupported COPY format; cannot certify backup')
            current = match[1]
            if current in counts:
                raise ValueError('Repeated COPY table')
            counts[current] = 0
        elif line == '-- PostgreSQL database dump complete':
            complete = True
    if current is not None or not complete or not counts:
        raise ValueError('Incomplete or empty PostgreSQL dump')
    return counts


def verify(expected, actual):
    if expected != actual:
        raise ValueError('Restored table inventory or exact row counts differ from the dump')
    for table in ('scan_entries', 'summaries', 'feeds'):
        if expected.get(table, 0) <= 0:
            raise ValueError('Required source table is missing or empty: ' + table)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('dump')
    args = parser.parse_args()
    if os.environ.get('PGHOST') not in ('localhost', '127.0.0.1') or os.environ.get('PGDATABASE') != 'restore_test':
        raise ValueError('Verification is restricted to the disposable restore_test database')
    with open(args.dump, encoding='utf-8') as file:
        expected = copy_counts(file)
    def query(sql):
        return subprocess.check_output(['psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], text=True).strip()
    tables = json.loads(query("SELECT coalesce(json_agg(quote_ident(tablename) ORDER BY tablename),'[]') FROM pg_tables WHERE schemaname='public'"))
    actual = {table: int(query('SELECT count(*) FROM public.' + table)) for table in tables}
    verify(expected, actual)
    if int(query("SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated")):
        raise ValueError('Restored database contains unvalidated constraints')
    print(json.dumps({'tables_verified': len(actual), 'total_rows': sum(actual.values()), 'exact_counts_match': True, 'unvalidated_constraints': 0, 'scope': 'table inventory and rows; credentials and external configuration require separate recovery'}, indent=2))


if __name__ == '__main__':
    main()
